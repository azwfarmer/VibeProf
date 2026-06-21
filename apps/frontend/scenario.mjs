import { avoidAiAnnotationOverlap, getStrokeBounds } from "./dist-test/lib/aiDrawing.js";
const aiText = (id, x, y, text="next step", fontSize=38, textKind="label") => ({
  id, tool:"pen", color:"#2563eb", size:5, points:[], source:"ai", text, textKind, x, y, fontSize
});
const show = (label, before, after) => {
  console.log(`\n## ${label}`);
  after.forEach((s,i) => {
    const b = before[i];
    console.log(`  ${s.id}: intended (x=${b.x}, y=${b.y}) -> placed (x=${s.x}, y=${s.y})  dx=${s.x-b.x} dy=${s.y-b.y}`);
  });
};
const above = aiText("above", 200, 300, "first hint", 38, "label");
console.log("above-line bounds:", getStrokeBounds(above));
{ const i=[aiText("new",200,380)]; show("A: left-aligned 80px below (empty below)", i, avoidAiAnnotationOverlap([above],i)); }
{ const i=[aiText("new",200,345)]; show("B: left-aligned 45px below (padding overlap)", i, avoidAiAnnotationOverlap([above],i)); }
{ const i=[aiText("new",205,305)]; show("C: ON TOP of above line", i, avoidAiAnnotationOverlap([above],i)); }
{ const i=[aiText("l1",200,305),aiText("l2",200,363),aiText("l3",200,421)]; show("D: 3-line chain ON TOP (empty below)", i, avoidAiAnnotationOverlap([above],i)); }
