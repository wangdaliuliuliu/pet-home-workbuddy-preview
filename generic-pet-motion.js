'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const localAgent=require('./local-agent');
function valid(m){return m?.version===2&&m.rig==='pet-mesh-v1'&&m.layers?.body?.file==='body.png'&&m.layers?.blink?.file==='blink.png'&&m.layers.body.width===1024&&m.layers.body.height===1024&&m.layers.blink.width===1024&&m.layers.blink.height===1024&&/^[a-f0-9]{64}$/.test(m.sourceSha256)&&['body','blink'].every(k=>/^[a-f0-9]{64}$/.test(m.layers[k].sha256))&&Array.isArray(m.bones)&&m.bones.length===3&&m.bones.every((b,i)=>b.name===['root','spine','head'][i]&&b.parent===[null,'root','spine'][i]&&Array.isArray(b.pivot)&&b.pivot.length===2&&b.pivot.every(n=>Number.isFinite(n)&&n>=0&&n<=1))&&Array.isArray(m.vertices)&&m.vertices.length===81&&m.vertices.every(v=>v.length===5&&v.every(Number.isFinite)&&v[0]>=0&&v[0]<=1&&v[1]>=0&&v[1]<=1&&v.slice(2).every(w=>w>=0&&w<=1)&&Math.abs(v[2]+v[3]+v[4]-1)<.001)&&Array.isArray(m.triangles)&&m.triangles.length===128&&m.triangles.every(t=>t.length===3&&new Set(t).size===3&&t.every(i=>Number.isInteger(i)&&i>=0&&i<81));}
async function generate({sourceFile,dir,formImage}){
 const {run}=require('./evolution-service'),{python}=require('./photo-service');if(!localAgent.enabled()&&(!process.env.PET_IMAGE_API_KEY||!process.env.PET_IMAGE_BASE_URL))throw Error('动作服务还没准备好，请老师帮忙。');
 const py=python(),script=path.join(__dirname,'scripts/generic-pet-bind.py');
 await run(py,[script,'prepare',sourceFile,dir],process.env,'检查自己的形象');
 const raw=path.join(dir,'blink-source.png'),prompt=path.join(dir,'blink-prompt.txt');
 fs.writeFileSync(prompt,'Edit the supplied reference character ONLY to close its eyes softly for a natural blink. Preserve EXACT identity, body, pose, proportions, all accessories, complete silhouette, camera, framing and pixel placement. Do not add limbs, wings, clothes or any feature. This is a blink animation frame of the SAME pet, not a new character or evolution. Full character inside the image with padding. Entire background must be perfectly flat solid #00FF00 chroma green, no green on the character. No text, ground, cast shadow, checkerboard or extra objects.');
 if(!fs.existsSync(raw)){
  if(localAgent.enabled())await localAgent.generateImage({prompt:fs.readFileSync(prompt,'utf8'),files:[sourceFile],destination:raw});
  else await run(py,[process.env.PET_IMAGE_CLI||path.join(__dirname,'scripts/image_gen.py'),'edit','--model',process.env.PET_IMAGE_MODEL||'gpt-image-2','--image',sourceFile,'--prompt-file',prompt,'--size','1024x1024','--quality','high','--output-format','png','--out',raw],{...process.env,OPENAI_API_KEY:process.env.PET_IMAGE_API_KEY,OPENAI_BASE_URL:process.env.PET_IMAGE_BASE_URL,PYTHONUTF8:'1'},'准备自己的眨眼动作',480000);
 }
 await run(py,[script,'bind',sourceFile,dir,formImage],process.env,'绑定自己的动作');
 await run(py,[script,'check',dir],process.env,'检查当前形态动作');
 return JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
}
module.exports={valid,generate};
