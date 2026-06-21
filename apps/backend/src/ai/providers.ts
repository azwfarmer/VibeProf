import { config } from "../config.js";
import { selectTutorModel } from "./modelRegistry.js";
import { validateCommands, resolveStrokeReferences } from "./drawingCommands.js";
import type { ProviderName, Stroke, TutorMessageRequest, TutorResponse } from "../types.js";

const systemPrompt = `You are a concise Socratic tutor looking at a student's handwritten notes.
The attached image is a STUDENT-ONLY snapshot. Prior AI annotations are intentionally removed before the image is sent.
The stroke metadata, when present, also contains only student-authored strokes. Do not infer that previous AI highlights, arrows, labels, or circles were written by the student.
You may write directly on the canvas when it helps teaching. Use write_formula for equations, derivations, identities, and heavy math notation.
For formulas, prefer readable Unicode/math text with ^ and _ scripts, such as A=πr^2, C=2πr, ∫_0^1 x^2 dx=1/3, or x=(-b±√(b^2-4ac))/(2a).
Do not refuse to write math; write concise formulas or partial next steps when the user asks.
If the user asks you to clear all of your own marks/annotations/strokes, include clear_ai_annotations in commands. That command removes only AI-authored strokes.
If the user asks you to erase only part of your own annotation, use erase_ai_region or erase_ai_box around that specific AI mark. Never erase student strokes.
If the user asks you to edit a specific character or substring in your own written annotation, use erase_ai_text_range or replace_ai_text with the exact strokeId and zero-based character indexes from Current AI annotations.
Current AI annotation metadata, when present, describes your previous marks only. Use it for targeted erasing, not as student work.
The "Hints already written on the canvas" list and the Current AI annotations are your memory of what you have already drawn. The snapshot you see has your own marks removed, so this text is the ONLY record of your prior hints. Read it before answering: build on those hints, never repeat or restate one that is already written there, and advance to the next step or a more specific hint. When the student asks for "another hint", "more", or "the next step", give one that goes beyond everything already on the canvas.
Before adding a new write_label or write_formula command, pick coordinates inside one of the Free space map open zones (anchor near a listed center) and clear of BOTH the student's strokes and your prior AI annotation bounds. Never write on top of the student's handwriting. Leave at least 40px from your own prior writing and at least 30px from any student stroke bounds; if no open zone fits, write below the lowest student strokes.
The temporal stroke timeline is ordered oldest to newest and describes student thought process: where strokes were written, how long they took, and which strokes are still visible. The leading number on each timeline entry (e.g. "7. pen ...") is that stroke's sequence number — use it with circle_stroke to mark a specific student stroke.
Treat the canvas as the primary teaching surface, not an optional add-on:
- Any response that checks work, explains math, gives a correction, derives a formula, or references a visual location must include canvas writing/marking.
- Do not merely say what you would write. Include drawing commands.
- Do not give a multi-step spoken explanation while only writing the first half. Every equation, correction, or named mistake in the text response must appear as a visible annotation.
- For multi-step work, use multiple write_formula commands in a compact vertical chain, about 58px apart. Keep each line short.
- Before finishing, make sure the final answer, correction, or next step you mention is visibly written on the canvas.
Underline mistakes by default: whenever you notice a mathematical, reasoning, or notation error in the student's handwriting — even if they did not explicitly ask you to check the work — mark it directly on the canvas before anything else. Do not wait to be asked.
When you identify such a mistake, the first command must underline it directly on the canvas:
- Use the underline command in red ("#be123c") drawn directly beneath the mistaken work.
- The underline MUST be strictly horizontal: "from" and "to" must have the SAME y value (from.y === to.y). Never produce a slanted or angled underline.
- Do NOT attach any label or extra text to the underline. Leave the label empty — the red underline alone marks the error, with no words.
- Do not underline correct work. If the work is correct, write no red underline.
- Keep mistake-marking to one red underline and at most one extra formula or arrow.
Make the text response explain the same marked mistake in one or two short sentences.
Return JSON only with this shape:
{"text":"spoken tutoring response","commands":[drawing commands]}
Use up to ten useful new annotations when needed to finish the visible explanation. Valid commands are draw_arrow, circle_stroke, circle_region, highlight_box, underline, write_label, write_formula, erase_ai_region, erase_ai_box, erase_ai_text_range, replace_ai_text, clear_ai_annotations.`;

