import { GoogleGenAI, Modality } from "@google/genai";
import { config } from "../config.js";
import { commandsToStrokes, validateCommands } from "./drawingCommands.js";
import type { AiDrawingCommand, ProviderName } from "../types.js";

const supportedOpenAiVoices = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const configuredOpenAiVoice = process.env.OPENAI_REALTIME_VOICE ?? "cedar";
export const openAiVoice = supportedOpenAiVoices.has(configuredOpenAiVoice) ? configuredOpenAiVoice : "cedar";

const coordinate = { type: "number", minimum: 0, maximum: 2200 };
const pointSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: coordinate,
    y: coordinate
  },
  required: ["x", "y"]
};
const colorSchema = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const visibleLabelSchema = {
  type: "string",
  maxLength: 48,
  description: "Short visible handwritten note rendered next to the mark. For mistakes use 2-4 words."
};
const textEditProperties = {
  strokeId: {
    type: "string",
    description: "Exact AI text stroke id from the Current AI annotations context."
  },
  annotationId: {
    type: "string",
    description: "Optional annotation id from the Current AI annotations context."
  },
  start: {
    type: "integer",
    minimum: 0,
    description: "Zero-based inclusive character index from the char map."
  },
  end: {
    type: "integer",
    minimum: 0,
    description: "Zero-based exclusive character index from the char map."
  }
};

const commandToolParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    commands: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["draw_arrow"] },
              from: pointSchema,
              to: pointSchema,
              color: colorSchema,
              label: visibleLabelSchema
            },
            required: ["type", "from", "to"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["circle_region"] },
              x: coordinate,
              y: coordinate,
              radius: { type: "number", minimum: 12, maximum: 420 },
              color: colorSchema,
              label: visibleLabelSchema
            },
            required: ["type", "x", "y", "radius"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["highlight_box"] },
              x: coordinate,
              y: coordinate,
              width: { type: "number", minimum: 12, maximum: 1600 },
              height: { type: "number", minimum: 12, maximum: 2200 },
              color: colorSchema,
              label: visibleLabelSchema
            },
            required: ["type", "x", "y", "width", "height"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["underline"] },
              from: pointSchema,
              to: pointSchema,
              color: colorSchema,
              label: visibleLabelSchema
            },
            required: ["type", "from", "to"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["write_label"] },
              x: coordinate,
              y: coordinate,
              text: { type: "string" },
              color: colorSchema,
              fontSize: { type: "number", minimum: 22, maximum: 86 }
            },
            required: ["type", "x", "y", "text"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["write_formula"] },
              x: coordinate,
              y: coordinate,
              text: { type: "string" },
              color: colorSchema,
              fontSize: { type: "number", minimum: 22, maximum: 86 }
            },
            required: ["type", "x", "y", "text"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["erase_ai_region"] },
              x: coordinate,
              y: coordinate,
              radius: { type: "number", minimum: 8, maximum: 520 }
            },
            required: ["type", "x", "y", "radius"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["erase_ai_box"] },
              x: coordinate,
              y: coordinate,
              width: { type: "number", minimum: 8, maximum: 1600 },
              height: { type: "number", minimum: 8, maximum: 2200 }
            },
            required: ["type", "x", "y", "width", "height"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["erase_ai_text_range"] },
              ...textEditProperties
            },
            required: ["type", "strokeId", "start", "end"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["replace_ai_text"] },
              ...textEditProperties,
              text: { type: "string" }
            },
            required: ["type", "strokeId", "start", "end", "text"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["clear_ai_annotations"] }
            },
            required: ["type"]
          }
        ]
      }
    }
  },
  required: ["commands"]
};

