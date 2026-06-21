import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Download,
  Eraser,
  Hand,
  Highlighter,
  Mic,
  Menu,
  PenLine,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Volume2,
  X
} from "lucide-react";
import { DrawingCanvas, type DrawingCanvasHandle } from "../components/canvas/DrawingCanvas";
import type { AiDrawingCommand, ModelStatus, NotePage, NotesState, Stroke, Tool } from "../features/notes/types";
import { useAutosave } from "../hooks/useAutosave";
import { api } from "../lib/api";
import {
  applyAiEraseCommands,
  applyAiTextEditCommands,
  avoidAiAnnotationOverlap,
  getStrokeBounds,
  hasAiEraseCommands,
  hasAiTextEditCommands,
  mergeAiStrokes,
  removeAiStrokes,
  type StrokeBounds
} from "../lib/aiDrawing";
import {
  createBlankNotebook,
  createBlankPage,
  loadNotes,
  saveNotes,
  timestamp,
  touchNotebook
} from "../lib/storage/notesStorage";

const penColors = ["#111827", "#2563eb", "#be123c", "#15803d", "#7c3aed"];
const highlighterColors = ["#fde047", "#86efac", "#93c5fd", "#f9a8d4"];
type VoiceState = "idle" | "connecting" | "listening" | "speaking" | "thinking" | "failed";