const fallbackCommands = [
  { type: "circle_region", x: 520, y: 520, radius: 90, color: "#be123c", label: "check step" }
];

const mockTutor = (request: TutorMessageRequest, model = "local-tutor-demo"): TutorResponse => ({
  provider: "mock",
  model,
  mode: "mock",
  text: request.prompt.trim()
    ? `I can help with "${request.prompt.trim()}". I marked the area to inspect first and the next step direction.`
    : "I marked the area to inspect first and where the next step should go.",
  commands: validateCommands(fallbackCommands)
});

const extractJson = (text: string) => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]) as { text?: unknown; commands?: unknown };
  } catch {
    return null;
  }
};

const isClearAllAnnotationsRequest = (prompt: string) => {
  const normalized = prompt.toLowerCase();

  if (/\b(only|part|piece|section|region|box|formula|equation|label|arrow|circle|highlight|underline|this|that)\b/.test(normalized)) {
    return false;
  }

  return (
    /\b(clear|remove|erase|delete|hide)\b/.test(normalized) &&
    /\b(all|everything|whole|entire|your|ai|annotation|annotations|mark|marks|stroke|strokes|writing)\b/.test(normalized)
  );
};

const strokeSummary = (request: TutorMessageRequest) => {
  const studentStrokes = request.strokes?.filter((stroke) => stroke.source !== "ai") ?? [];
  const penCount = studentStrokes.filter((stroke) => stroke.tool === "pen").length;
  const highlighterCount = studentStrokes.filter((stroke) => stroke.tool === "highlighter").length;

  return `Student stroke summary: ${studentStrokes.length} total, ${penCount} pen, ${highlighterCount} highlighter. AI annotation strokes are excluded.`;
};

const canvasWidth = 1600;
const canvasHeight = 2200;

type NumericBounds = { x: number; y: number; width: number; height: number };