export const realtimeTutorInstructions = `# Role and Objective
You are a realtime Socratic tutor inside a handwritten note-taking app.

# Personality and Tone
- Sound like an engaged human tutor sitting next to the student, not a narrator reading a script.
- Use warm, varied intonation, natural pauses, and light emphasis on important math words.
- Keep the energy alert and encouraging, but do not sound theatrical or sales-like.
- Avoid monotone delivery. Vary sentence length, pacing, and emphasis across turns.
- Default to 1-3 short spoken sentences. Ask one clear question at a time.

# Tutoring Behavior
- Let the student interrupt you; if interrupted, stop and adapt.
- Ask guiding questions before giving full answers unless the student explicitly asks for the answer.
- When drawing helps, call apply_canvas_commands while you speak.
- For low-latency reactions, issue the smallest useful apply_canvas_commands call as early as possible, then continue the spoken explanation. The frontend animates your marks immediately while your audio continues.
- Treat the canvas as the primary teaching surface, not an optional add-on.
- Any response that checks work, explains math, gives a correction, derives a formula, or references a visual location must include canvas writing/marking.
- Do not merely say what you would write. Actually call apply_canvas_commands.
- Do not save canvas writing for the end of your answer. Start with the first useful mark or formula, then speak around it.
- Do not speak a mathematical step that is absent from the canvas. Every equation, correction, or named mistake you discuss must appear as a visible annotation.
- If your spoken explanation has more steps than the current tool call wrote, call apply_canvas_commands again before continuing.
- For multi-step work, write a compact vertical chain with write_formula commands, about 58px apart. Keep each line short.
- Never treat AI annotations as student work.
- You receive periodic student-only canvas snapshots as input_image content. Use those images to inspect handwritten work directly.
- Never ask the student to upload a photo of the page; the current canvas image is already attached in context.
- The canvas snapshot and context you receive are student-only unless explicitly labeled as AI annotations.
- Use formulas and visual marks for math, but keep them concise and placed near the relevant work.
- If the user asks to erase your marks, erase only AI-authored annotations.
- To edit a specific character or substring inside your prior written annotation, use erase_ai_text_range or replace_ai_text with the exact strokeId and zero-based character indexes from the Current AI annotations character map.
- For single-character edits, set start to that character index and end to start+1.
- For whole-word or formula-part edits, set start to the first character index and end to one past the last character index.
- Before writing new labels or formulas, check the current AI annotation context and avoid overlapping your own prior writing. Leave at least 40px of visual space.
- Do not include sound effects, humming, singing, or onomatopoeia.

# Noisy Room Behavior
- Assume the user may be in a noisy hackathon room.
- Ignore background voices, side conversations, random laughter, and partial words unless they clearly address you or refer to the current page.
- If the audio is unclear, ask one short clarifying question instead of answering a background voice.
- Keep finishing your current spoken answer unless the student clearly interrupts you.

# Mistake Marking
- When the student asks you to check work and you identify a mathematical, reasoning, notation, or units mistake, your first tool command must mark the mistake.
- Use circle_region centered on the mistaken handwritten step with color "#be123c".
- Put a short visible note in the circle_region label, 2-4 words max, such as "sign error", "check divide", "missing unit", or "wrong formula".
- The circle label renders visibly next to the circle, so prefer one labeled circle_region over separate circle plus write_label when latency matters.
- If the exact mistake is a long expression, use a red underline with a short label instead.
- Keep the spoken explanation synchronized with the mark: say what you are circling or underlining as the mark appears.
- Do not circle correct work. If no mistake is visible, ask one clarifying question or mark the next useful step in blue.
- Keep mistake responses short: one red mark, one tiny note, and one spoken reason.

# Visual Completion Contract
- Before ending a turn, compare your spoken explanation to the canvas annotations you created.
- If you explained a final answer, final equation, correction, or next step, make sure it is visibly written on the canvas.
- If the canvas only has the first half of your explanation, continue with another apply_canvas_commands call. Do not continue talking only.
- Prefer several small canvas updates over one long speech-only answer.
- Good pattern: mark mistake -> say one sentence -> write corrected step -> say one sentence -> write final simplified result or next question.
- Bad pattern: talk through several algebra steps while only circling one place.

# Canvas Coordinate System
- x ranges from 0 to 1600.
- y ranges from 0 to 2200.
- Use the page context, stroke timeline, and AI annotation summaries to place marks.

# Canvas Tool
- Call apply_canvas_commands with validated drawing commands.
- Supported command types: draw_arrow, circle_region, highlight_box, underline, write_label, write_formula, erase_ai_region, erase_ai_box, erase_ai_text_range, replace_ai_text, clear_ai_annotations.
- You may send up to 16 commands per call when a complete derivation needs multiple visible lines.
- Never say you wrote, erased, or edited canvas annotations unless apply_canvas_commands succeeds.`;

