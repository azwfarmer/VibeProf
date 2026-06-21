import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { Stroke, StrokePoint, Tool } from "../../features/notes/types";
import { createId } from "../../lib/ids";

type DrawingCanvasProps = {
  pageId: string;
  strokes: Stroke[];
  tool: Tool;
  color: string;
  size: number;
  inputMode: "pencil" | "hand";
  onChange: (strokes: Stroke[]) => void;
};

export type DrawingCanvasHandle = {
  exportSnapshot: (options?: { includeAi?: boolean; format?: "png" | "jpeg"; maxWidth?: number; quality?: number }) => string | null;
};

const canvasWidth = 1600;
const canvasHeight = 2200;
const parentSyncDelay = 600;
const minScale = 1;
const maxScale = 4;

const getPoint = (event: PointerEvent, canvas: HTMLCanvasElement, strokeStartedAt?: number): StrokePoint => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvasWidth / rect.width;
  const scaleY = canvasHeight / rect.height;

  const point = {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
    pressure: event.pressure || 0.55
  };

  if (typeof strokeStartedAt !== "number") {
    return point;
  }

  return {
    ...point,
    t: Math.max(0, Math.round(performance.now() - strokeStartedAt))
  };
};

const handwritingFont = (size: number) =>
  `${size}px "Comic Sans MS", "Bradley Hand", "Marker Felt", "Segoe Print", cursive`;

const readScriptGroup = (text: string, start: number) => {
  if (text[start] !== "{") {
    return { value: text[start] ?? "", end: start + 1 };
  }

  let depth = 0;
  let value = "";
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
      if (depth > 1) value += char;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { value, end: index + 1 };
      }
    }
    if (depth > 0) value += char;
  }

  return { value, end: text.length };
};

const drawTextRun = (
  context: CanvasRenderingContext2D,
  content: string,
  x: number,
  y: number,
  size: number,
  color: string
) => {
  let cursor = x;
  const scriptSize = size * 0.62;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (char === "^" || char === "_") {
      const group = readScriptGroup(content, index + 1);
      const scriptY = char === "^" ? y - size * 0.42 : y + size * 0.34;
      context.font = handwritingFont(scriptSize);
      context.fillStyle = color;
      context.fillText(group.value, cursor, scriptY);
      cursor += context.measureText(group.value).width + size * 0.08;
      context.font = handwritingFont(size);
      index = group.end - 1;
      continue;
    }

    context.fillText(char, cursor, y + Math.sin(index * 1.7) * 1.2);
    cursor += context.measureText(char).width + size * 0.015;
  }
};

const drawHandwrittenText = (context: CanvasRenderingContext2D, stroke: Stroke) => {
  if (!stroke.text || typeof stroke.x !== "number" || typeof stroke.y !== "number") {
    return;
  }

  const size = stroke.fontSize ?? (stroke.textKind === "formula" ? 52 : 38);
  const lines = stroke.text.split(/\n/).slice(0, 4);

  context.save();
  context.translate(stroke.x, stroke.y);
  context.rotate(stroke.rotation ?? -0.012);
  context.font = handwritingFont(size);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.fillStyle = stroke.color;
  context.strokeStyle = stroke.color;
  context.globalAlpha = 0.92;

  lines.forEach((line, lineIndex) => {
    drawTextRun(context, line, 0, lineIndex * size * 1.18, size, stroke.color);
  });

  context.restore();
};

const drawStroke = (context: CanvasRenderingContext2D, stroke: Stroke) => {
  if (stroke.text) {
    drawHandwrittenText(context, stroke);
    return;
  }

  if (stroke.points.length < 2) {
    return;
  }

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.globalCompositeOperation = stroke.tool === "highlighter" ? "multiply" : "source-over";
  context.globalAlpha = stroke.tool === "highlighter" ? 0.36 : 1;
  context.strokeStyle = stroke.color;

  context.beginPath();
  context.moveTo(stroke.points[0].x, stroke.points[0].y);

  for (let index = 1; index < stroke.points.length; index += 1) {
    const current = stroke.points[index];
    const previous = stroke.points[index - 1];
    const width = stroke.size * Math.max(0.45, current.pressure);

    context.lineWidth = width;
    context.quadraticCurveTo(previous.x, previous.y, (previous.x + current.x) / 2, (previous.y + current.y) / 2);
  }

  context.stroke();
  context.restore();
};