const numericBoundsForStroke = (stroke: Stroke): NumericBounds | null => {
  if (stroke.text && typeof stroke.x === "number" && typeof stroke.y === "number") {
    const fontSize = stroke.fontSize ?? (stroke.textKind === "formula" ? 52 : 38);
    const lines = stroke.text.split(/\n/).slice(0, 4);
    const width = Math.max(...lines.map((line) => line.length), 1) * fontSize * 0.62;
    const height = Math.max(lines.length, 1) * fontSize * 1.18 + fontSize * 0.4;

    return { x: stroke.x, y: stroke.y - fontSize, width, height };
  }

  const points = stroke.points;

  if (!points.length) {
    return null;
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

const boundsForStroke = (stroke: Stroke) => {
  const bounds = numericBoundsForStroke(stroke);
  if (!bounds) {
    return null;
  }

  return `x=${Math.round(bounds.x)}, y=${Math.round(bounds.y)}, w=${Math.round(bounds.width)}, h=${Math.round(bounds.height)}`;
};

const rectsIntersect = (a: NumericBounds, b: NumericBounds) =>
  !(a.x + a.width < b.x || a.x > b.x + b.width || a.y + a.height < b.y || a.y > b.y + b.height);

// Coarse occupancy grid: report which page cells are clear of every student and AI stroke,
// giving the model concrete safe coordinates to aim its writing at.
const freeSpaceSummary = (request: TutorMessageRequest) => {
  const studentStrokes = request.strokes?.filter((stroke) => stroke.source !== "ai") ?? [];
  const aiStrokes = request.aiStrokes?.filter((stroke) => stroke.source === "ai") ?? [];
  const obstacles = [...studentStrokes, ...aiStrokes]
    .map(numericBoundsForStroke)
    .filter((bounds): bounds is NumericBounds => Boolean(bounds));

  if (!obstacles.length) {
    return "Free space map: the page is empty. Place new writing anywhere with comfortable margins.";
  }

  const columns = 4;
  const rows = 6;
  const cellWidth = canvasWidth / columns;
  const cellHeight = canvasHeight / rows;
  const free: string[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const cell: NumericBounds = { x: col * cellWidth, y: row * cellHeight, width: cellWidth, height: cellHeight };
      if (!obstacles.some((bounds) => rectsIntersect(bounds, cell))) {
        const centerX = Math.round(cell.x + cellWidth / 2);
        const centerY = Math.round(cell.y + cellHeight / 2);
        free.push(`x=${Math.round(cell.x)}-${Math.round(cell.x + cellWidth)},y=${Math.round(cell.y)}-${Math.round(cell.y + cellHeight)} center≈(${centerX},${centerY})`);
      }
    }
  }

  if (!free.length) {
    return "Free space map: no fully clear zone remains. Write below the lowest student strokes and stay clear of the bounds listed above.";
  }

  return `Free space map: open zones to write into (anchor near a center) — ${free.join("; ")}.`;
};

const characterSummaryForStroke = (stroke: Stroke) => {
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

const strokeTimelineSummary = (request: TutorMessageRequest) => {
  const timeline = request.strokeTimeline ?? [];

  if (!timeline.length) {
    return "Student temporal stroke timeline: not available yet.";
  }

  const visible = timeline.filter((entry) => entry.visible);
  const erasedCount = timeline.length - visible.length;
  const recent = visible.slice(-14).map((entry) => {
    const bounds = `(${entry.bounds.x},${entry.bounds.y},${entry.bounds.width},${entry.bounds.height})`;
    return `${entry.sequence}. ${entry.tool} ${entry.pointCount}pts ${entry.durationMs}ms bounds=${bounds}`;
  });

  return [
    `Student temporal stroke timeline: ${visible.length} visible user strokes, ${erasedCount} erased/hidden historical user strokes.`,
    recent.length ? `Recent visible sequence: ${recent.join("; ")}` : "No visible user strokes remain."
  ].join("\n");
};

const aiAnnotationSummary = (request: TutorMessageRequest) => {
  const aiStrokes = request.aiStrokes?.filter((stroke) => stroke.source === "ai") ?? [];

  if (!aiStrokes.length) {
    return "Current AI annotations: none.";
  }

  const summarized = aiStrokes.slice(-16).map((stroke, index) => {
    const kind = stroke.text ? `${stroke.textKind ?? "label"} "${stroke.text.slice(0, 64)}"` : stroke.label ?? stroke.tool;
    const bounds = boundsForStroke(stroke) ?? "no drawable bounds";
    const ids = `strokeId=${stroke.id}${stroke.annotationId ? ` annotationId=${stroke.annotationId}` : ""}`;
    const chars = stroke.text ? ` chars=[${characterSummaryForStroke(stroke)}]` : "";
    return `${index + 1}. ${kind} ${ids} at ${bounds}${chars}`;
  });

  return `Current AI annotations, for targeted erasing, avoiding overlap, and exact character edits only: ${summarized.join("; ")}`;
};

// Plain-language record of the hints the tutor has already written, kept separate from the
// erase/edit metadata above. The snapshot is student-only (AI marks are stripped before it is
// sent), so this list is the model's only memory of what it has already drawn — it uses it to
// keep teaching continuity instead of repeating hints the student can already see on the page.
const priorHintSummary = (request: TutorMessageRequest) => {
  const hints = (request.aiStrokes ?? [])
    .filter((stroke) => stroke.source === "ai" && Boolean(stroke.text?.trim()))
    .slice(-16)
    .map((stroke) => `${stroke.textKind === "formula" ? "formula" : "note"} "${stroke.text!.trim().replace(/\s+/g, " ").slice(0, 160)}"`);

  if (!hints.length) {
    return "Hints already written on the canvas: none yet — this is your first hint for this page.";
  }

  return `Hints already written on the canvas (your memory of prior hints; the snapshot has them removed, so do not repeat them — build on them and give the next step): ${hints
    .map((hint, index) => `${index + 1}. ${hint}`)
    .join("; ")}`;
};

const requestContext = (request: TutorMessageRequest) =>
  [
    `Page: ${request.pageTitle ?? "Untitled"}`,
    strokeSummary(request),
    strokeTimelineSummary(request),
    priorHintSummary(request),
    aiAnnotationSummary(request),
    freeSpaceSummary(request),
    `User: ${request.prompt}`
  ].join("\n");

const callAnthropic = async (request: TutorMessageRequest, model: string): Promise<TutorResponse> => {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: `${systemPrompt}\n\n${requestContext(request)}` }
  ];

  if (request.snapshot) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: request.snapshot.startsWith("data:image/jpeg") ? "image/jpeg" : "image/png",
        data: request.snapshot.replace(/^data:image\/\w+;base64,/, "")
      }
    });
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.keys.anthropic,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      messages: [{ role: "user", content }]
    })
  });

  if (!response.ok) throw new Error(`Anthropic request failed: ${response.status}`);
  const json = await response.json() as { content?: Array<{ text?: string }> };
  const parsed = extractJson(json.content?.map((item) => item.text ?? "").join("\n") ?? "");

  return {
    provider: "anthropic",
    model,
    mode: "real",
    text: typeof parsed?.text === "string" ? parsed.text : "I reviewed the page and marked the most useful next step.",
    commands: validateCommands(parsed?.commands)
  };
};

