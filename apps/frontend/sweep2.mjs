import { avoidAiAnnotationOverlap } from "./dist-test/lib/aiDrawing.js";
const aiText=(id,x,y,fs=38)=>({id,tool:"pen",color:"#2563eb",size:5,points:[],source:"ai",text:"hint",textKind:"label",x,y,fontSize:fs});
const stu=(id,x,y)=>({id,tool:"pen",color:"#111",size:4,points:[{x,y,pressure:.6},{x:x+240,y:y+30,pressure:.6}],source:"user"});
// paragraph of student lines near left margin
const page=[stu("s1",140,300),stu("s2",140,360),stu("s3",140,420)];
// new AI line intended directly below the block, left-aligned, empty below
for(const [lbl,x,y] of [["right below empty",140,500],["overlapping last",145,430],["far below",140,800]]){
  const i=[aiText("new",x,y)];
  const o=avoidAiAnnotationOverlap(page,i)[0];
  console.log(`${lbl}: intended(${x},${y}) -> (${o.x},${o.y}) dx=${o.x-x} dy=${o.y-y}`);
}
