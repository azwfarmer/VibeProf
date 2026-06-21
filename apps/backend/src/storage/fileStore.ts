import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { createId, now } from "../ids.js";
import type {
  NotePage,
  Notebook,
  NotesState,
  SnapshotRecord,
  StoredData,
  Stroke,
  StrokeTimelineEntry,
  TutorSession
} from "../types.js";

const normalizeStroke = (stroke: Stroke): Stroke => ({
  ...stroke,
  source: stroke.source ?? "user",
  createdAt: stroke.createdAt ?? now(),
  points: (stroke.points ?? []).map((point) => ({
    ...point,
    pressure: Number.isFinite(point.pressure) ? point.pressure : 0.55,
    t: typeof point.t === "number" && Number.isFinite(point.t) ? Math.max(0, Math.round(point.t)) : undefined
  }))
});

const normalizeState = (state: NotesState): NotesState => ({
  ...state,
  notebooks: state.notebooks.map((notebook) => ({
    ...notebook,
    pages: notebook.pages.map((page) => ({
      ...page,
      body: page.body ?? "",
      strokes: page.strokes.map(normalizeStroke)
    }))
  }))
});

const createBlankPage = (title = "First page"): NotePage => {
  const timestamp = now();

  return {
    id: createId(),
    title,
    body: "",
    strokes: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
};

const createInitialState = (): NotesState => {
  const timestamp = now();
  const page = createBlankPage();
  const notebook: Notebook = {
    id: createId(),
    title: "Hackathon notes",
    pages: [page],
    createdAt: timestamp,
    updatedAt: timestamp
  };

  return {
    notebooks: [notebook],
    activeNotebookId: notebook.id,
    activePageId: page.id
  };
};

const createInitialData = (): StoredData => ({
  state: createInitialState(),
  snapshots: {},
  sessions: [],
  strokeTimelines: {}
});

const strokeBounds = (stroke: Stroke) => {
  const points =
    stroke.text && typeof stroke.x === "number" && typeof stroke.y === "number"
      ? [{ x: stroke.x, y: stroke.y }]
      : stroke.points;

  if (!points.length) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY)
  };
};

const strokeDurationMs = (stroke: Stroke) => {
  const pointTimes = stroke.points
    .map((point) => point.t)
    .filter((time): time is number => typeof time === "number" && Number.isFinite(time));

  if (pointTimes.length > 0) {
    return Math.round(Math.max(...pointTimes));
  }

  return Math.max(0, (stroke.points.length - 1) * 16);
};

const addMs = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

const timelineEntryForStroke = (pageId: string, stroke: Stroke, sequence: number): StrokeTimelineEntry => {
  const startedAt = stroke.createdAt ?? now();
  const durationMs = strokeDurationMs(stroke);

  return {
    id: `${pageId}:${stroke.id}`,
    pageId,
    strokeId: stroke.id,
    sequence,
    tool: stroke.tool,
    color: stroke.color,
    size: stroke.size,
    source: "user",
    visible: true,
    startedAt,
    completedAt: addMs(startedAt, durationMs),
    durationMs,
    pointCount: stroke.points.length,
    bounds: strokeBounds(stroke)
  };
};

const deriveTimelineForPage = (pageId: string, strokes: Stroke[]) =>
  strokes
    .filter((stroke) => stroke.source !== "ai")
    .map((stroke, index) => timelineEntryForStroke(pageId, stroke, index + 1));

const mergeTimelineForPage = (
  pageId: string,
  existingTimeline: StrokeTimelineEntry[] | undefined,
  strokes: Stroke[]
): StrokeTimelineEntry[] => {
  const currentEntries = deriveTimelineForPage(pageId, strokes);
  const currentStrokeIds = new Set(currentEntries.map((entry) => entry.strokeId));
  const merged = new Map<string, StrokeTimelineEntry>();

  (existingTimeline ?? []).forEach((entry) => {
    merged.set(entry.strokeId, { ...entry, visible: currentStrokeIds.has(entry.strokeId) });
  });

  currentEntries.forEach((entry) => {
    const existing = merged.get(entry.strokeId);
    merged.set(entry.strokeId, {
      ...entry,
      id: existing?.id ?? entry.id,
      visible: true
    });
  });

  return Array.from(merged.values())
    .sort((left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime())
    .map((entry, index) => ({ ...entry, sequence: index + 1 }));
};

const mergeAllTimelines = (
  state: NotesState,
  existingTimelines: Record<string, StrokeTimelineEntry[]> | undefined
) => {
  const strokeTimelines: Record<string, StrokeTimelineEntry[]> = {};

  state.notebooks.forEach((notebook) => {
    notebook.pages.forEach((page) => {
      strokeTimelines[page.id] = mergeTimelineForPage(page.id, existingTimelines?.[page.id], page.strokes);
    });
  });

  return strokeTimelines;
};

const normalizeData = (data: Partial<StoredData>): StoredData => {
  const state = normalizeState(data.state ?? createInitialState());

  return {
    state,
    snapshots: data.snapshots ?? {},
    sessions: data.sessions ?? [],
    strokeTimelines: mergeAllTimelines(state, data.strokeTimelines)
  };
};

export class FileStore {
  private data: StoredData | null = null;

  async load() {
    if (this.data) {
      return this.data;
    }

    await fs.mkdir(path.dirname(config.dbPath), { recursive: true });

    try {
      const raw = await fs.readFile(config.dbPath, "utf8");
      this.data = normalizeData(JSON.parse(raw) as Partial<StoredData>);
    } catch {
      this.data = createInitialData();
      await this.save();
    }

    return this.data;
  }

  async save() {
    if (!this.data) {
      return;
    }

    await fs.writeFile(config.dbPath, JSON.stringify(this.data, null, 2));
  }

  async getState() {
    return (await this.load()).state;
  }

  async replaceState(state: NotesState) {
    const data = await this.load();
    data.state = normalizeState(state);
    data.strokeTimelines = mergeAllTimelines(data.state, data.strokeTimelines);
    await this.save();
    return data.state;
  }

  async updatePageStrokes(pageId: string, strokes: Stroke[]) {
    const data = await this.load();
    const timestamp = now();

    data.state.notebooks = data.state.notebooks.map((notebook) => ({
      ...notebook,
      updatedAt: notebook.pages.some((page) => page.id === pageId) ? timestamp : notebook.updatedAt,
      pages: notebook.pages.map((page) =>
        page.id === pageId
          ? {
              ...page,
              strokes: strokes.map(normalizeStroke),
              updatedAt: timestamp
            }
          : page
      )
    }));

    data.strokeTimelines[pageId] = mergeTimelineForPage(pageId, data.strokeTimelines[pageId], strokes.map(normalizeStroke));

    await this.save();
    return data.state;
  }

  async getPageTimeline(pageId: string) {
    const data = await this.load();
    return data.strokeTimelines[pageId] ?? [];
  }

  async saveSnapshot(pageId: string, image: string): Promise<SnapshotRecord> {
    const data = await this.load();
    const snapshot = {
      pageId,
      image,
      createdAt: now()
    };

    data.snapshots[pageId] = snapshot;
    await this.save();
    return snapshot;
  }

  async getSnapshot(pageId: string) {
    return (await this.load()).snapshots[pageId] ?? null;
  }

  async createSession(pageId: string): Promise<TutorSession> {
    const data = await this.load();
    const session = {
      id: createId(),
      pageId,
      createdAt: now()
    };

    data.sessions.push(session);
    await this.save();
    return session;
  }
}

export const store = new FileStore();
