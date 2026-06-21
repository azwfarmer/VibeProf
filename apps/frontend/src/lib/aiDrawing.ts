import type { AiDrawingCommand, Stroke, StrokePoint } from "../features/notes/types";

export const removeAiStrokes = (strokes: Stroke[]) => strokes.filter((stroke) => stroke.source !== "ai");

export const mergeAiStrokes = (strokes: Stroke[], aiStrokes: Stroke[]) => [...strokes, ...aiStrokes.map((stroke) => ({ ...stroke, source: "ai" as const }))];

type AiEraseCommand = Extract<AiDrawingCommand, { type: "erase_ai_region" | "erase_ai_box" }>;
type AiTextEditCommand = Extract<AiDrawingCommand, { type: "erase_ai_text_range" | "replace_ai_text" }>;
export type StrokeBounds = { x: number; y: number; width: number; height: number };
const canvasWidth = 1600;
const canvasHeight = 2200;

const pointInEraseArea = (point: StrokePoint, command: AiEraseCommand) => {
  if (command.type === "erase_ai_box") {
    return (
      point.x >= command.x &&
      point.x <= command.x + command.width &&
      point.y >= command.y &&
      point.y <= command.y + command.height
    );
  }

  const dx = point.x - command.x;
  const dy = point.y - command.y;
  return dx * dx + dy * dy <= command.radius * command.radius;
};

export const getStrokeBounds = (stroke: Stroke): StrokeBounds | null => {
  if (!stroke.text || typeof stroke.x !== "number" || typeof stroke.y !== "number") {
    if (!stroke.points.length) {
      return null;
    }

    const xs = stroke.points.map((point) => point.x);
    const ys = stroke.points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const padding = Math.max(12, stroke.size * 2);

    return {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2
    };
  }

  const fontSize = stroke.fontSize ?? (stroke.textKind === "formula" ? 52 : 38);
  const lines = stroke.text.split(/\n/).slice(0, 4);
  const width = Math.max(...lines.map((line) => line.length), 1) * fontSize * 0.62;
  const height = Math.max(lines.length, 1) * fontSize * 1.18;

  return {
    x: stroke.x,
    y: stroke.y - fontSize,
    width,
    height: height + fontSize * 0.4
  };
};

const boxIntersectsEraseArea = (
  box: { x: number; y: number; width: number; height: number },
  command: AiEraseCommand
) => {
  if (command.type === "erase_ai_box") {
    return !(
      box.x + box.width < command.x ||
      box.x > command.x + command.width ||
      box.y + box.height < command.y ||
      box.y > command.y + command.height
    );
  }

  const closestX = Math.max(box.x, Math.min(command.x, box.x + box.width));
  const closestY = Math.max(box.y, Math.min(command.y, box.y + box.height));
  const dx = command.x - closestX;
  const dy = command.y - closestY;

  return dx * dx + dy * dy <= command.radius * command.radius;
};

const splitPointsAroundEraseArea = (points: StrokePoint[], command: AiEraseCommand) => {
  const segments: StrokePoint[][] = [];
  let current: StrokePoint[] = [];

  points.forEach((point) => {
    if (pointInEraseArea(point, command)) {
      if (current.length >= 2) {
        segments.push(current);
      }
      current = [];
      return;
    }

    current.push(point);
  });

  if (current.length >= 2) {
    segments.push(current);
  }

  return segments;
};

const eraseAiStroke = (stroke: Stroke, command: AiEraseCommand): Stroke[] => {
  if (stroke.source !== "ai") {
    return [stroke];
  }

  const bounds = stroke.text ? getStrokeBounds(stroke) : null;
  if (bounds) {
    return boxIntersectsEraseArea(bounds, command) ? [] : [stroke];
  }

  const segments = splitPointsAroundEraseArea(stroke.points, command);

  if (segments.length === 1 && segments[0].length === stroke.points.length) {
    return [stroke];
  }

  return segments.map((points, index) => ({
    ...stroke,
    id: index === 0 ? stroke.id : `${stroke.id}-part-${index}`,
    points
  }));
};

export const applyAiEraseCommands = (strokes: Stroke[], commands: AiDrawingCommand[]) =>
  commands.reduce((nextStrokes, command) => {
    if (command.type !== "erase_ai_region" && command.type !== "erase_ai_box") {
      return nextStrokes;
    }

    return nextStrokes.flatMap((stroke) => eraseAiStroke(stroke, command));
  }, strokes);