export function App() {
  const [state, setState] = useState<NotesState>(() => loadNotes());
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#111827");
  const [size, setSize] = useState(7);
  const [inputMode, setInputMode] = useState<"pencil" | "hand">("pencil");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [backendReady, setBackendReady] = useState(false);
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [tutorPrompt, setTutorPrompt] = useState("");
  const [tutorStatus, setTutorStatus] = useState("Tutor offline until backend starts");
  const [tutorReply, setTutorReply] = useState("");
  const [tutorOpen, setTutorOpen] = useState(false);
  const [preferPremium, setPreferPremium] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceProvider, setVoiceProvider] = useState("openai");
  const [voiceDetails, setVoiceDetails] = useState("gpt-realtime-2 / cedar");
  const [noiseShieldEnabled, setNoiseShieldEnabled] = useState(true);
  const [micGated, setMicGated] = useState(false);
  const canvasRef = useRef<DrawingCanvasHandle | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const stateRef = useRef(state);
  const aiAnimationTokenRef = useRef(0);
  const aiAnimationTimerRef = useRef<number | null>(null);
  const aiAnimationResolveRef = useRef<(() => void) | null>(null);
  const realtimeContextTimerRef = useRef<number | null>(null);
  const handledRealtimeToolCallsRef = useRef<Set<string>>(new Set());
  const realtimeToolCallNamesRef = useRef<Map<string, string>>(new Map());
  const realtimeToolCallArgsRef = useRef<Map<string, string>>(new Map());
  const currentRealtimeResponseToolCallsRef = useRef(0);
  const currentRealtimeResponseTranscriptRef = useRef("");
  const lastRealtimeVisualNudgeAtRef = useRef(0);
  const lastRealtimeCanvasToolAtRef = useRef(0);
  const noiseShieldEnabledRef = useRef(true);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const persist = useCallback((nextState: NotesState) => {
    saveNotes(nextState);
    if (backendReady) {
      void api.saveState(nextState).catch(() => setBackendReady(false));
    }
  }, [backendReady]);
  useAutosave(state, persist);

  useEffect(() => {
    let cancelled = false;

    const loadBackend = async () => {
      try {
        const [remoteState, modelStatus, voiceStatus] = await Promise.all([api.getState(), api.getModelStatus(), api.getVoiceStatus()]);
        if (cancelled) {
          return;
        }

        const localHasNotes = state.notebooks.some((notebook) => notebook.pages.some((page) => page.strokes.length > 0));
        const remoteHasNotes = remoteState.notebooks.some((notebook) => notebook.pages.some((page) => page.strokes.length > 0));

        if (localHasNotes && !remoteHasNotes) {
          await api.saveState(state);
        } else {
          setState(remoteState);
        }

        setModels(modelStatus.models);
        setVoiceProvider(voiceStatus.activeProvider);
        setVoiceDetails(`${voiceStatus.primary.model} / ${voiceStatus.primary.voice ?? "voice pending"}`);
        setBackendReady(true);
        setTutorStatus("Tutor ready");
      } catch {
        setBackendReady(false);
        setTutorStatus("Start backend on port 8787 for AI tutor");
      }
    };

    void loadBackend();

    return () => {
      cancelled = true;
    };
  }, []);

  const activeNotebook = useMemo(
    () => state.notebooks.find((notebook) => notebook.id === state.activeNotebookId) ?? state.notebooks[0],
    [state.activeNotebookId, state.notebooks]
  );

  const activePage = useMemo(
    () => activeNotebook.pages.find((page) => page.id === state.activePageId) ?? activeNotebook.pages[0],
    [activeNotebook, state.activePageId]
  );

  const updateActivePage = (updater: (page: NotePage) => NotePage) => {
    setState((current) => ({
      ...current,
      notebooks: current.notebooks.map((notebook) => {
        if (notebook.id !== current.activeNotebookId) {
          return notebook;
        }

        return touchNotebook({
          ...notebook,
          pages: notebook.pages.map((page) => (page.id === current.activePageId ? updater(page) : page))
        });
      })
    }));
  };

  const addNotebook = () => {
    const notebook = createBlankNotebook(`Notebook ${state.notebooks.length + 1}`);
    setState((current) => ({
      notebooks: [...current.notebooks, notebook],
      activeNotebookId: notebook.id,
      activePageId: notebook.pages[0].id
    }));
    setSidebarOpen(false);
  };

  const addPage = () => {
    const page = createBlankPage(`Page ${activeNotebook.pages.length + 1}`);
    setState((current) => ({
      ...current,
      notebooks: current.notebooks.map((notebook) =>
        notebook.id === current.activeNotebookId
          ? touchNotebook({ ...notebook, pages: [...notebook.pages, page] })
          : notebook
      ),
      activePageId: page.id
    }));
    setSidebarOpen(false);
  };

  const selectPage = (notebookId: string, pageId: string) => {
    setState((current) => ({
      ...current,
      activeNotebookId: notebookId,
      activePageId: pageId
    }));
    setSidebarOpen(false);
  };

  const changePageTitle = (title: string) => {
    updateActivePage((page) => ({ ...page, title, updatedAt: timestamp() }));
  };

  const changePageStrokes = (pageId: string, strokes: Stroke[]) => {
    setState((current) => ({
      ...current,
      notebooks: current.notebooks.map((notebook) => {
        if (!notebook.pages.some((page) => page.id === pageId)) {
          return notebook;
        }

        return touchNotebook({
          ...notebook,
          pages: notebook.pages.map((page) => (page.id === pageId ? { ...page, strokes, updatedAt: timestamp() } : page))
        });
      })
    }));
  };

  const changeStrokes = (strokes: Stroke[]) => {
    changePageStrokes(activePage.id, strokes);
  };

  const getPageStrokes = (pageId: string) =>
    stateRef.current.notebooks.flatMap((notebook) => notebook.pages).find((page) => page.id === pageId)?.strokes ?? [];

  const cancelAiAnimation = () => {
    aiAnimationTokenRef.current += 1;

    if (aiAnimationTimerRef.current) {
      window.clearTimeout(aiAnimationTimerRef.current);
      aiAnimationTimerRef.current = null;
    }

    aiAnimationResolveRef.current?.();
    aiAnimationResolveRef.current = null;
  };

  const waitForAiAnimation = (ms: number) =>
    new Promise<void>((resolve) => {
      aiAnimationResolveRef.current = resolve;
      aiAnimationTimerRef.current = window.setTimeout(() => {
        aiAnimationTimerRef.current = null;
        aiAnimationResolveRef.current = null;
        resolve();
      }, ms);
    });

  const animateAiStrokes = async (pageId: string, baseStrokes: Stroke[], aiStrokes: Stroke[]) => {
    if (!aiStrokes.length) {
      return;
    }

    cancelAiAnimation();
    const token = aiAnimationTokenRef.current;
    const completed: Stroke[] = [];
    const baseStrokeIds = new Set(baseStrokes.map((stroke) => stroke.id));
    const liveUserAdditions = () =>
      getPageStrokes(pageId).filter((stroke) => stroke.source !== "ai" && !baseStrokeIds.has(stroke.id));

    const render = (partialStroke?: Stroke) => {
      if (aiAnimationTokenRef.current !== token) {
        return false;
      }

      changePageStrokes(pageId, [
        ...baseStrokes,
        ...liveUserAdditions(),
        ...completed,
        ...(partialStroke ? [{ ...partialStroke, source: "ai" as const }] : [])
      ]);
      return true;
    };

    for (const stroke of aiStrokes.map((nextStroke) => ({ ...nextStroke, source: "ai" as const }))) {
      if (aiAnimationTokenRef.current !== token) {
        return;
      }

      if (stroke.text) {
        const fullText = stroke.text;
        const step = fullText.length > 80 ? 2 : 1;

        for (let length = step; length <= fullText.length; length += step) {
          if (!render({ ...stroke, text: fullText.slice(0, length) })) {
            return;
          }
          await waitForAiAnimation(22);
        }
      } else if (stroke.points.length >= 2) {
        const pointStep = Math.max(2, Math.ceil(stroke.points.length / 28));

        for (let end = 2; end <= stroke.points.length; end += pointStep) {
          if (!render({ ...stroke, points: stroke.points.slice(0, Math.min(end, stroke.points.length)) })) {
            return;
          }
          await waitForAiAnimation(18);
        }
      }

      completed.push(stroke);
      if (!render()) {
        return;
      }
      await waitForAiAnimation(45);
    }

    if (aiAnimationTokenRef.current === token) {
      changePageStrokes(pageId, mergeAiStrokes([...baseStrokes, ...liveUserAdditions()], aiStrokes));
    }
  };

  useEffect(() => () => cancelAiAnimation(), []);

  const undoStroke = () => {
    // Delegate to the canvas so undo acts on what is actually on screen (including strokes the
    // student just drew that are still pending a debounced sync) and removes the last user stroke
    // rather than the trailing AI annotation.
    canvasRef.current?.undoLastUserStroke();
  };

  const clearInk = () => {
    changeStrokes([]);
  };

  const clearAiMarks = () => {
    changeStrokes(removeAiStrokes(activePage.strokes));
  };

  const deletePage = () => {
    if (activeNotebook.pages.length === 1) {
      changeStrokes([]);
      changePageTitle("Untitled page");
      return;
    }

    const nextPages = activeNotebook.pages.filter((page) => page.id !== activePage.id);
    setState((current) => ({
      ...current,
      notebooks: current.notebooks.map((notebook) =>
        notebook.id === activeNotebook.id ? touchNotebook({ ...notebook, pages: nextPages }) : notebook
      ),
      activePageId: nextPages[0].id
    }));
  };

  const exportPage = () => {
    const payload = JSON.stringify(activePage, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activePage.title || "note"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const selectTool = (nextTool: Tool) => {
    setTool(nextTool);
    if (nextTool === "highlighter") {
      setColor("#fde047");
      setSize(22);
    }
    if (nextTool === "pen") {
      setColor("#111827");
      setSize(7);
    }
  };

  const colors = tool === "highlighter" ? highlighterColors : penColors;
  const premiumAvailable = models.some((model) => model.role === "premium-tutor" && model.available);
  const primaryTutor = models.find((model) => model.role === "primary-tutor");

  const enableRealtimeAudio = async () => {
    const audio = remoteAudioRef.current;
    if (!audio) {
      return false;
    }

    audio.muted = false;
    audio.volume = 1;
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");

    try {
      await audio.play();
      return true;
    } catch {
      return false;
    }
  };

  const playTutorAudio = async () => {
    if (voiceState !== "idle" && voiceState !== "failed") {
      const enabled = await enableRealtimeAudio();
      setTutorStatus(enabled ? `Realtime audio enabled: ${voiceDetails}` : "Audio is blocked. Tap Voice again or allow microphone/audio.");
      return;
    }

    setTutorStatus("Tap Voice and speak aloud for high-quality realtime audio. Text Check has no voice playback.");
  };

  const setRealtimeMicEnabled = (enabled: boolean) => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    tracks.forEach((track) => {
      track.enabled = enabled;
    });
    setMicGated(tracks.length > 0 && !enabled);
  };

  const setRealtimeVoiceState = (nextState: VoiceState) => {
    setVoiceState(nextState);

    if (!noiseShieldEnabledRef.current) {
      setRealtimeMicEnabled(true);
      return;
    }

    setRealtimeMicEnabled(nextState !== "speaking" && nextState !== "thinking");
  };

  const toggleNoiseShield = () => {
    setNoiseShieldEnabled((current) => {
      const next = !current;
      noiseShieldEnabledRef.current = next;

      if (!next) {
        setRealtimeMicEnabled(true);
        setTutorStatus("Noise Shield off: mic stays live during tutor speech");
        return next;
      }

      setRealtimeMicEnabled(voiceState !== "speaking" && voiceState !== "thinking");
      setTutorStatus("Noise Shield on: room noise will not interrupt tutor speech");
      return next;
    });
  };

  const secureAppUrl = () => `https://${window.location.hostname}:8787/`;

  const applyTutorCanvasResult = (pageId: string, commands: AiDrawingCommand[], aiStrokes: Stroke[]) => {
    const latestPageStrokes = getPageStrokes(pageId);
    const shouldClearAi = commands.some((command) => command.type === "clear_ai_annotations");
    const shouldEraseAiPart = hasAiEraseCommands(commands);
    const shouldEditAiText = hasAiTextEditCommands(commands);
    let baseStrokes = shouldClearAi ? removeAiStrokes(latestPageStrokes) : latestPageStrokes;

    if (shouldEditAiText) {
      baseStrokes = applyAiTextEditCommands(baseStrokes, commands);
    }

    if (shouldEraseAiPart) {
      baseStrokes = applyAiEraseCommands(baseStrokes, commands);
    }

    if (shouldClearAi || shouldEraseAiPart || shouldEditAiText) {
      changePageStrokes(pageId, baseStrokes);
    }

    const adjustedAiStrokes = avoidAiAnnotationOverlap(baseStrokes, aiStrokes);

    if (adjustedAiStrokes.length) {
      void animateAiStrokes(pageId, baseStrokes, adjustedAiStrokes);
    }
  };

  const strokeBounds = (stroke: Stroke) => {
    const bounds = getStrokeBounds(stroke);
    if (!bounds) {
      return "no bounds";
    }

    return `(${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)})`;
  };

  const textCharacterMap = (stroke: Stroke) => {
    if (!stroke.text || typeof stroke.x !== "number" || typeof stroke.y !== "number") {
      return "";
    }

    const fontSize = stroke.fontSize ?? (stroke.textKind === "formula" ? 52 : 38);
    const charWidth = fontSize * 0.62;
    const lineHeight = fontSize * 1.18;
    let line = 0;
    let column = 0;

    return Array.from(stroke.text)
      .slice(0, 120)
      .flatMap((char, index) => {
        if (char === "\n") {
          line += 1;
          column = 0;
          return [`${index}:"\\n"@line-break`];
        }

        const x = stroke.x! + column * charWidth;
        const y = stroke.y! - fontSize + line * lineHeight;
        column += 1;

        return [`${index}:"${char.replace(/"/g, '\\"')}"@(${Math.round(x)},${Math.round(y)},${Math.round(charWidth)},${Math.round(fontSize * 1.25)})`];
      })
      .join(" ");
  };

  const strokeDuration = (stroke: Stroke) => {
    const times = stroke.points
      .map((point) => point.t)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return times.length ? Math.round(Math.max(...times)) : Math.max(0, (stroke.points.length - 1) * 16);
  };

  const freeSpaceZones = (strokes: Stroke[]) => {
    const obstacles = strokes
      .map((stroke) => getStrokeBounds(stroke))
      .filter((bounds): bounds is StrokeBounds => Boolean(bounds));

    if (!obstacles.length) {
      return "Free space map: the page is empty; place new writing anywhere with comfortable margins.";
    }

    const columns = 4;
    const rows = 6;
    const cellWidth = 1600 / columns;
    const cellHeight = 2200 / rows;
    const intersects = (a: StrokeBounds, b: StrokeBounds) =>
      !(a.x + a.width < b.x || a.x > b.x + b.width || a.y + a.height < b.y || a.y > b.y + b.height);
    const free: string[] = [];

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const cell = { x: col * cellWidth, y: row * cellHeight, width: cellWidth, height: cellHeight };
        if (!obstacles.some((bounds) => intersects(bounds, cell))) {
          free.push(
            `x=${Math.round(cell.x)}-${Math.round(cell.x + cellWidth)},y=${Math.round(cell.y)}-${Math.round(cell.y + cellHeight)} center≈(${Math.round(cell.x + cellWidth / 2)},${Math.round(cell.y + cellHeight / 2)})`
          );
        }
      }
    }

    return free.length
      ? `Free space map: open zones to write into (anchor near a center) — ${free.join("; ")}.`
      : "Free space map: no fully clear zone remains; write below the lowest student strokes and avoid the bounds listed above.";
  };

  const buildRealtimeCanvasContext = () => {
    const page = stateRef.current.notebooks
      .flatMap((notebook) => notebook.pages)
      .find((candidate) => candidate.id === activePage.id) ?? activePage;
    const studentStrokes = page.strokes.filter((stroke) => stroke.source !== "ai");
    const aiStrokes = page.strokes.filter((stroke) => stroke.source === "ai");
    const freeSpace = freeSpaceZones(page.strokes);
    const recentStudent = studentStrokes.slice(-14).map((stroke, index) => {
      const sequence = studentStrokes.length - recentStudentCount(studentStrokes) + index + 1;
      return `${sequence}. ${stroke.tool} ${stroke.points.length}pts ${strokeDuration(stroke)}ms bounds=${strokeBounds(stroke)}`;
    });
    const aiSummary = aiStrokes.slice(-10).map((stroke, index) => {
      const label = stroke.text ? `${stroke.textKind ?? "label"}:${stroke.text.slice(0, 60)}` : stroke.label ?? stroke.tool;
      const ids = `strokeId=${stroke.id}${stroke.annotationId ? ` annotationId=${stroke.annotationId}` : ""}`;
      const chars = stroke.text ? ` chars=[${textCharacterMap(stroke)}]` : "";
      return `${index + 1}. ${label} ${ids} bounds=${strokeBounds(stroke)}${chars}`;
    });
    // Readable record of the hints already drawn, kept separate from the erase/edit metadata
    // above. The snapshot is student-only (AI marks stripped), so this is the model's only memory
    // of what it has already written — it must build on these instead of repeating them.
    const priorHints = aiStrokes
      .filter((stroke) => Boolean(stroke.text?.trim()))
      .slice(-12)
      .map((stroke) => `${stroke.textKind === "formula" ? "formula" : "note"} "${stroke.text!.trim().replace(/\s+/g, " ").slice(0, 160)}"`);

    return [
      "Context update only. Do not respond unless the student asks or is speaking.",
      `Active page: ${page.title || "Untitled page"}`,
      "Attached image: latest student-only canvas snapshot. Use it to read handwritten work. Do not ask the student to upload a photo.",
      `Student-only strokes: ${studentStrokes.length}. AI annotations excluded from student work.`,
      recentStudent.length ? `Recent student stroke timeline: ${recentStudent.join("; ")}` : "Recent student stroke timeline: no visible user strokes.",
      priorHints.length
        ? `Hints you have already written on the canvas (your memory of prior hints; the snapshot has them removed, so do not repeat them — build on them and give the next step): ${priorHints.map((hint, index) => `${index + 1}. ${hint}`).join("; ")}`
        : "Hints you have already written on the canvas: none yet — this is your first hint for this page.",
      aiSummary.length ? `Current AI annotations for avoiding overlap, targeted erasing, and exact character edits: ${aiSummary.join("; ")}` : "Current AI annotations: none.",
      freeSpace,
      "When placing canvas commands, use coordinates in x=0..1600 and y=0..2200. Anchor new labels or formulas inside a Free space map open zone and never place them on top of the student's strokes or current AI annotation bounds.",
      "Visual teaching contract: when checking or explaining math, write/mark the key mistake, correction, formulas, and final/next step on the canvas as you speak.",
      "Do not continue with speech-only math if your canvas annotations are incomplete; call apply_canvas_commands again with the remaining visible steps.",
      "To edit your own annotation text, use replace_ai_text or erase_ai_text_range with the exact strokeId and zero-based character indexes from chars=[...]."
    ].join("\n");
  };

  const recentStudentCount = (strokes: Stroke[]) => Math.min(14, strokes.length);

  const needsVisibleMathWork = (text: string) => {
    const normalized = text.toLowerCase();
    return (
      /[=+\-*/^√π∫]/.test(text) ||
      /\b(mistake|error|wrong|correct|correction|step|solve|formula|equation|subtract|add|multiply|divide|factor|simplify|derivative|integral|radius|area|circumference|unit|answer)\b/.test(normalized)
    );
  };

  const sendRealtimeEvent = (event: unknown) => {
    const channel = dataChannelRef.current;
    if (channel?.readyState !== "open") {
      return false;
    }

    try {
      channel.send(JSON.stringify(event));
      return true;
    } catch {
      setTutorStatus("Realtime context send failed; voice is still connected");
      return false;
    }
  };

  const sendRealtimeCanvasContext = () => {
    const snapshot = canvasRef.current?.exportSnapshot({
      includeAi: false,
      format: "jpeg",
      maxWidth: 1200,
      quality: 0.82
    });
    const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> = [
      { type: "input_text", text: buildRealtimeCanvasContext() }
    ];

    if (snapshot) {
      content.push({ type: "input_image", image_url: snapshot });
    }

    const sent = sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content
      }
    });

    if (sent && snapshot) {
      setTutorStatus(`Realtime canvas snapshot sent: ${voiceDetails}`);
    }
  };

  const sendRealtimeToolOutput = (callId: string, output: unknown) => {
    if (!callId) {
      return;
    }

    sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output)
      }
    });
    sendRealtimeEvent({ type: "response.create" });
  };

  const parseRealtimeToolCalls = (event: any) => {
    const calls: Array<{ callId: string; name: string; argumentsText: string }> = [];
    const callIdFrom = (value: any) => value?.call_id ?? value?.callId ?? value?.id ?? "";
    const rememberCall = (callId: string, name?: unknown, argumentsText?: unknown) => {
      if (!callId) {
        return;
      }
      if (typeof name === "string" && name) {
        realtimeToolCallNamesRef.current.set(callId, name);
      }
      if (typeof argumentsText === "string" && argumentsText) {
        realtimeToolCallArgsRef.current.set(callId, argumentsText);
      }
    };

    const item = event?.item;
    if (item?.type === "function_call") {
      const callId = callIdFrom(item);
      rememberCall(callId, item.name, item.arguments);
      if (event?.type === "response.output_item.done" && typeof item.arguments === "string" && item.arguments.trim()) {
        calls.push({
          callId,
          name: item.name ?? realtimeToolCallNamesRef.current.get(callId) ?? "",
          argumentsText: item.arguments
        });
      }
    }

    if (event?.type === "response.function_call_arguments.delta") {
      const callId = callIdFrom(event);
      if (callId && typeof event.delta === "string") {
        const current = realtimeToolCallArgsRef.current.get(callId) ?? "";
        realtimeToolCallArgsRef.current.set(callId, `${current}${event.delta}`);
      }
    }

    if (event?.type === "response.function_call_arguments.done") {
      const callId = callIdFrom(event);
      rememberCall(callId, event.name, event.arguments);
      calls.push({
        callId,
        name: event.name ?? realtimeToolCallNamesRef.current.get(callId) ?? "",
        argumentsText: event.arguments ?? realtimeToolCallArgsRef.current.get(callId) ?? "{}"
      });
    }

    return calls;
  };

  const handleRealtimeToolCall = async (call: { callId: string; name: string; argumentsText: string }) => {
    const dedupeId = call.callId || `${call.name}:${call.argumentsText}`;
    if (handledRealtimeToolCallsRef.current.has(dedupeId)) {
      return;
    }
    handledRealtimeToolCallsRef.current.add(dedupeId);

    if (call.name !== "apply_canvas_commands") {
      sendRealtimeToolOutput(call.callId, { ok: false, error: `Unknown tool ${call.name || "unnamed function"}` });
      return;
    }

    try {
      const parsed = JSON.parse(call.argumentsText || "{}") as { commands?: AiDrawingCommand[] };
      const result = await api.applyRealtimeCanvasCommands(parsed.commands ?? []);
      if (!result.commands.length) {
        sendRealtimeToolOutput(call.callId, {
          ok: false,
          error: "No valid canvas commands were supplied. Retry with a commands array using the supported schema."
        });
        setTutorStatus("Realtime canvas tool rejected an empty or invalid command");
        return;
      }
      applyTutorCanvasResult(stateRef.current.activePageId, result.commands, result.aiStrokes);
      currentRealtimeResponseToolCallsRef.current += result.commands.length;
      lastRealtimeCanvasToolAtRef.current = Date.now();
      sendRealtimeToolOutput(call.callId, {
        ok: true,
        commandsApplied: result.commands.length,
        aiStrokesCreated: result.aiStrokes.length,
        visualContract: "If your spoken explanation has remaining math steps, immediately call apply_canvas_commands again before continuing with speech-only explanation."
      });
      setTutorStatus(`Applied ${result.commands.length} canvas annotation command${result.commands.length === 1 ? "" : "s"}`);
    } catch (error) {
      sendRealtimeToolOutput(call.callId, {
        ok: false,
        error: error instanceof Error ? error.message : "Tool call failed"
      });
    } finally {
      if (call.callId) {
        realtimeToolCallNamesRef.current.delete(call.callId);
        realtimeToolCallArgsRef.current.delete(call.callId);
      }
    }
  };

  const handleRealtimeEvent = (event: MessageEvent) => {
    let payload: any;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === "session.created" || payload.type === "session.updated") {
      const session = payload.session ?? {};
      const model = typeof session.model === "string" ? session.model : "gpt-realtime-2";
      const voice = session.audio?.output?.voice ?? session.voice ?? "voice pending";
      setVoiceDetails(`${model} / ${voice}`);
      setTutorStatus(`Realtime configured: ${model} / ${voice}`);
    }

    if (payload.type === "input_audio_buffer.speech_started") {
      setRealtimeVoiceState("listening");
    }

    if (payload.type === "response.created") {
      currentRealtimeResponseToolCallsRef.current = 0;
      currentRealtimeResponseTranscriptRef.current = "";
      setRealtimeVoiceState("thinking");
    }

    if (payload.type === "response.output_item.added") {
      setRealtimeVoiceState("thinking");
    }

    if (payload.type === "response.audio.delta" || payload.type === "response.output_audio.delta") {
      setRealtimeVoiceState("speaking");
    }

    if (payload.type === "response.done") {
      setRealtimeVoiceState("listening");
      const now = Date.now();
      const transcript = currentRealtimeResponseTranscriptRef.current;
      if (
        currentRealtimeResponseToolCallsRef.current === 0 &&
        now - lastRealtimeCanvasToolAtRef.current > 10000 &&
        needsVisibleMathWork(transcript) &&
        now - lastRealtimeVisualNudgeAtRef.current > 15000
      ) {
        lastRealtimeVisualNudgeAtRef.current = now;
        sendRealtimeEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Canvas protocol correction: your last answer explained math/checking without writing on the canvas. Do not apologize. Immediately call apply_canvas_commands to write or mark the key visual step, then keep any speech to one short sentence."
              }
            ]
          }
        });
        sendRealtimeEvent({ type: "response.create" });
      }
    }

    if (
      (payload.type === "response.audio_transcript.delta" || payload.type === "response.output_audio_transcript.delta") &&
      typeof payload.delta === "string"
    ) {
      currentRealtimeResponseTranscriptRef.current = `${currentRealtimeResponseTranscriptRef.current}${payload.delta}`.slice(-1200);
      setTutorReply((current) => `${current}${payload.delta}`.slice(-900));
    }

    if (
      (payload.type === "response.audio_transcript.done" || payload.type === "response.output_audio_transcript.done") &&
      typeof payload.transcript === "string"
    ) {
      currentRealtimeResponseTranscriptRef.current = payload.transcript;
      setTutorReply(payload.transcript);
    }

    if (payload.type === "conversation.item.input_audio_transcription.completed" && typeof payload.transcript === "string") {
      setTutorPrompt(payload.transcript);
    }

    parseRealtimeToolCalls(payload).forEach((call) => {
      void handleRealtimeToolCall(call);
    });
  };

  const stopRealtimeVoice = (nextState: VoiceState = "idle") => {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

    handledRealtimeToolCallsRef.current.clear();
    realtimeToolCallNamesRef.current.clear();
    realtimeToolCallArgsRef.current.clear();
    currentRealtimeResponseToolCallsRef.current = 0;
    currentRealtimeResponseTranscriptRef.current = "";
    lastRealtimeCanvasToolAtRef.current = 0;
    setMicGated(false);
    setVoiceState(nextState);
    if (nextState === "idle") {
      setTutorStatus("Realtime voice stopped");
    }
  };

  const startRealtimeVoice = async () => {
    if (voiceState !== "idle" && voiceState !== "failed") {
      stopRealtimeVoice();
      return;
    }

    setTutorOpen(true);

    // if (!window.isSecureContext) {
    //   setVoiceState("failed");
    //   setTutorStatus(`Microphone needs a secure context. Open http://localhost:5173 on this machine, or use HTTPS: ${secureAppUrl()}`);
    //   return;
    // }

    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceState("failed");
      setTutorStatus(`Microphone access is unavailable. Confirm HTTPS and mic permission, then reopen ${secureAppUrl()}`);
      return;
    }

    // Do not await anything between the user gesture and getUserMedia below:
    // Safari requires getUserMedia to run within the transient user activation,
    // and an intervening await (e.g. navigator.permissions.query) loses it.
    setVoiceState("connecting");
    setVoiceProvider("openai");
    setTutorReply("");
    setTutorStatus("Connecting realtime voice...");

    try {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.muted = false;
        remoteAudioRef.current.volume = 1;
        remoteAudioRef.current.autoplay = true;
        remoteAudioRef.current.setAttribute("playsinline", "true");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: false },
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
          sampleSize: { ideal: 16 }
        }
      });
      localStreamRef.current = stream;
      setRealtimeMicEnabled(true);

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;

      stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));
      peerConnection.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (remoteAudioRef.current && remoteStream) {
          remoteAudioRef.current.srcObject = remoteStream;
          void enableRealtimeAudio().then((enabled) => {
            if (!enabled) {
              setTutorStatus("Realtime voice ready. Tap the speaker button to enable audio.");
            }
          });
        }
      };
      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        if (state === "connected") {
          setRealtimeVoiceState("listening");
          setTutorStatus("Realtime voice ready");
        }
        if (state === "failed" || state === "disconnected") {
          setRealtimeVoiceState("failed");
          setTutorStatus("Realtime voice disconnected");
        }
      };

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.onopen = () => {
        setRealtimeVoiceState("listening");
        setTutorStatus(`Realtime voice ready: ${voiceDetails}`);
        sendRealtimeCanvasContext();
      };
      dataChannel.onmessage = handleRealtimeEvent;
      dataChannel.onerror = () => {
        setTutorStatus("Realtime voice event channel failed");
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      const answer = await api.createOpenAiRealtimeSession(offer.sdp ?? "");
      await peerConnection.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      stopRealtimeVoice("failed");

      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
        setTutorStatus("Microphone permission was denied. Allow microphone access for this site, then tap Voice again.");
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown realtime voice error";
      setTutorStatus(`OpenAI realtime failed: ${message}`);

      try {
        const gemini = await api.createGeminiLiveSession();
        setVoiceProvider("gemini");
        setTutorStatus(`OpenAI failed. Gemini Live fallback token ready for ${gemini.model}; use text Check if audio does not reconnect.`);
      } catch {
        setTutorStatus(`Realtime voice failed. Text Check is still available.`);
      }
    }
  };

  const askTutor = async (prompt = tutorPrompt || "Check my work and mark the most useful next step.") => {
    const pageId = activePage.id;
    const studentStrokes = activePage.strokes.filter((stroke) => stroke.source !== "ai");
    const existingAiStrokes = activePage.strokes.filter((stroke) => stroke.source === "ai");
    const snapshot = canvasRef.current?.exportSnapshot({ includeAi: false }) ?? undefined;
    setTutorOpen(true);
    setTutorStatus("Tutor thinking...");

    try {
      if (snapshot && backendReady) {
        await api.saveSnapshot(pageId, snapshot);
      }

      const response = await api.sendTutorMessage({
        pageId,
        pageTitle: activePage.title,
        prompt,
        snapshot,
        strokes: studentStrokes,
        aiStrokes: existingAiStrokes,
        preferPremium
      });

      setTutorReply(response.text);
      setTutorStatus(`${response.provider} ${response.model}${response.mode === "mock" ? " demo" : ""}`);
      applyTutorCanvasResult(pageId, response.commands, response.aiStrokes);
      setTutorPrompt("");
    } catch {
      setTutorStatus("Tutor backend unavailable");
    }
  };

  useEffect(() => {
    if (voiceState === "idle" || voiceState === "failed" || dataChannelRef.current?.readyState !== "open") {
      return;
    }

    if (realtimeContextTimerRef.current) {
      window.clearTimeout(realtimeContextTimerRef.current);
    }

    realtimeContextTimerRef.current = window.setTimeout(() => {
      realtimeContextTimerRef.current = null;
      sendRealtimeCanvasContext();
    }, 1600);

    return () => {
      if (realtimeContextTimerRef.current) {
        window.clearTimeout(realtimeContextTimerRef.current);
        realtimeContextTimerRef.current = null;
      }
    };
  }, [activePage.id, activePage.updatedAt, voiceState]);

  useEffect(() => {
    return () => {
      if (realtimeContextTimerRef.current) {
        window.clearTimeout(realtimeContextTimerRef.current);
      }
      dataChannelRef.current?.close();
      peerConnectionRef.current?.close();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <main className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-header">
          <div className="brand">
            <BookOpen size={22} />
            <span>Notes</span>
          </div>
          <button className="icon-button mobile-only" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
            <X size={20} />
          </button>
        </div>

        <button className="primary-action" type="button" onClick={addNotebook}>
          <Plus size={18} />
          New notebook
        </button>

        <div className="notebook-list">
          {state.notebooks.map((notebook) => (
            <section className="notebook-group" key={notebook.id}>
              <div className="notebook-title">{notebook.title}</div>
              {notebook.pages.map((page) => (
                <button
                  className={`page-row ${page.id === activePage.id ? "active" : ""}`}
                  key={page.id}
                  type="button"
                  onClick={() => selectPage(notebook.id, page.id)}
                >
                  <span>{page.title || "Untitled page"}</span>
                  <small>{page.body ? `${page.body.length} chars` : `${page.strokes.length} strokes`}</small>
                </button>
              ))}
            </section>
          ))}
        </div>

        <button className="secondary-action" type="button" onClick={addPage}>
          <Plus size={18} />
          New page
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-only" type="button" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
          <input
            className="title-input"
            value={activePage.title}
            onChange={(event) => changePageTitle(event.target.value)}
            aria-label="Page title"
          />
          <div className="topbar-actions">
            <button className={`icon-button ${preferPremium ? "selected-tool" : ""}`} type="button" onClick={() => setPreferPremium((value) => !value)} aria-label="Toggle premium tutor" disabled={!premiumAvailable}>
              <Sparkles size={20} />
            </button>
            <button className="icon-button" type="button" onClick={exportPage} aria-label="Export page">
              <Download size={20} />
            </button>
            <button className="icon-button danger" type="button" onClick={deletePage} aria-label="Delete page">
              <Trash2 size={20} />
            </button>
          </div>
        </header>

        <div className="toolbars">
          <div className="toolbar segmented" aria-label="Drawing tools">
            <button className={tool === "pen" ? "selected" : ""} type="button" onClick={() => selectTool("pen")} title="Pen">
              <PenLine size={19} />
            </button>
            <button
              className={tool === "highlighter" ? "selected" : ""}
              type="button"
              onClick={() => selectTool("highlighter")}
              title="Highlighter"
            >
              <Highlighter size={19} />
            </button>
            <button className={tool === "eraser" ? "selected" : ""} type="button" onClick={() => setTool("eraser")} title="Eraser">
              <Eraser size={19} />
            </button>
          </div>

          <div className="toolbar color-toolbar" aria-label="Ink colors">
            {colors.map((swatch) => (
              <button
                className={`swatch ${color === swatch ? "selected" : ""}`}
                key={swatch}
                type="button"
                onClick={() => setColor(swatch)}
                style={{ background: swatch }}
                aria-label={`Use ${swatch}`}
              />
            ))}
          </div>

          <label className="size-control">
            <span>Size</span>
            <input min="2" max="34" type="range" value={size} onChange={(event) => setSize(Number(event.target.value))} />
          </label>

          <div className="toolbar segmented" aria-label="Input mode">
            <button className={inputMode === "pencil" ? "selected" : ""} type="button" onClick={() => setInputMode("pencil")} title="Apple Pencil only">
              <PenLine size={19} />
            </button>
            <button className={inputMode === "hand" ? "selected" : ""} type="button" onClick={() => setInputMode("hand")} title="Finger writing">
              <Hand size={19} />
            </button>
          </div>

          <div className="toolbar">
            <button className="icon-button" type="button" onClick={undoStroke} aria-label="Undo stroke">
              <RotateCcw size={19} />
            </button>
            <button className="icon-button" type="button" onClick={clearInk} aria-label="Clear ink">
              <Eraser size={19} />
            </button>
            <button className="icon-button" type="button" onClick={clearAiMarks} aria-label="Clear AI marks">
              <Sparkles size={19} />
            </button>
          </div>
        </div>

        <div className="note-area">
          <div className={`tutor-dock ${tutorOpen ? "open" : "collapsed"}`}>
            <div className="tutor-dock-tab">
              <button
                className="tutor-tab-main"
                type="button"
                onClick={() => setTutorOpen((value) => !value)}
                aria-expanded={tutorOpen}
                aria-label={tutorOpen ? "Collapse tutor" : "Open tutor"}
              >
                <Sparkles size={16} />
                <span>{tutorStatus}</span>
                {tutorOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
              </button>
              <div className="tutor-tab-actions">
                <button type="button" onClick={() => void askTutor()} disabled={!backendReady} aria-label="Check with tutor">
                  Check
                </button>
                <button
                  type="button"
                  className={`voice-button ${voiceState !== "idle" && voiceState !== "failed" ? "listening" : ""}`}
                  onClick={() => void startRealtimeVoice()}
                  disabled={!backendReady}
                  aria-label={voiceState === "idle" || voiceState === "failed" ? "Start realtime voice" : "Stop realtime voice"}
                >
                  <Mic size={17} />
                  <span>{voiceState === "idle" || voiceState === "failed" ? "Voice" : "Live"}</span>
                </button>
                <button
                  type="button"
                  className={`noise-shield-button ${noiseShieldEnabled ? "active" : ""}`}
                  onClick={toggleNoiseShield}
                  aria-label={noiseShieldEnabled ? "Turn Noise Shield off" : "Turn Noise Shield on"}
                  title={noiseShieldEnabled ? "Noise Shield on" : "Noise Shield off"}
                >
                  <ShieldCheck size={17} />
                </button>
              </div>
            </div>
            <section className="tutor-panel" aria-label="AI tutor controls">
              <div className="tutor-actions">
                <input
                  value={tutorPrompt}
                  onChange={(event) => setTutorPrompt(event.target.value)}
                  placeholder="Ask the tutor..."
                  aria-label="Ask the tutor"
                />
                <button type="button" onClick={() => void askTutor()} disabled={!backendReady}>
                  Check
                </button>
                <button
                  type="button"
                  className={`voice-button ${voiceState !== "idle" && voiceState !== "failed" ? "listening" : ""}`}
                  onClick={() => void startRealtimeVoice()}
                  disabled={!backendReady}
                  aria-label={voiceState === "idle" || voiceState === "failed" ? "Start realtime voice" : "Stop realtime voice"}
                  title={voiceState === "idle" || voiceState === "failed" ? "Start realtime voice" : "Stop realtime voice"}
                >
                  <Mic size={17} />
                  <span>{voiceState === "idle" || voiceState === "failed" ? "Voice" : "Live"}</span>
                </button>
                <button
                  type="button"
                  className={`noise-shield-button ${noiseShieldEnabled ? "active" : ""}`}
                  onClick={toggleNoiseShield}
                  aria-label={noiseShieldEnabled ? "Turn Noise Shield off" : "Turn Noise Shield on"}
                  title={noiseShieldEnabled ? "Noise Shield on: prevents room noise from interrupting tutor speech" : "Noise Shield off: mic stays live during tutor speech"}
                >
                  <ShieldCheck size={17} />
                  <span>Shield</span>
                </button>
                <button
                  type="button"
                  onClick={() => void playTutorAudio()}
                  disabled={voiceState === "idle" || voiceState === "failed"}
                  aria-label="Enable live realtime audio"
                  title="Enable live realtime audio"
                >
                  <Volume2 size={17} />
                </button>
                <button type="button" onClick={() => stopRealtimeVoice()} disabled={voiceState === "idle"} aria-label="Stop realtime voice">
                  <X size={17} />
                </button>
              </div>
              <div className="tutor-meta">
                {primaryTutor ? <small>{primaryTutor.model}: {primaryTutor.available ? "available" : primaryTutor.message}</small> : null}
                <small>voice: {voiceProvider} {voiceState} · {voiceDetails}</small>
                <small>{noiseShieldEnabled ? `Noise Shield on${micGated ? ": mic paused during tutor speech" : ""}` : "Noise Shield off"}</small>
              </div>
              {tutorReply ? <p>{tutorReply}</p> : null}
            </section>
          </div>
          <audio ref={remoteAudioRef} autoPlay playsInline />
          <section className="paper-pane" aria-label="Handwritten notes">
            <DrawingCanvas
              ref={canvasRef}
              pageId={activePage.id}
              strokes={activePage.strokes}
              tool={tool}
              color={color}
              size={size}
              inputMode={inputMode}
              onChange={changeStrokes}
            />
          </section>
        </div>
      </section>
    </main>
  );
}
