import { createId, now } from "../ids.js";
import type { AiDrawingCommand, Stroke, StrokePoint } from "../types.js";

const canvasWidth = 1600;
const canvasHeight = 2200;
const defaultColor = "#2563eb";
const aiSize = 8;

const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const point = (x: number, y: number): StrokePoint => ({ x: clamp(x, 0, canvasWidth), y: clamp(y, 0, canvasHeight), pressure: 0.75 });
const linePoints = (from: { x: number; y: number }, to: { x: number; y: number }, steps = 24) =>
  Array.from({ length: steps + 1 }, (_, index) => {
    const progress = index / steps;
    return point(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress);
  });
const color = (value: unknown) => (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : defaultColor);
const label = (value: unknown) => (typeof value === "string" ? value.slice(0, 48) : undefined);
const text = (value: unknown, max = 180) => (typeof value === "string" ? value.slice(0, max) : "");
const fontSize = (value: unknown, fallback = 46) => (isNumber(value) ? clamp(Number(value), 22, 86) : fallback);
const idText = (value: unknown) => (typeof value === "string" ? value.slice(0, 120) : "");
const textIndex = (value: unknown) => (isNumber(value) ? Math.max(0, Math.min(500, Math.round(Number(value)))) : 0);

const normalizeFormula = (value: string) =>
  value
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)")
    .replace(/\\sqrt\{([^{}]+)\}/g, "√($1)")
    .replace(/\bsqrt\{([^{}]+)\}/g, "√($1)")
    .replace(/\bsqrt\(([^()]+)\)/g, "√($1)")
    .replace(/\\pi/g, "π")
    .replace(/\bpi\b/g, "π")
    .replace(/\\theta/g, "θ")
    .replace(/\\alpha/g, "α")
    .replace(/\\beta/g, "β")
    .replace(/\\gamma/g, "γ")
    .replace(/\\Delta/g, "Δ")
    .replace(/\\sigma/g, "σ")
    .replace(/\\Sigma/g, "Σ")
    .replace(/\\int/g, "∫")
    .replace(/\\sum/g, "Σ")
    .replace(/\\infty/g, "∞")
    .replace(/\\partial/g, "∂")
    .replace(/\\approx/g, "≈")
    .replace(/\\neq/g, "≠")
    .replace(/\\leq/g, "≤")
    .replace(/\\geq/g, "≥")
    .replace(/\\pm/g, "±")
    .replace(/\\times/g, "×")
    .replace(/\\cdot/g, "·");

export const validateCommands = (commands: unknown): AiDrawingCommand[] => {
  if (!Array.isArray(commands)) {
    return [];
  }

  return commands.slice(0, 16).flatMap((command): AiDrawingCommand[] => {
    if (!command || typeof command !== "object" || !("type" in command)) {
      return [];
    }

    const raw = command as Record<string, unknown>;
    const type = raw.type;

    if (type === "clear_ai_annotations") {
      return [{ type }];
    }

    if (type === "erase_ai_text_range" && typeof raw.strokeId === "string" && isNumber(raw.start) && isNumber(raw.end)) {
      const start = textIndex(raw.start);
      const end = textIndex(raw.end);

      return [
        {
          type,
          strokeId: idText(raw.strokeId),
          annotationId: idText(raw.annotationId) || undefined,
          start: Math.min(start, end),
          end: Math.max(start, end)
        }
      ];
    }

    if (type === "replace_ai_text" && typeof raw.strokeId === "string" && isNumber(raw.start) && isNumber(raw.end) && typeof raw.text === "string") {
      const start = textIndex(raw.start);
      const end = textIndex(raw.end);

      return [
        {
          type,
          strokeId: idText(raw.strokeId),
          annotationId: idText(raw.annotationId) || undefined,
          start: Math.min(start, end),
          end: Math.max(start, end),
          text: text(raw.text, 160)
        }
      ];
    }

    if (type === "erase_ai_region" && isNumber(raw.x) && isNumber(raw.y) && isNumber(raw.radius)) {
      return [
        {
          type,
          x: clamp(Number(raw.x), 0, canvasWidth),
          y: clamp(Number(raw.y), 0, canvasHeight),
          radius: clamp(Number(raw.radius), 8, 520)
        }
      ];
    }

    if (type === "erase_ai_box" && isNumber(raw.x) && isNumber(raw.y) && isNumber(raw.width) && isNumber(raw.height)) {
      return [
        {
          type,
          x: clamp(Number(raw.x), 0, canvasWidth),
          y: clamp(Number(raw.y), 0, canvasHeight),
          width: clamp(Number(raw.width), 8, canvasWidth),
          height: clamp(Number(raw.height), 8, canvasHeight)
        }
      ];
    }

    if (type === "write_label" && isNumber(raw.x) && isNumber(raw.y) && typeof raw.text === "string") {
      return [{ type, x: clamp(Number(raw.x), 0, canvasWidth), y: clamp(Number(raw.y), 0, canvasHeight), text: text(raw.text, 72), color: color(raw.color), fontSize: fontSize(raw.fontSize, 38) }];
    }

    if (type === "write_formula" && isNumber(raw.x) && isNumber(raw.y) && typeof raw.text === "string") {
      return [{ type, x: clamp(Number(raw.x), 0, canvasWidth), y: clamp(Number(raw.y), 0, canvasHeight), text: normalizeFormula(text(raw.text, 220)), color: color(raw.color), fontSize: fontSize(raw.fontSize, 52) }];
    }

    if (type === "circle_region" && isNumber(raw.x) && isNumber(raw.y) && isNumber(raw.radius)) {
      return [{ type, x: clamp(Number(raw.x), 0, canvasWidth), y: clamp(Number(raw.y), 0, canvasHeight), radius: clamp(Number(raw.radius), 12, 420), color: color(raw.color), label: label(raw.label) }];
    }

    if (type === "highlight_box" && isNumber(raw.x) && isNumber(raw.y) && isNumber(raw.width) && isNumber(raw.height)) {
      return [{ type, x: clamp(Number(raw.x), 0, canvasWidth), y: clamp(Number(raw.y), 0, canvasHeight), width: clamp(Number(raw.width), 12, canvasWidth), height: clamp(Number(raw.height), 12, canvasHeight), color: color(raw.color ?? "#fde047"), label: label(raw.label) }];
    }

    const from = raw.from as Record<string, unknown> | undefined;
    const to = raw.to as Record<string, unknown> | undefined;
    if ((type === "draw_arrow" || type === "underline") && from && to && isNumber(from.x) && isNumber(from.y) && isNumber(to.x) && isNumber(to.y)) {
      return [{ type, from: { x: clamp(Number(from.x), 0, canvasWidth), y: clamp(Number(from.y), 0, canvasHeight) }, to: { x: clamp(Number(to.x), 0, canvasWidth), y: clamp(Number(to.y), 0, canvasHeight) }, color: color(raw.color), label: label(raw.label) }];
    }

    return [];
  });
};