const drawPage = (context: CanvasRenderingContext2D, nextStrokes: Stroke[]) => {
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  context.strokeStyle = "#e6ded3";
  context.lineWidth = 1;
  for (let y = 96; y < canvasHeight; y += 64) {
    context.beginPath();
    context.moveTo(112, y);
    context.lineTo(canvasWidth - 96, y);
    context.stroke();
  }

  context.strokeStyle = "#e9c9c2";
  context.beginPath();
  context.moveTo(132, 0);
  context.lineTo(132, canvasHeight);
  context.stroke();

  nextStrokes.forEach((stroke) => drawStroke(context, stroke));
};

const eraseAtPoint = (strokes: Stroke[], point: StrokePoint, radius: number) => {
  const radiusSquared = radius * radius;

  return strokes.filter((stroke) => {
    return !stroke.points.some((strokePoint) => {
      const x = strokePoint.x - point.x;
      const y = strokePoint.y - point.y;

      return x * x + y * y < radiusSquared;
    });
  });
};

export const DrawingCanvas = forwardRef<DrawingCanvasHandle, DrawingCanvasProps>(function DrawingCanvas(
  { pageId, strokes, tool, color, size, inputMode, onChange },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeStrokeRef = useRef<Stroke | null>(null);
  const strokesRef = useRef(strokes);
  // User strokes committed locally but not yet echoed back by the parent. The parent syncs on a
  // debounce and the AI tutor streams many strokes-prop updates while it animates a response;
  // without this guard the strokes effect below would overwrite strokesRef before a freshly drawn
  // stroke ever reached the parent, silently erasing the student's writing.
  const pendingUserStrokesRef = useRef<Map<string, Stroke>>(new Map());
  const isDrawingRef = useRef(false);
  const syncTimeoutRef = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const strokeStartedAtRef = useRef<number>(0);
  // Touch pan/zoom + palm-rejection state. Pen strokes are never affected by these.
  const transformRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureSnapshotRef = useRef<{ cx: number; cy: number; dist: number | null } | null>(null);
  const touchModeRef = useRef<"none" | "draw" | "gesture">("none");
  const penActiveRef = useRef(false);
  const viewportRef = useRef<HTMLElement | null>(null);

  const cursorSize = useMemo(() => (tool === "eraser" ? 42 : Math.max(10, size * 2)), [size, tool]);

  useImperativeHandle(ref, () => ({
    exportSnapshot: (options) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        return null;
      }

      const snapshotStrokes = options?.includeAi
        ? strokesRef.current
        : strokesRef.current.filter((stroke) => stroke.source !== "ai");
      drawPage(context, snapshotStrokes);

      if (options?.maxWidth && options.maxWidth > 0 && options.maxWidth < canvasWidth) {
        const scaledCanvas = document.createElement("canvas");
        scaledCanvas.width = Math.round(options.maxWidth);
        scaledCanvas.height = Math.round((canvasHeight / canvasWidth) * options.maxWidth);
        const scaledContext = scaledCanvas.getContext("2d");
        if (!scaledContext) {
          return null;
        }

        scaledContext.drawImage(canvas, 0, 0, scaledCanvas.width, scaledCanvas.height);
        return scaledCanvas.toDataURL(options.format === "jpeg" ? "image/jpeg" : "image/png", options.quality ?? 0.84);
      }

      return canvas.toDataURL(options?.format === "jpeg" ? "image/jpeg" : "image/png", options?.quality ?? 0.9);
    }
  }));

  const redrawCanvas = (nextStrokes: Stroke[]) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    drawPage(context, nextStrokes);
  };

  // Stop tracking pending strokes that no longer exist locally (e.g. the student erased them
  // before the debounced sync flushed), so they are not resurrected by the strokes effect.
  const prunePendingToLocal = (localStrokes: Stroke[]) => {
    if (!pendingUserStrokesRef.current.size) {
      return;
    }

    const ids = new Set(localStrokes.map((stroke) => stroke.id));
    for (const id of [...pendingUserStrokesRef.current.keys()]) {
      if (!ids.has(id)) {
        pendingUserStrokesRef.current.delete(id);
      }
    }
  };

  const scheduleParentSync = (nextStrokes: Stroke[]) => {
    strokesRef.current = nextStrokes;
    prunePendingToLocal(nextStrokes);

    if (syncTimeoutRef.current) {
      window.clearTimeout(syncTimeoutRef.current);
    }

    syncTimeoutRef.current = window.setTimeout(() => {
      if (isDrawingRef.current) {
        scheduleParentSync(strokesRef.current);
        return;
      }

      syncTimeoutRef.current = null;
      onChange(strokesRef.current);
    }, parentSyncDelay);
  };

  useEffect(() => {
    // A new page is a clean slate; never carry another page's unsynced strokes across.
    pendingUserStrokesRef.current.clear();
  }, [pageId]);

  useEffect(() => {
    // Stop tracking strokes the parent has now echoed back to us.
    if (pendingUserStrokesRef.current.size) {
      for (const stroke of strokes) {
        pendingUserStrokesRef.current.delete(stroke.id);
      }
    }

    // Re-attach any locally committed strokes the parent has not acknowledged yet, so a concurrent
    // AI annotation update (which streams in via this same prop) can never drop the student's
    // in-flight writing.
    const pending = [...pendingUserStrokesRef.current.values()];
    const merged = pending.length ? [...strokes, ...pending] : strokes;
    strokesRef.current = merged;
    redrawCanvas(merged);
  }, [strokes]);

  useEffect(() => {
    return () => {
      if (syncTimeoutRef.current) {
        window.clearTimeout(syncTimeoutRef.current);
      }
    };
  }, []);

  const commitStroke = () => {
    const stroke = activeStrokeRef.current;
    activeStrokeRef.current = null;
    isDrawingRef.current = false;
    pointerIdRef.current = null;
    strokeStartedAtRef.current = 0;

    if (!stroke || stroke.points.length < 2) {
      return;
    }

    pendingUserStrokesRef.current.set(stroke.id, stroke);
    scheduleParentSync([...strokesRef.current, stroke]);
  };

  const cancelActiveStroke = () => {
    activeStrokeRef.current = null;
    isDrawingRef.current = false;
    pointerIdRef.current = null;
    strokeStartedAtRef.current = 0;
    redrawCanvas(strokesRef.current);
  };

  const applyTransform = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const { scale, tx, ty } = transformRef.current;
    canvas.style.transformOrigin = "0 0";
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  // Keep the (possibly zoomed) canvas pinned inside the scroll viewport so a pan
  // can never fling the page out of reach. naturalLeft/Top are the canvas layout
  // origin in screen space (its position with an identity transform).
  const clampTransform = (naturalLeft: number, naturalTop: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const transform = transformRef.current;
    transform.scale = Math.min(maxScale, Math.max(minScale, transform.scale));

    const viewport = viewportRef.current ?? (viewportRef.current = canvas.closest(".paper-pane"));
    const bounds = viewport?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    const scaledWidth = canvas.offsetWidth * transform.scale;
    const scaledHeight = canvas.offsetHeight * transform.scale;

    const clampAxis = (value: number, size: number, viewportStart: number, viewportSize: number, naturalStart: number) => {
      if (size <= viewportSize) {
        const low = viewportStart - naturalStart;
        const high = viewportStart + viewportSize - size - naturalStart;
        return Math.min(high, Math.max(low, value));
      }

      const low = viewportStart + viewportSize - size - naturalStart;
      const high = viewportStart - naturalStart;
      return Math.min(high, Math.max(low, value));
    };

    transform.tx = clampAxis(transform.tx, scaledWidth, bounds.left, bounds.width, naturalLeft);
    transform.ty = clampAxis(transform.ty, scaledHeight, bounds.top, bounds.height, naturalTop);
  };

  // Recompute pan/zoom from the live set of touch points. One finger pans; two
  // fingers pan + pinch-zoom around their midpoint. Called on every touch move.
  const updateGesture = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const touches = Array.from(activeTouchesRef.current.values());
    if (touches.length === 0) {
      gestureSnapshotRef.current = null;
      return;
    }

    const cx = touches.reduce((sum, touch) => sum + touch.x, 0) / touches.length;
    const cy = touches.reduce((sum, touch) => sum + touch.y, 0) / touches.length;
    const dist =
      touches.length >= 2 ? Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y) : null;

    const snapshot = gestureSnapshotRef.current;
    if (!snapshot) {
      gestureSnapshotRef.current = { cx, cy, dist };
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const transform = transformRef.current;
    const naturalLeft = rect.left - transform.tx;
    const naturalTop = rect.top - transform.ty;

    let { scale, tx, ty } = transform;

    if (dist && snapshot.dist) {
      const nextScale = scale * (dist / snapshot.dist);
      const localX = (snapshot.cx - naturalLeft - tx) / scale;
      const localY = (snapshot.cy - naturalTop - ty) / scale;
      tx = cx - naturalLeft - nextScale * localX;
      ty = cy - naturalTop - nextScale * localY;
      scale = nextScale;
    } else {
      tx += cx - snapshot.cx;
      ty += cy - snapshot.cy;
    }

    transformRef.current = { scale, tx, ty };
    clampTransform(naturalLeft, naturalTop);
    applyTransform();
    gestureSnapshotRef.current = { cx, cy, dist };
  };

  const startStroke = (point: StrokePoint) => {
    if (tool === "eraser") {
      const nextStrokes = eraseAtPoint(strokesRef.current, point, 52);
      redrawCanvas(nextStrokes);
      scheduleParentSync(nextStrokes);
      isDrawingRef.current = true;
      return;
    }

    activeStrokeRef.current = {
      id: createId(),
      tool,
      color,
      size,
      points: [point],
      source: "user",
      createdAt: new Date().toISOString()
    };
    isDrawingRef.current = true;
  };

  const continueStroke = (point: StrokePoint) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }

    if (tool === "eraser") {
      const nextStrokes = eraseAtPoint(strokesRef.current, point, 52);
      redrawCanvas(nextStrokes);
      scheduleParentSync(nextStrokes);
      return;
    }

    const stroke = activeStrokeRef.current;
    if (!stroke) {
      return;
    }

    stroke.points.push(point);
    drawStroke(context, stroke);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const releaseAllTouches = () => {
      activeTouchesRef.current.forEach((_, id) => {
        try {
          canvas.releasePointerCapture(id);
        } catch {
          // pointer already released
        }
      });
      activeTouchesRef.current.clear();
    };

    // Begin a stroke for a "drawing" pointer (pen, or finger/mouse in hand mode).
    const beginDraw = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      pointerIdRef.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      const strokeStartedAt = performance.now();
      strokeStartedAtRef.current = strokeStartedAt;
      startStroke(getPoint(event, canvas, tool === "eraser" ? undefined : strokeStartedAt));
    };

    const moveDraw = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      continueStroke(getPoint(event, canvas, tool === "eraser" ? undefined : strokeStartedAtRef.current));
    };

    const endDraw = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      commitStroke();
    };

    const handlePointerDown = (event: PointerEvent) => {
      // Apple Pencil always writes, and takes over from any resting palm/touch.
      if (event.pointerType === "pen") {
        penActiveRef.current = true;
        if (touchModeRef.current === "draw") {
          cancelActiveStroke();
        }
        releaseAllTouches();
        touchModeRef.current = "none";
        gestureSnapshotRef.current = null;
        beginDraw(event);
        return;
      }

      // Desktop mouse keeps the old behavior: draws only in finger ("hand") mode.
      if (event.pointerType === "mouse") {
        if (inputMode === "hand") {
          beginDraw(event);
        }
        return;
      }

      if (event.pointerType !== "touch") {
        return;
      }

      // Palm rejection: while the pencil is writing, ignore every touch entirely.
      if (penActiveRef.current) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      canvas.setPointerCapture(event.pointerId);
      activeTouchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (touchModeRef.current === "draw") {
        // A second finger landed mid finger-stroke: abandon the stroke and pinch instead.
        cancelActiveStroke();
        touchModeRef.current = "gesture";
        gestureSnapshotRef.current = null;
        return;
      }

      if (touchModeRef.current === "gesture") {
        // Re-anchor so adding a finger does not jump the view.
        gestureSnapshotRef.current = null;
        return;
      }

      // First finger down. In hand mode it writes; otherwise it pans/zooms.
      if (inputMode === "hand") {
        touchModeRef.current = "draw";
        beginDraw(event);
      } else {
        touchModeRef.current = "gesture";
        gestureSnapshotRef.current = null;
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "pen" || event.pointerType === "mouse") {
        if (pointerIdRef.current !== event.pointerId || !isDrawingRef.current) {
          return;
        }
        moveDraw(event);
        return;
      }

      if (event.pointerType !== "touch" || !activeTouchesRef.current.has(event.pointerId)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      activeTouchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (touchModeRef.current === "draw" && pointerIdRef.current === event.pointerId) {
        if (isDrawingRef.current) {
          moveDraw(event);
        }
        return;
      }

      if (touchModeRef.current === "gesture") {
        updateGesture();
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerType === "pen") {
        if (pointerIdRef.current === event.pointerId) {
          endDraw(event);
        }
        penActiveRef.current = false;
        return;
      }

      if (event.pointerType === "mouse") {
        if (pointerIdRef.current === event.pointerId) {
          endDraw(event);
        }
        return;
      }

      if (event.pointerType !== "touch") {
        return;
      }

      const wasTracked = activeTouchesRef.current.delete(event.pointerId);
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // pointer already released
      }
      if (!wasTracked) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (touchModeRef.current === "draw" && pointerIdRef.current === event.pointerId) {
        commitStroke();
        touchModeRef.current = activeTouchesRef.current.size > 0 ? "gesture" : "none";
        gestureSnapshotRef.current = null;
        return;
      }

      if (touchModeRef.current === "gesture") {
        // Re-anchor on the remaining finger(s); end the gesture when none are left.
        touchModeRef.current = activeTouchesRef.current.size > 0 ? "gesture" : "none";
        gestureSnapshotRef.current = null;
      }
    };

    const preventTouchGestures = (event: TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerUp);
    canvas.addEventListener("touchstart", preventTouchGestures, { passive: false });
    canvas.addEventListener("touchmove", preventTouchGestures, { passive: false });
    canvas.addEventListener("touchend", preventTouchGestures, { passive: false });
    canvas.addEventListener("touchcancel", preventTouchGestures, { passive: false });

    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerUp);
      canvas.removeEventListener("touchstart", preventTouchGestures);
      canvas.removeEventListener("touchmove", preventTouchGestures);
      canvas.removeEventListener("touchend", preventTouchGestures);
      canvas.removeEventListener("touchcancel", preventTouchGestures);
    };
  }, [color, inputMode, size, tool]);

  return (
    <div className="canvas-shell" style={{ "--cursor-size": `${cursorSize}px` } as React.CSSProperties}>
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={canvasHeight}
        className="drawing-canvas"
        style={{ transformOrigin: "0 0", willChange: "transform" }}
        onContextMenu={(event) => event.preventDefault()}
        onDragStart={(event) => event.preventDefault()}
      />
    </div>
  );
});
