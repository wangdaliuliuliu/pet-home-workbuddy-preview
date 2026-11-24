'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const voice=require('./voice-service');
const {write,fail}=require('./account-service');
const {run}=require('./evolution-service');
const {python}=require('./photo-service');
const imageQueue=[];let imageRunning=false;function enqueueImage(action){return new Promise((resolve,reject)=>{imageQueue.push({action,resolve,reject});drainImages();});}function drainImages(){if(imageRunning||!imageQueue.length)return;imageRunning=true;const job=imageQueue.shift();Promise.resolve().then(job.action).then(job.resolve,job.reject).finally(()=>{imageRunning=false;drainImages();});}
const VOICES=voice.PET_VOICES;
function presetPreview(id){
 const file=path.join(__dirname,'public','assets','voice-previews',id+'.mp3');
 return fs.existsSync(file)?'/assets/voice-previews/'+id+'.mp3':null;
}
function createPetCreation({dataDir,state,save,setName,understand=voice.understandPet,speak=voice.speak,cutout,deferVoice=false,appearance=false,onReady=()=>{}}={}){
 const dir=path.join(dataDir,'pet-creation');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,appearance?'appearance-draft.json':'draft.json');let draft=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};let active=false;
 const persist=()=>write(file,draft);if(['queued','processing'].includes(draft.imageStatus)){draft.imageStatus='failed';draft.imageError='刚才准备中断了，原图还在，点一下再试试。';persist();}
 async function processImage(source,target,id){draft.imageStatus='queued';draft.imageError='';draft.imageStartedAt=Date.now();persist();return enqueueImage(async()=>{draft.imageStatus='processing';persist();try{if(cutout)await cutout(source,target);else await run(python(),[path.join(__dirname,'scripts/cutout-pet.py'),source,target],process.env,'去掉图片背景',40000);draft.cutout=id+'.png';draft.imageStatus='ready';draft.imageError='';persist();}catch(e){draft.imageStatus='failed';draft.imageError=e.diagnostic?.timeout?'这张画准备得有点久，原图还在，可以点一下再试试。':e.diagnostic?.exitCode===22?'画已经读到了，但背景没有分开。原图还在，可以再试一次或换张浅底图。':'这张图片没读完整，原图已经保留，点一下再试试。';persist();console.warn(JSON.stringify({event:'pet_cutout_failed',code:e.diagnostic?.timeout?'CUTOUT_TIMEOUT':'CUTOUT_FAILED'}));throw fail(draft.imageError);}});}
 const preview=()=>draft.voice?.preset===draft.voice?.voice&&VOICES.some(v=>v.id===draft.voice?.preset)?presetPreview(draft.voice.preset):null;
 const view=()=>({...(deferVoice?{deferVoice:true}:{}),imageStatus:draft.imageStatus||(draft.cutout?'ready':null),imageError:draft.imageError||'',canRetryImage:!!draft.original,imageStartedAt:draft.imageStartedAt||null,name:draft.name||'',voice:draft.voice||null,image:draft.cutout?(appearance?'/api/pet-appearance/preview':'/api/pet-creation/image')+'?v='+draft.imageId:null,original:draft.original?'/api/pet-creation/original?v='+draft.imageId:null,audio:preview()||(draft.audio?'/api/pet-creation/audio?v='+draft.audio:null),complete:!!state.petProfile,voices:VOICES});
 async function act(kind,b={}){
  if(active)throw fail('正在准备，等这一步完成再试。',409);active=true;
  try{
   if(['queued','processing'].includes(draft.imageStatus))throw fail('正在准备这张画，先等一下。',409);
   if(!appearance&&state.petProfile)throw fail('宠物已经在家啦，不用再创建。',409);
   if(appearance&&!['retry-image'].includes(kind))throw fail('没有这个操作。',404);
   if(kind==='image'){
    if(typeof b.image!=='string'||b.image.length>11200000)throw fail('请选一张 8MB 以内的图片。');
    const bytes=Buffer.from(b.image,'base64');if(bytes.length<100||bytes.length>8*1024*1024)throw fail('图片大小不合适。');
    const id=crypto.randomUUID(),source=path.join(dir,id+'.source'),target=path.join(dir,id+'.png');fs.writeFileSync(source,bytes);
    // Preserve source even when extraction fails; previous successful cutout remains usable.
    draft.original=id+'.source';draft.imageId=id;persist();
    const pending=processImage(source,target,id);if(b.async===true)pending.catch(()=>{});else await pending;
   }else if(kind==='retry-image'){
    if(!draft.original||path.basename(draft.original)!==draft.original)throw fail('先选一张宠物的画吧。');const source=path.join(dir,draft.original),id=draft.original.replace(/\.source$/,'');const pending=processImage(source,path.join(dir,id+'.png'),id);if(b.async===true)pending.catch(()=>{});else await pending;
   }else if(kind==='understand'){
    if(!['name','voice'].includes(b.field)||typeof b.text!=='string'||!b.text.trim()||b.text.length>600)throw fail('先说说你的想法吧。');
    const result=await understand(b.field,b.text,VOICES);
    if(b.field==='name'){if(typeof result.name!=='string'||!result.name.trim()||result.name.length>16)throw fail('名字没听明白，再告诉我一次吧。');if(draft.name!==result.name.trim())delete draft.audio;draft.name=result.name.trim();}
    else {if(!VOICES.some(v=>v.id===result.voice))throw fail('没找到合适的声音，再说一次吧。');const selected=VOICES.find(v=>v.id===result.voice);const gender=['male','female'].includes(result.gender)?result.gender:null;const chosen=gender&&selected.gender!==gender?VOICES.find(v=>v.gender===gender):selected;draft.voice={version:crypto.randomUUID(),voice:chosen.id,gender:chosen.gender,description:String(result.description||'自然、清楚的中文童声').slice(0,160),instruction:String(result.instruction||'自然、清楚地说中文，适合小朋友听。').slice(0,200),rate:Math.min(1.15,Math.max(.8,Number(result.rate)||1))};delete draft.audio;}
    persist();
   }else if(kind==='draft'){
    if(typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>16)throw fail('名字写 1 到 16 个字就好。');
    if(draft.name!==b.name.trim()){draft.name=b.name.trim();delete draft.audio;}persist();
   }else if(kind==='listen'){
    if(!draft.name)throw fail('先给宠物起个名字吧。');
    if(b.preset!==undefined){
     const preset=VOICES.find(option=>option.id===b.preset);
     if(!preset)throw fail('请选一个童声再试听。');
     if(!presetPreview(preset.id))throw fail('这段试听暂时没找到，请大人检查。',503);
     if(draft.voice?.preset!==preset.id){
      draft.voice={version:crypto.randomUUID(),preset:preset.id,voice:preset.id,gender:preset.gender,description:preset.name,instruction:'用自然、清楚的中文童声说话。',rate:1};
      delete draft.audio;
      persist();
     }
     return view();
    }
    if(!draft.voice)throw fail('先选一个声音吧。');
    if(preview())return view();
    const id=crypto.createHash('sha256').update(draft.name+draft.voice.version).digest('hex').slice(0,24),audio=id+'.mp3';
    if(!fs.existsSync(path.join(dir,audio)))fs.writeFileSync(path.join(dir,audio),await speak(`你好呀，我是${draft.name}！从今天开始，我们一起读故事，一起玩吧。`,{voiceProfile:draft.voice}));
    draft.audio=audio;persist();
   }else if(kind==='finish'){
    if(!draft.name||!draft.cutout)throw fail(deferVoice?'照片和名字准备好，就能带它回家。':'照片、名字和试听都准备好，再一起出发吧。');
    if(!deferVoice&&(!draft.voice||!(preview()||draft.audio)))throw fail('照片、名字和试听都准备好，再一起出发吧。');
    await setName(draft.name);
    state.petProfile={version:1,image:'/api/pet-creation/image',file:path.join('pet-creation',draft.cutout),createdAt:Date.now(),initialStatic:true};
    if(draft.voice&&(preview()||draft.audio))state.voiceProfile=draft.voice;
    else if(deferVoice)state.petProfile.voiceDeferred=true;
    state.name=draft.name;state.room='cozy';state.travelEnabled=true;save();onReady();
   }else throw fail('没有这个操作。',404);
   return view();
  }finally{active=false;}
 }
 async function upload(stream){
 if(active||['queued','processing'].includes(draft.imageStatus))throw fail('正在收好上一张画，先等一下。',409);
 if(!appearance&&state.petProfile)throw fail('宠物已经在家啦，不用再创建。',409);
 active=true;const id=crypto.randomUUID(),source=path.join(dir,id+'.source');let handle,received=0,complete=false;
 try{handle=await fs.promises.open(source,'wx');for await(const chunk of stream){received+=chunk.length;if(received>8*1024*1024)throw fail('这张原图比较大，先试试相册里的另一张照片。',413);await handle.write(chunk);}await handle.close();handle=null;if(received<100)throw fail('照片没有传完整，再选一次原图试试。');draft.original=id+'.source';draft.imageId=id;persist();complete=true;processImage(source,path.join(dir,id+'.png'),id).catch(()=>{});return view();
 }finally{if(handle)await handle.close();if(!complete&&fs.existsSync(source))fs.unlinkSync(source);active=false;}
 }
 function asset(kind){const name=kind==='image'?draft.cutout:kind==='original'?draft.original:draft.audio;if(!name||path.basename(name)!==name||!fs.existsSync(path.join(dir,name)))throw fail('还没有这个文件。',404);return path.join(dir,name);}
 function candidate(){
  if(!appearance||draft.imageStatus!=='ready'||draft.cutout!==draft.imageId+'.png'||!/^([a-f0-9-]{36})\.png$/.test(draft.cutout))return null;
  return {id:draft.imageId,level:0,base:true,image:'/api/pet-appearance/'+draft.cutout,file:path.join('pet-creation',draft.cutout)};
 }
 return{view,act,asset,upload,candidate};
}
module.exports={createPetCreation,VOICES};
