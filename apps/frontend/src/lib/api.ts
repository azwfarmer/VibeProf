import type { AiDrawingCommand, ModelStatus, NotesState, Stroke, StrokeTimelineEntry } from "../features/notes/types";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? `${window.location.protocol}//${window.location.hostname}:8787`;

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
};

const requestText = async (path: string, init?: RequestInit): Promise<string> => {
  const response = await fetch(`${apiBase}${path}`, init);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response.text();
};

export const api = {
  async getState() {
    return request<NotesState>("/api/state");
  },

  async saveState(state: NotesState) {
    return request<NotesState>("/api/state", {
      method: "PUT",
      body: JSON.stringify(state)
    });
  },

  async saveStrokes(pageId: string, strokes: Stroke[]) {
    return request<NotesState>(`/api/pages/${pageId}/strokes`, {
      method: "PUT",
      body: JSON.stringify({ strokes })
    });
  },

  async saveSnapshot(pageId: string, image: string) {
    return request<{ pageId: string; image: string; createdAt: string }>(`/api/pages/${pageId}/snapshot`, {
      method: "POST",
      body: JSON.stringify({ image })
    });
  },

  async getStrokeTimeline(pageId: string) {
    return request<{ timeline: StrokeTimelineEntry[] }>(`/api/pages/${pageId}/timeline`);
  },

  async createTutorSession(pageId: string) {
    return request<{ id: string; pageId: string; createdAt: string }>("/api/tutor/session", {
      method: "POST",
      body: JSON.stringify({ pageId })
    });
  },

  async createOpenAiRealtimeSession(sdp: string) {
    return requestText("/api/voice/session/openai", {
      method: "POST",
      headers: {
        "content-type": "application/sdp"
      },
      body: sdp
    });
  },

  async createGeminiLiveSession() {
    return request<{
      provider: "gemini";
      model: string;
      token: string;
      expireTime: string;
      newSessionExpireTime: string;
      note: string;
    }>("/api/voice/session/gemini", {
      method: "POST",
      body: JSON.stringify({})
    });
  },

  async applyRealtimeCanvasCommands(commands: AiDrawingCommand[]) {
    return request<{ commands: AiDrawingCommand[]; aiStrokes: Stroke[] }>("/api/voice/tools/apply-canvas-commands", {
      method: "POST",
      body: JSON.stringify({ commands })
    });
  },

  async sendTutorMessage(input: {
    pageId: string;
    pageTitle: string;
    prompt: string;
    snapshot?: string;
    strokes: Stroke[];
    aiStrokes: Stroke[];
    preferPremium?: boolean;
  }) {
    return request<{
      provider: string;
      model: string;
      mode: "real" | "mock";
      text: string;
      commands: AiDrawingCommand[];
      aiStrokes: Stroke[];
    }>("/api/tutor/message", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async getModelStatus() {
    return request<{ models: ModelStatus[]; voice: { implemented: string; realtimeWebSocket: boolean; note: string } }>(
      "/api/models/status"
    );
  },

  async getVoiceStatus() {
    return request<{
      activeProvider: string;
      primary: { provider: string; model: string; voice?: string; transport: string; available: boolean; message: string };
      fallback: { provider: string; model: string; transport: string; available: boolean; message: string };
      textFallback: { endpoint: string; available: boolean };
      tools: { applyCanvasCommands: boolean };
    }>("/api/voice/status");
  }
};
