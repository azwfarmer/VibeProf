export type ProviderName = "anthropic" | "openai" | "gemini" | "mock";

export type Tool = "pen" | "highlighter" | "eraser";

export type StrokePoint = {
  x: number;
  y: number;
  pressure: number;
  t?: number;
};

export type Stroke = {
  id: string;
  tool: Exclude<Tool, "eraser">;
  color: string;
  size: number;
  points: StrokePoint[];
  source?: "user" | "ai";
  annotationId?: string;
  label?: string;
  createdAt?: string;
  text?: string;
  textKind?: "label" | "formula";
  x?: number;
  y?: number;
  fontSize?: number;
  rotation?: number;
};

export type NotePage = {
  id: string;
  title: string;
  body?: string;
  strokes: Stroke[];
  createdAt: string;
  updatedAt: string;
};

export type Notebook = {
  id: string;
  title: string;
  pages: NotePage[];
  createdAt: string;
  updatedAt: string;
};

export type NotesState = {
  notebooks: Notebook[];
  activeNotebookId: string;
  activePageId: string;
};

export type ModelStatus = {
  id: string;
  provider: ProviderName;
  model: string;
  role: "primary-tutor" | "premium-tutor" | "fallback-tutor" | "primary-voice" | "fallback-voice" | "local-mock";
  capabilities: {
    vision: boolean;
    structuredJson: boolean;
    tools: boolean;
    realtimeAudio: boolean;
  };
  available: boolean;
  lastCheckedAt: string;
  message: string;
};

export type TutorSession = {
  id: string;
  pageId: string;
  createdAt: string;
};

export type AiDrawingCommand =
  | {
      type: "draw_arrow";
      from: { x: number; y: number };
      to: { x: number; y: number };
      color?: string;
      label?: string;
    }
  | {
      type: "circle_region";
      x: number;
      y: number;
      radius: number;
      color?: string;
      label?: string;
    }
  | {
      type: "highlight_box";
      x: number;
      y: number;
      width: number;
      height: number;
      color?: string;
      label?: string;
    }
  | {
      type: "underline";
      from: { x: number; y: number };
      to: { x: number; y: number };
      color?: string;
      label?: string;
    }
  | {
      type: "write_label";
      x: number;
      y: number;
      text: string;
      color?: string;
      fontSize?: number;
    }
  | {
      type: "write_formula";
      x: number;
      y: number;
      text: string;
      color?: string;
      fontSize?: number;
    }
  | {
      type: "erase_ai_region";
      x: number;
      y: number;
      radius: number;
    }
  | {
      type: "erase_ai_box";
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      type: "clear_ai_annotations";
    }
  | {
      type: "erase_ai_text_range";
      strokeId: string;
      annotationId?: string;
      start: number;
      end: number;
    }
  | {
      type: "replace_ai_text";
      strokeId: string;
      annotationId?: string;
      start: number;
      end: number;
      text: string;
    };

export type TutorResponse = {
  provider: ProviderName;
  model: string;
  mode: "real" | "mock";
  text: string;
  commands: AiDrawingCommand[];
};

export type TutorMessageRequest = {
  pageId: string;
  prompt: string;
  snapshot?: string;
  pageTitle?: string;
  strokes?: Stroke[];
  aiStrokes?: Stroke[];
  strokeTimeline?: StrokeTimelineEntry[];
  preferPremium?: boolean;
};

export type SnapshotRecord = {
  pageId: string;
  image: string;
  createdAt: string;
};

export type StoredData = {
  state: NotesState;
  snapshots: Record<string, SnapshotRecord>;
  sessions: TutorSession[];
  strokeTimelines: Record<string, StrokeTimelineEntry[]>;
};

export type StrokeTimelineEntry = {
  id: string;
  pageId: string;
  strokeId: string;
  sequence: number;
  tool: Exclude<Tool, "eraser">;
  color: string;
  size: number;
  source: "user";
  visible: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  pointCount: number;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};