export const hasAiEraseCommands = (commands: AiDrawingCommand[]) =>
  commands.some((command) => command.type === "erase_ai_region" || command.type === "erase_ai_box");

const targetMatchesStroke = (stroke: Stroke, command: AiTextEditCommand) =>
  stroke.id === command.strokeId && (!command.annotationId || stroke.annotationId === command.annotationId);

const editTextStroke = (stroke: Stroke, command: AiTextEditCommand): Stroke | null => {
  if (stroke.source !== "ai" || !stroke.text || !targetMatchesStroke(stroke, command)) {
    return stroke;
  }

  const chars = Array.from(stroke.text);
  const start = Math.min(chars.length, Math.max(0, command.start));
  const end = Math.min(chars.length, Math.max(start, command.end));
  const replacement = command.type === "replace_ai_text" ? Array.from(command.text) : [];
  const nextText = [...chars.slice(0, start), ...replacement, ...chars.slice(end)].join("");

  if (!nextText.trim()) {
    return null;
  }

  return {
    ...stroke,
    text: nextText,
    label: stroke.label === "formula" ? stroke.label : nextText.slice(0, 48)
  };
};

export const applyAiTextEditCommands = (strokes: Stroke[], commands: AiDrawingCommand[]) =>
  commands.reduce((nextStrokes, command) => {
    if (command.type !== "erase_ai_text_range" && command.type !== "replace_ai_text") {
      return nextStrokes;
    }

    return nextStrokes.flatMap((stroke) => {
      const edited = editTextStroke(stroke, command);
      return edited ? [edited] : [];
    });
  }, strokes);

export const hasAiTextEditCommands = (commands: AiDrawingCommand[]) =>
  commands.some((command) => command.type === "erase_ai_text_range" || command.type === "replace_ai_text");

const expandBounds = (bounds: StrokeBounds, padding: number): StrokeBounds => ({
  x: bounds.x - padding,
  y: bounds.y - padding,
  width: bounds.width + padding * 2,
  height: bounds.height + padding * 2
});

const boundsIntersect = (left: StrokeBounds, right: StrokeBounds) =>
  !(
    left.x + left.width < right.x ||
    left.x > right.x + right.width ||
    left.y + left.height < right.y ||
    left.y > right.y + right.height
  );

const clampDelta = (bounds: StrokeBounds, dx: number, dy: number) => {
  const nextX = Math.min(canvasWidth - bounds.width - 24, Math.max(24, bounds.x + dx));
  const nextY = Math.min(canvasHeight - bounds.height - 24, Math.max(24, bounds.y + dy));

  return {
    dx: nextX - bounds.x,
    dy: nextY - bounds.y
  };
};

const moveStroke = (stroke: Stroke, dx: number, dy: number): Stroke => ({
  ...stroke,
  points: stroke.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })),
  x: typeof stroke.x === "number" ? stroke.x + dx : stroke.x,
  y: typeof stroke.y === "number" ? stroke.y + dy : stroke.y
});

const shiftedBounds = (bounds: StrokeBounds, dx: number, dy: number): StrokeBounds => ({
  ...bounds,
  x: bounds.x + dx,
  y: bounds.y + dy
});

const overlapOffsets = [
  { dx: 0, dy: 0 },
  { dx: 0, dy: 86 },
  { dx: 0, dy: 148 },
  { dx: 0, dy: 224 },
  { dx: 140, dy: 0 },
  { dx: 140, dy: 96 },
  { dx: -140, dy: 96 },
  { dx: 220, dy: 0 },
  { dx: -220, dy: 0 },
  { dx: 220, dy: 160 },
  { dx: -220, dy: 160 },
  { dx: 0, dy: -96 },
  { dx: 0, dy: 320 }
];

const OBSTACLE_PAD = 22;
const PLACEMENT_PAD = 18;
const SCAN_STEP = 80;
const FALLBACK_DROP = 420;

const collectObstacleBounds = (strokes: Stroke[]): StrokeBounds[] =>
  strokes
    .map((stroke) => getStrokeBounds(stroke))
    .filter((bounds): bounds is StrokeBounds => Boolean(bounds))
    .map((bounds) => expandBounds(bounds, OBSTACLE_PAD));