const stroke = (points: StrokePoint[], command: AiDrawingCommand, tool: Stroke["tool"] = "pen", size = aiSize): Stroke => ({
  id: createId(),
  tool,
  color: "color" in command ? color(command.color) : defaultColor,
  size,
  points,
  source: "ai",
  annotationId: createId(),
  label: "label" in command ? label(command.label) : undefined,
  createdAt: now()
});

const textStroke = (command: Extract<AiDrawingCommand, { type: "write_label" | "write_formula" }>): Stroke => ({
  id: createId(),
  tool: "pen",
  color: color(command.color),
  size: Math.max(4, Math.round((command.fontSize ?? 44) / 8)),
  points: [],
  source: "ai",
  annotationId: createId(),
  label: command.type === "write_formula" ? "formula" : command.text.slice(0, 48),
  createdAt: now(),
  text: command.type === "write_formula" ? normalizeFormula(command.text) : command.text,
  textKind: command.type === "write_formula" ? "formula" : "label",
  x: command.x,
  y: command.y,
  fontSize: command.fontSize ?? (command.type === "write_formula" ? 52 : 38),
  rotation: (Math.random() - 0.5) * 0.035
});

const visibleLabelStroke = (command: { label?: string; color?: string }, x: number, y: number): Stroke | null => {
  const visibleText = label(command.label);

  if (!visibleText) {
    return null;
  }

  return textStroke({
    type: "write_label",
    x: clamp(x, 16, canvasWidth - 260),
    y: clamp(y, 34, canvasHeight - 34),
    text: visibleText,
    color: "color" in command ? color(command.color) : defaultColor,
    fontSize: 30
  });
};

export const commandsToStrokes = (commands: AiDrawingCommand[]): Stroke[] => {
  const strokes: Stroke[] = [];

  commands.forEach((command) => {
    if (command.type === "draw_arrow") {
      strokes.push(stroke(linePoints(command.from, command.to), command));
      const angle = Math.atan2(command.to.y - command.from.y, command.to.x - command.from.x);
      const left = point(command.to.x - Math.cos(angle - 0.6) * 38, command.to.y - Math.sin(angle - 0.6) * 38);
      const right = point(command.to.x - Math.cos(angle + 0.6) * 38, command.to.y - Math.sin(angle + 0.6) * 38);
      strokes.push(stroke([left, point(command.to.x, command.to.y), right], command));
      const labelStroke = visibleLabelStroke(command, command.to.x + 18, command.to.y - 18);
      if (labelStroke) strokes.push(labelStroke);
    }

    if (command.type === "underline") {
      strokes.push(stroke(linePoints(command.from, command.to, 18), command));
      const labelStroke = visibleLabelStroke(command, command.to.x + 16, command.to.y - 16);
      if (labelStroke) strokes.push(labelStroke);
    }

    if (command.type === "circle_region") {
      const points: StrokePoint[] = [];
      for (let step = 0; step <= 48; step += 1) {
        const angle = (Math.PI * 2 * step) / 48;
        points.push(point(command.x + Math.cos(angle) * command.radius, command.y + Math.sin(angle) * command.radius));
      }
      strokes.push(stroke(points, command));
      const labelStroke = visibleLabelStroke(command, command.x + command.radius + 18, command.y - 8);
      if (labelStroke) strokes.push(labelStroke);
    }

    if (command.type === "highlight_box") {
      const points = [
        point(command.x, command.y),
        point(command.x + command.width, command.y),
        point(command.x + command.width, command.y + command.height),
        point(command.x, command.y + command.height),
        point(command.x, command.y)
      ];
      strokes.push(stroke(points, command, "highlighter", 28));
      const labelStroke = visibleLabelStroke(command, command.x + command.width + 16, command.y + 26);
      if (labelStroke) strokes.push(labelStroke);
    }

    if (command.type === "write_label") {
      strokes.push(textStroke(command));
    }

    if (command.type === "write_formula") {
      strokes.push(textStroke(command));
    }
  });

  return strokes;
};
