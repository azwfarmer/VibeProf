import { avoidAiAnnotationOverlap } from "./dist-test/lib/aiDrawing.js";
const aiText = (id,x,y,fontSize=38)=>({id,tool:"pen",color:"#2563eb",size:5,points:[],source:"ai",text:"hint",textKind:"label",x,y,fontSize});
const above = aiText("above",200,300);
// sweep intended position of a single new line; report cases where it ends up shifted RIGHT (dx>0)
let diagonals=[];
for(let x=40;x<=1400;x+=20){
  for(let y=120;y<=2000;y+=20){
    const i=[aiText("new",x,y)];
    const o=avoidAiAnnotationOverlap([above],i)[0];
    const dx=o.x-x, dy=o.y-y;
    if(dx>0.5) diagonals.push({x,y,dx,dy});
  }
}
console.log("total intended positions giving rightward shift:",diagonals.length);
console.log("sample:",diagonals.slice(0,15));
// specifically near/under the above line
console.log("\nUnder above line (x in 150..260), any rightward shift?");
console.log(diagonals.filter(d=>d.x>=150&&d.x<=260).slice(0,20));