export const openAiRealtimeSessionConfig = () => ({
  type: "realtime",
  model: config.voice.primaryProvider === "openai" ? config.voice.primaryModel : "gpt-realtime-2",
  output_modalities: ["audio"],
  instructions: realtimeTutorInstructions,
  reasoning: {
    effort: "low"
  },
  audio: {
    input: {
      turn_detection: {
        type: "semantic_vad",
        eagerness: "low",
        create_response: true,
        interrupt_response: false
      }
    },
    output: {
      voice: openAiVoice
    }
  },
  tools: [
    {
      type: "function",
      name: "apply_canvas_commands",
      description: "Draw, write formulas, mark mistakes, highlight, or erase only AI-authored annotations on the student's canvas. Use this proactively for every math/checking/explanation step that should be visible while speaking.",
      parameters: commandToolParameters
    }
  ],
  tool_choice: "auto"
});

const truncate = (value: string, max = 900) => value.length > max ? `${value.slice(0, max)}...` : value;

export const createOpenAiRealtimeSession = async (sdp: string) => {
  if (!config.keys.openai) {
    throw new Error("OPENAI_API_KEY/openAI_key is not configured");
  }

  if (!sdp.trim()) {
    throw new Error("Missing WebRTC SDP offer");
  }

  const body = new FormData();
  body.set("sdp", sdp);
  body.set("session", JSON.stringify(openAiRealtimeSessionConfig()));

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.keys.openai}`,
      "OpenAI-Safety-Identifier": "local-hackathon-user"
    },
    body
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI realtime session failed (${response.status}): ${truncate(responseText)}`);
  }

  return responseText;
};

export const createGeminiLiveToken = async () => {
  if (!config.keys.gemini) {
    throw new Error("GEMINI_API_KEY/gemini_key is not configured");
  }

  const client = new GoogleGenAI({ apiKey: config.keys.gemini });
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString();
  const token = await client.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime,
      liveConnectConstraints: {
        model: config.voice.fallbackProvider === "gemini" ? config.voice.fallbackModel : "gemini-3.1-flash-live-preview",
        config: {
          sessionResumption: {},
          temperature: 0.6,
          responseModalities: [Modality.AUDIO]
        }
      },
      httpOptions: {
        apiVersion: "v1alpha"
      }
    }
  });

  return {
    provider: "gemini" as ProviderName,
    model: config.voice.fallbackProvider === "gemini" ? config.voice.fallbackModel : "gemini-3.1-flash-live-preview",
    token: token.name,
    expireTime,
    newSessionExpireTime,
    note: "Gemini Live token is provisioned as fallback. The primary browser voice path uses OpenAI WebRTC."
  };
};

export const applyRealtimeCanvasCommands = (commands: unknown): {
  commands: AiDrawingCommand[];
  aiStrokes: ReturnType<typeof commandsToStrokes>;
} => {
  const validated = validateCommands(commands);
  return {
    commands: validated,
    aiStrokes: commandsToStrokes(validated)
  };
};

export const voiceStatus = () => {
  const openAiAvailable = Boolean(config.keys.openai);
  const geminiAvailable = Boolean(config.keys.gemini);
  const primaryProvider = config.voice.primaryProvider as ProviderName;
  const fallbackProvider = config.voice.fallbackProvider as ProviderName;

  return {
    activeProvider: openAiAvailable ? "openai" : geminiAvailable ? "gemini" : "text-fallback",
    primary: {
      provider: primaryProvider,
      model: config.voice.primaryModel,
      voice: openAiVoice,
      transport: primaryProvider === "openai" ? "webrtc" : "websocket",
      available: primaryProvider === "openai" ? openAiAvailable : geminiAvailable,
      message: primaryProvider === "openai" && openAiAvailable ? "Ready for browser WebRTC" : "Configured as fallback/status only"
    },
    fallback: {
      provider: fallbackProvider,
      model: config.voice.fallbackModel,
      transport: fallbackProvider === "gemini" ? "websocket" : "webrtc",
      available: fallbackProvider === "gemini" ? geminiAvailable : openAiAvailable,
      message: fallbackProvider === "gemini" && geminiAvailable ? "Gemini Live token endpoint available" : "Fallback provider unavailable"
    },
    textFallback: {
      endpoint: "/api/tutor/message",
      available: true
    },
    tools: {
      applyCanvasCommands: true
    }
  };
};
