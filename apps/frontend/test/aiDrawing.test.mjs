// Zero-dependency unit tests for the AI-writing overlap guard.
// Run with: npm --workspace apps/frontend run test
// (tsconfig.test.json transpiles src/lib/aiDrawing.ts -> dist-test/ first.)
import test from "node:test";
import assert from "node:assert/strict";

import { avoidAiAnnotationOverlap, getStrokeBounds } from "../dist-test/lib/aiDrawing.js";

const studentStroke = (id, x, y) => ({
  id,
  tool: "pen",
  color: "#111827",
  size: 4,
  points: [
    { x, y, pressure: 0.6 },
    { x: x + 220, y: y + 36, pressure: 0.6 }
  ],
  source: "user"
});

const aiText = (id, x, y, text = "next step") => ({
  id,
  tool: "pen",
  color: "#2563eb",
  size: 5,
  points: [],
  source: "ai",
  text,
  textKind: "label",
  x,
  y,
  fontSize: 38
});

const aiCircle = (id, x, y) => ({
  id,
  tool: "pen",
  color: "#be123c",
  size: 6,
  points: [
    { x, y, pressure: 0.7 },
    { x: x + 90, y: y + 90, pressure: 0.7 }
  ],
  source: "ai",
  label: "sign error"
});

const intersects = (a, b) =>
  !(a.x + a.width < b.x || a.x > b.x + b.width || a.y + a.height < b.y || a.y > b.y + b.height);

test("relocates AI text that lands on the student's writing", () => {
  const student = studentStroke("s1", 200, 300);
  const incoming = aiText("a1", 210, 330); // intentionally on top of the student stroke

  const [moved] = avoidAiAnnotationOverlap([student], [incoming]);

  assert.ok(moved.x !== incoming.x || moved.y !== incoming.y, "AI text should have moved");
  assert.ok(
    !intersects(getStrokeBounds(moved), getStrokeBounds(student)),
    "moved AI text must not overlap the student stroke"
  );
});

test("leaves positional marks (circles/arrows) anchored on the student's work", () => {
  const student = studentStroke("s1", 200, 300);
  const circle = aiCircle("a1", 210, 330); // a mistake-circle sits ON the student work by design

  const [result] = avoidAiAnnotationOverlap([student], [circle]);

  assert.deepEqual(result.points, circle.points, "non-text mark must not be relocated");
});

test("does not move AI text when the page is clear", () => {
  const incoming = aiText("a1", 800, 1100);

  const [moved] = avoidAiAnnotationOverlap([], [incoming]);

  assert.equal(moved.x, incoming.x);
  assert.equal(moved.y, incoming.y);
});

test("straightens a diagonal chain into a column when the space below is empty", () => {
  // The model drifts each line to the right; the column below the first line is clear.
  const top = aiText("a1", 600, 400, "step 1");
  const mid = aiText("a2", 640, 458, "step 2"); // drifted +40px right
  const bottom = aiText("a3", 680, 516, "step 3"); // drifted +80px right

  const [movedTop, movedMid, movedBottom] = avoidAiAnnotationOverlap([], [top, mid, bottom]);

  assert.equal(movedTop.x, top.x, "the anchor line keeps its x");
  assert.equal(movedMid.x, movedTop.x, "second line snaps under the first");
  assert.equal(movedBottom.x, movedTop.x, "third line snaps under the first");
  assert.equal(movedMid.y, mid.y, "vertical positions are untouched");
  assert.equal(movedBottom.y, bottom.y, "vertical positions are untouched");
});

test("snaps a new hint under the prior AI line it drifted to the right of", () => {
  const priorHint = aiText("e1", 600, 400, "step 1"); // already on the page from a past turn
  const newHint = aiText("a1", 665, 510, "step 2"); // a fresh response, drifted +65px right

  const [moved] = avoidAiAnnotationOverlap([priorHint], [newHint]);

  assert.equal(moved.x, priorHint.x, "the new line stacks under the prior line's left edge");
  assert.notEqual(moved.x, newHint.x, "the model's rightward drift is corrected");
});

test("leaves a deliberately separate column to the right alone", () => {
  const priorHint = aiText("e1", 200, 400, "left col");
  const newHint = aiText("a1", 900, 470, "right col"); // far to the right = its own column

  const [moved] = avoidAiAnnotationOverlap([priorHint], [newHint]);

  assert.equal(moved.x, newHint.x, "a distant column is not yanked under the left one");
});

test("does not collapse a separate block far below into the column", () => {
  const top = aiText("a1", 600, 400, "step 1");
  const far = aiText("a2", 200, 1200, "aside"); // a big vertical jump = its own block

  const [movedTop, movedFar] = avoidAiAnnotationOverlap([], [top, far]);

  assert.equal(movedTop.x, top.x);
  assert.equal(movedFar.x, far.x, "a distant block keeps its own x");
});

test("keeps a multi-step formula chain together when reflowing", () => {
  const student = studentStroke("s1", 120, 240);
  const top = aiText("a1", 140, 260, "x = 5");
  const bottom = aiText("a2", 140, 318, "y = 2x"); // 58px below, same x — a vertical chain

  const [movedTop, movedBottom] = avoidAiAnnotationOverlap([student], [top, bottom]);

  assert.equal(movedBottom.x - movedTop.x, bottom.x - top.x, "horizontal alignment preserved");
  assert.equal(movedBottom.y - movedTop.y, bottom.y - top.y, "vertical spacing preserved");
  assert.ok(
    !intersects(getStrokeBounds(movedTop), getStrokeBounds(student)) &&
      !intersects(getStrokeBounds(movedBottom), getStrokeBounds(student)),
    "neither chain line overlaps the student stroke"
  );
});