const callOpenAi = async (request: TutorMessageRequest, model: string): Promise<TutorResponse> => {
  const input: Array<Record<string, unknown>> = [
    {
      role: "user",
      content: [
        { type: "input_text", text: `${systemPrompt}\n\n${requestContext(request)}` },
        ...(request.snapshot ? [{ type: "input_image", image_url: request.snapshot }] : [])
      ]
    }
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.keys.openai}`
    },
    body: JSON.stringify({ model, input })
  });

  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status}`);
  const json = await response.json() as { output_text?: string };
  const parsed = extractJson(json.output_text ?? "");

  return {
    provider: "openai",
    model,
    mode: "real",
    text: typeof parsed?.text === "string" ? parsed.text : "I reviewed the page and marked the most useful next step.",
    commands: validateCommands(parsed?.commands)
  };
};

export const getTutorResponse = async (request: TutorMessageRequest): Promise<TutorResponse> => {
  const selected = selectTutorModel(request.preferPremium);

  if (isClearAllAnnotationsRequest(request.prompt)) {
    return {
      provider: selected.provider,
      model: selected.model,
      mode: "real",
      text: "Cleared my annotations. Your own writing is untouched.",
      commands: [{ type: "clear_ai_annotations" }]
    };
  }

  let response: TutorResponse | null = null;

  try {
    if (selected.provider === "anthropic") {
      response = await callAnthropic(request, selected.model);
    } else if (selected.provider === "openai") {
      response = await callOpenAi(request, selected.model);
    }
  } catch (error) {
    console.warn(error);
  }

  const result = response ?? mockTutor(request, selected.model);

  // Resolve any circle_stroke references against the student stroke timeline so the model's
  // sequence-number targeting becomes exact coordinates before the commands leave the server.
  return { ...result, commands: resolveStrokeReferences(result.commands, request.strokeTimeline ?? []) };
};

export const voiceFallbackStatus = () => ({
  implemented: "openai-webrtc-primary",
  realtimeWebSocket: true,
  note: "OpenAI Realtime WebRTC is the primary browser voice path. Gemini Live token provisioning is available as a fallback endpoint; text tutor remains available."
});