const unionBounds = (boundsList: StrokeBounds[]): StrokeBounds | null => {
  if (!boundsList.length) {
    return null;
  }

  const minX = Math.min(...boundsList.map((bounds) => bounds.x));
  const minY = Math.min(...boundsList.map((bounds) => bounds.y));
  const maxX = Math.max(...boundsList.map((bounds) => bounds.x + bounds.width));
  const maxY = Math.max(...boundsList.map((bounds) => bounds.y + bounds.height));

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

// Candidate moves ordered by how little they disturb the model's intended position:
// the curated nearby offsets first, then a distance-sorted grid scan of the whole page so
// a clear spot is always found when one exists.
const candidateDeltas = (bounds: StrokeBounds): Array<{ dx: number; dy: number }> => {
  const preferred = overlapOffsets.map((offset) => clampDelta(bounds, offset.dx, offset.dy));

  const maxX = Math.max(24, canvasWidth - bounds.width - 24);
  const maxY = Math.max(24, canvasHeight - bounds.height - 24);
  const scanned: Array<{ dx: number; dy: number; dist: number }> = [];

  for (let x = 24; x <= maxX; x += SCAN_STEP) {
    for (let y = 24; y <= maxY; y += SCAN_STEP) {
      const dx = x - bounds.x;
      const dy = y - bounds.y;
      scanned.push({ dx, dy, dist: dx * dx + dy * dy });
    }
  }

  scanned.sort((left, right) => left.dist - right.dist);

  return [...preferred, ...scanned.map((entry) => clampDelta(bounds, entry.dx, entry.dy))];
};

const findClearDelta = (bounds: StrokeBounds, obstacles: StrokeBounds[]) =>
  candidateDeltas(bounds).find((delta) => {
    const nextBounds = expandBounds(shiftedBounds(bounds, delta.dx, delta.dy), PLACEMENT_PAD);
    return !obstacles.some((obstacle) => boundsIntersect(obstacle, nextBounds));
  }) ?? null;

// How far below the previous line a stroke may sit and still count as the "next line"
// of the same column, expressed in multiples of the previous line's height.
const LINE_CHAIN_MAX_GAP = 1.9;
// A freshly placed line may sit up to this many line-heights below an existing on-page
// line and still be treated as a continuation of that line's column.
const PAGE_ANCHOR_MAX_GAP = 3;
// How far a drifted line's left edge may be from a column above and still snap back to it.
// Wider than this and we assume the model meant a genuinely separate column, so leave it.
const ALIGN_X_TOLERANCE = 260;

type LineAnchor = { left: number; baseline: number };

// Left edge + baseline of any "line" already on the page. Text uses its own (x, y);
// handwriting uses the left/bottom of its ink so a new line can sit under the strokes.
const lineAnchorPoint = (stroke: Stroke): LineAnchor | null => {
  if (stroke.text && typeof stroke.x === "number" && typeof stroke.y === "number") {
    return { left: stroke.x, baseline: stroke.y };
  }

  if (stroke.points.length) {
    return {
      left: Math.min(...stroke.points.map((point) => point.x)),
      baseline: Math.max(...stroke.points.map((point) => point.y))
    };
  }

  return null;
};

// Lines a new annotation may align under: the student's handwriting and any prior AI text.
// AI positional marks (circles/arrows) are not lines, so they are never anchor targets.
const isLineLike = (stroke: Stroke) =>
  Boolean(stroke.text?.trim()) || (stroke.source !== "ai" && stroke.points.length > 0);

// Left edge of the on-page line directly above `incoming` that it should stack under, or
// null when nothing sits just above it within a next-line gap and a moderate sideways window.
const anchorLeftAbove = (incoming: Stroke & { x: number; y: number }, pageLines: LineAnchor[]): number | null => {
  const fontSize = incoming.fontSize ?? (incoming.textKind === "formula" ? 52 : 38);
  const lineHeight = fontSize * 1.18;

  let bestLeft: number | null = null;
  let bestGap = Infinity;
  pageLines.forEach((line) => {
    const gap = incoming.y - line.baseline; // > 0 means `incoming` is below this line
    if (gap <= 0 || gap > lineHeight * PAGE_ANCHOR_MAX_GAP) {
      return;
    }
    if (Math.abs(incoming.x - line.left) > ALIGN_X_TOLERANCE) {
      return;
    }
    if (gap < bestGap) {
      bestGap = gap;
      bestLeft = line.left;
    }
  });

  return bestLeft;
};

// How each text stroke's left edge was decided, so the placement trace can explain itself.
type AlignSource = "model" | "batch-chain" | "page-anchor";
type AlignTrace = { source: AlignSource; originalX: number; alignedX: number };

// Placement tracing. On by default: logs how each new AI text stroke's top-left corner is
// derived (model coordinate → alignment → obstacle nudge → final corner). Turn it off from
// devtools with `window.__aiPlacementDebug = false`, or from code via setAiPlacementDebug(false).
let placementDebugEnabled = true;
export const setAiPlacementDebug = (enabled: boolean) => {
  placementDebugEnabled = enabled;
};
const placementDebugOn = () => {
  // An explicit devtools override (true or false) wins; otherwise use the module default.
  const override = (globalThis as { __aiPlacementDebug?: boolean }).__aiPlacementDebug;
  return typeof override === "boolean" ? override : placementDebugEnabled;
};

const fontSizeOf = (stroke: Stroke) => stroke.fontSize ?? (stroke.textKind === "formula" ? 52 : 38);

// A text stroke's top-left corner is (x, y - fontSize): drawHandwrittenText anchors at the
// baseline (x, y) and the first line rises one font-size above it. This is the point every
// step below is really choosing.
const cornerText = (x: number, y: number, fontSize: number) =>
  `(${Math.round(x)}, ${Math.round(y - fontSize)})`;

const logTextPlacement = (
  incomingAiStrokes: Stroke[],
  alignment: Map<string, AlignTrace>,
  deltaById: Map<string, { dx: number; dy: number }>,
  usedGroupDelta: boolean,
  fallbackIds: Set<string>
) => {
  const lines = ["[ai-placement] choosing the top-left corner for new AI text:"];

  incomingAiStrokes.forEach((stroke) => {
    const trace = alignment.get(stroke.id);
    if (!trace || typeof stroke.y !== "number") {
      return;
    }

    const fontSize = fontSizeOf(stroke);
    const delta = deltaById.get(stroke.id) ?? { dx: 0, dy: 0 };
    const finalX = trace.alignedX + delta.dx;
    const finalY = stroke.y + delta.dy;

    const alignNote =
      trace.source === "model"
        ? "no line directly above — kept the model's x"
        : `${trace.source === "batch-chain" ? "snapped under the earlier line in this response" : "snapped under the existing line on the page"}: x ${Math.round(trace.originalX)} → ${Math.round(trace.alignedX)} (Δ ${Math.round(trace.alignedX - trace.originalX)})`;

    const overlapNote =
      delta.dx === 0 && delta.dy === 0
        ? "column was clear — no move"
        : usedGroupDelta
          ? `whole batch shifted by (${Math.round(delta.dx)}, ${Math.round(delta.dy)}) to clear obstacles`
          : fallbackIds.has(stroke.id)
            ? `no clear spot — fallback drop (${Math.round(delta.dx)}, ${Math.round(delta.dy)})`
            : `nudged (${Math.round(delta.dx)}, ${Math.round(delta.dy)}) to clear obstacles`;

    lines.push(
      `  ${stroke.textKind ?? "label"} "${(stroke.text ?? "").replace(/\s+/g, " ").slice(0, 28)}" [${stroke.id}] font ${fontSize}px`,
      `    1. model corner    ${cornerText(trace.originalX, stroke.y, fontSize)}`,
      `    2. align left edge ${alignNote}`,
      `    3. obstacle nudge  ${overlapNote}`,
      `    ⇒ FINAL corner     ${cornerText(finalX, finalY, fontSize)}`
    );
  });

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
};

// The model emits each line of an answer as its own write_formula/write_label command and
// tends to drift each successive line's x to the right (or left), producing a diagonal
// staircase even when the space directly below the line above is empty. The overlap pass
// below never corrects this because its first candidate offset is {0,0}, so a clear spot is
// left untouched. Snap each line back under the line above it — whether that line is earlier
// in the same response (an in-batch chain) or already on the page from a prior turn or the
// student's own writing — so successive lines stack straight down. A large vertical jump or a
// far sideways offset starts a fresh column. Obstruction handling in avoidAiAnnotationOverlap
// still relocates the (now column-aligned) block whenever something is genuinely in the way.
// Returns the adjusted strokes plus a per-stroke record of how each left edge was chosen.
const alignTextChain = (
  existingStrokes: Stroke[],
  incomingAiStrokes: Stroke[]
): { strokes: Stroke[]; alignment: Map<string, AlignTrace> } => {
  const alignment = new Map<string, AlignTrace>();
  const textStrokes = incomingAiStrokes
    .filter((stroke): stroke is Stroke & { x: number; y: number } =>
      Boolean(stroke.text) && typeof stroke.x === "number" && typeof stroke.y === "number")
    .sort((left, right) => left.y - right.y);

  if (!textStrokes.length) {
    return { strokes: incomingAiStrokes, alignment };
  }

  const pageLines = existingStrokes
    .filter(isLineLike)
    .map(lineAnchorPoint)
    .filter((anchor): anchor is LineAnchor => Boolean(anchor));

  const alignedX = new Map<string, number>();
  let anchorX: number | null = null;
  let previous: (Stroke & { x: number; y: number }) | null = null;

  textStrokes.forEach((current) => {
    let isContinuation = false;
    if (previous) {
      const fontSize = fontSizeOf(previous);
      const gap = current.y - previous.y;
      isContinuation = gap > 0 && gap <= fontSize * 1.18 * LINE_CHAIN_MAX_GAP;
    }

    if (isContinuation && anchorX !== null) {
      // Next line of the column we are already building: keep it under that left edge.
      alignedX.set(current.id, anchorX);
      alignment.set(current.id, { source: "batch-chain", originalX: current.x, alignedX: anchorX });
    } else {
      // Start of a column: stack it under the line already on the page above it, if any.
      const anchorAbove = anchorLeftAbove(current, pageLines);
      anchorX = anchorAbove ?? current.x;
      if (anchorAbove !== null) {
        alignedX.set(current.id, anchorAbove);
        alignment.set(current.id, { source: "page-anchor", originalX: current.x, alignedX: anchorAbove });
      } else {
        alignment.set(current.id, { source: "model", originalX: current.x, alignedX: current.x });
      }
    }

    previous = current;
  });

  const strokes = alignedX.size
    ? incomingAiStrokes.map((stroke) =>
        alignedX.has(stroke.id) ? { ...stroke, x: alignedX.get(stroke.id)! } : stroke
      )
    : incomingAiStrokes;

  return { strokes, alignment };
};

export const avoidAiAnnotationOverlap = (existingStrokes: Stroke[], incomingAiStrokes: Stroke[]) => {
  // First straighten any diagonal staircase into clean left-aligned columns, then let the
  // overlap logic below only move things that genuinely collide with existing content.
  const { strokes: alignedStrokes, alignment } = alignTextChain(existingStrokes, incomingAiStrokes);

  // Treat BOTH the student's writing and prior AI annotations as obstacles, so new AI
  // labels/formulas are never dropped on top of existing handwriting.
  const obstacles = collectObstacleBounds(existingStrokes);

  // Positional marks (circle/arrow/underline) point at the student's work, so they stay
  // anchored. They still count as obstacles that movable text must avoid.
  const movable = new Map<string, StrokeBounds>();
  alignedStrokes.forEach((stroke) => {
    const bounds = getStrokeBounds(stroke);
    if (bounds && stroke.text) {
      movable.set(stroke.id, bounds);
      return;
    }
    if (bounds) {
      obstacles.push(expandBounds(bounds, PLACEMENT_PAD));
    }
  });

  const deltaById = new Map<string, { dx: number; dy: number }>();
  // Which strokes had no clear spot and were dropped at the fallback offset (for the trace).
  const fallbackIds = new Set<string>();

  // Prefer moving the whole text batch by one shared delta so multi-step formula chains
  // keep their relative layout instead of scattering.
  const groupBounds = unionBounds([...movable.values()]);
  const groupDelta = groupBounds ? findClearDelta(groupBounds, obstacles) : null;

  if (groupDelta) {
    movable.forEach((_bounds, id) => deltaById.set(id, groupDelta));
  } else {
    // Place each text stroke independently, avoiding obstacles and already-placed text.
    movable.forEach((bounds, id) => {
      const clearDelta = findClearDelta(bounds, obstacles);
      const delta = clearDelta ?? clampDelta(bounds, 0, FALLBACK_DROP);
      if (!clearDelta) {
        fallbackIds.add(id);
      }
      deltaById.set(id, delta);
      obstacles.push(expandBounds(shiftedBounds(bounds, delta.dx, delta.dy), PLACEMENT_PAD));
    });
  }

  if (placementDebugOn()) {
    logTextPlacement(incomingAiStrokes, alignment, deltaById, Boolean(groupDelta), fallbackIds);
  }

  return alignedStrokes.map((stroke) => {
    const delta = deltaById.get(stroke.id);
    return delta ? moveStroke(stroke, delta.dx, delta.dy) : stroke;
  });
};
