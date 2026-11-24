const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {Readable}=require('node:stream');
const {splitRecording,inspectRecording}=require('./audio-service');
const MAX_SECONDS=1200,MAX_BYTES=64*1024*1024,CHUNK_BYTES=2*1024*1024;
const TYPES=new Set(['audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/x-wav','audio/ogg','audio/x-m4a','audio/aac']);
const fail=(message,status=400)=>Object.assign(Error(message),{status});
function isSilentWav(bytes){
 if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')return false;
 for(let offset=12;offset+8<=bytes.length;){const name=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8,end=Math.min(start+size,bytes.length);
  if(name==='data'){for(let i=start;i+1<end;i+=2)if(Math.abs(bytes.readInt16LE(i))>8)return false;return true;}
  offset=start+size+(size%2);
 }return false;
}
function createReadings({state,save,dataDir,submit,transcribe,queue,split=splitRecording,probe=inspectRecording,enabled=true,onTranscript=()=>{}}){
 const root=path.join(dataDir,'reading-uploads');fs.mkdirSync(root,{recursive:true});
 state.readingJobs||={};
 for(const job of Object.values(state.readingJobs))if(job.status==='processing'){job.status='interrupted';const s=state.stories.find(s=>s.id===job.storyId);if(s)s.transcriptionStatus='interrupted';}
 const locks=new Set();let processing=false;const pending=[];let completion=Promise.resolve();
 const safe=value=>typeof value==='string'&&/^[a-z0-9_-]{1,80}$/i.test(value)?value:undefined;
 async function transcribePart(wav,job,part) {
  const body={audio:wav.toString('base64'),audioType:'audio/wav'};
  for(let attempt=1;;attempt++){
   const release=await queue.acquire();
   try{return await transcribe(body);}
   catch(error){
    if(error.status===422&&error.reason==='empty_result')return '';
    const entry={at:new Date().toISOString(),part,attempt,stage:safe(error.stage)||'transcribe',
      code:safe(error.reason)||safe(error.code)||'reading_failed',networkCode:safe(error.networkCode),
      upstreamStatus:error.providerStatus,upstreamRequestId:safe(error.upstreamRequestId)};
    job.attemptErrors=[...(job.attemptErrors||[]),entry].slice(-50);
    save();
    if(attempt===2||error.reason!=='connection_or_timeout')throw error;
   }finally{release();}
   await new Promise(resolve=>setTimeout(resolve,350));
  }
 }
 const valid=id=>/^[a-f0-9-]{36}$/.test(id);
 function folder(id){if(!valid(id))throw fail('这次录音没有找到。',404);const target=path.resolve(root,id);if(path.dirname(target)!==path.resolve(root))throw fail('这次录音没有找到。',404);return target;}
 function load(id){try{return JSON.parse(fs.readFileSync(path.join(folder(id),'session.json'),'utf8'));}catch(e){if(e.status)throw e;throw fail('这次录音没有找到。',404);}}
 function persist(s){const file=path.join(folder(s.id),'session.json');fs.writeFileSync(file+'.tmp',JSON.stringify(s));fs.renameSync(file+'.tmp',file);}
 function create(audioType,actionId){
  audioType=String(audioType||'').split(';')[0];if(!TYPES.has(audioType)||!valid(actionId))throw fail('请重新开始这次读书录音。');
  for(const id of fs.readdirSync(root)){if(!valid(id))continue;let s;try{s=load(id);}catch{continue;}
   if(s.actionId===actionId)return {id:s.id,maxSeconds:MAX_SECONDS};
  }
  const open=fs.readdirSync(root).filter(valid).map(id=>{try{return load(id);}catch{return null;}}).filter(s=>s&&!s.storyId);
  if(open.length>=3)throw fail('还有未保存的录音，请先把上次的录音收好。',429);
  const s={id:crypto.randomUUID(),actionId,audioType,createdAt:Date.now(),parts:{},bytes:0};fs.mkdirSync(folder(s.id));persist(s);return {id:s.id,maxSeconds:MAX_SECONDS};
 }
 async function upload(id,index,request){
  if(!Number.isInteger(index)||index<0||index>=2000)throw fail('录音片段编号不正确。');
  const s=load(id);if(s.storyId)return {saved:true};
  if(locks.has(id))throw fail('上一段声音正在保存，请稍后再试。',409);
  locks.add(id);const file=path.join(folder(id),index+'.part'),temp=file+'.tmp';let size=0;const hash=crypto.createHash('sha256');
  try{
   const write=fs.createWriteStream(temp,{flags:'w'});
   async function* bounded(){for await(const bytes of request){size+=bytes.length;if(size>CHUNK_BYTES||s.bytes+size>MAX_BYTES+CHUNK_BYTES)throw fail('录音有点大，这次先收好，下一次再接着读。',413);hash.update(bytes);yield bytes;}}
   await pipeline(Readable.from(bounded()),write);if(!size)throw fail('这一小段没有录到声音。');
   const digest=hash.digest('hex');
   if(s.parts[index]){if(s.parts[index].hash!==digest)throw fail('录音片段不一致，请保留录音后重新保存。',409);return {saved:true,index};}
   if(s.bytes+size>MAX_BYTES)throw fail('这次录音已达到保存大小上限。',413);
   fs.renameSync(temp,file);s.parts[index]={bytes:size,hash:digest};s.bytes+=size;persist(s);return {saved:true,index};
  }finally{fs.rmSync(temp,{force:true});locks.delete(id);}
 }
 function status(storyId){const job=state.readingJobs[storyId];if(!job)throw fail('这条读书记录没有找到。',404);const story=state.stories.find(s=>s.id===storyId);return {storyId,status:job.status,completedParts:job.texts.length,totalParts:job.totalParts||0,transcript:story?.transcript||'',error:job.error||''};}
 function start(storyId){
  const job=state.readingJobs[storyId];if(!job||job.status==='ready'||job.status==='processing'||pending.includes(storyId))return false;
  if(!enabled)return false;
  if(pending.length>=2)throw fail('正在整理上一段读书录音，请稍后继续转文字。',429);
  job.status='processing';job.error='';delete job.diagnostic;const story=state.stories.find(s=>s.id===storyId);story.transcriptionStatus='processing';pending.push(storyId);save();
  if(!processing)completion=drain();return true;
 }
 async function drain(){processing=true;
  try{while(pending.length){const id=pending.shift(),job=state.readingJobs[id],story=state.stories.find(s=>s.id===id);let release,partsDir;
   try{
    release=await queue.acquire();
    partsDir=path.join(dataDir,'reading-work',id);fs.mkdirSync(partsDir,{recursive:true});
    const parts=await split(path.join(dataDir,id+'.audio'),partsDir);release();release=null;
    job.totalParts=parts.length;save();
    for(let i=job.texts.length;i<parts.length;i++){
     // Only one short WAV is held in memory, never the complete twenty-minute recording.
     const wav=fs.readFileSync(parts[i]);
     const text=isSilentWav(wav)?'':await transcribePart(wav,job,i+1);
     job.texts.push(text);story.transcript=job.texts.filter(Boolean).join('\n').slice(0,30000);save();
    }
    if(!story.transcript?.trim()){
      job.texts=[];
      throw Object.assign(Error('No speech recognized'),{stage:'result',reason:'empty_result'});
    }
    job.status='ready';story.transcriptionStatus='ready';onTranscript(story);
   }catch(e){
    job.diagnostic={at:new Date().toISOString(),stage:safe(e.stage)||'reading_processing',code:safe(e.reason)||safe(e.code)||'reading_failed',networkCode:safe(e.networkCode),part:job.texts.length+1};
    job.status='failed';job.error='录音已经收好，文字还没整理完，可以继续转文字，不用重新读。';story.transcriptionStatus='failed';
    if(e.reason==='empty_result')job.error='录音已经收好，这次没识别出文字。可以先听原录音。';
   }
   finally{release?.();if(partsDir)fs.rmSync(partsDir,{recursive:true,force:true});save();}
  }}finally{processing=false;}
 }
 async function finish(id,{partCount,durationMs}){
  const s=load(id);if(s.storyId){if(!state.readingJobs[s.storyId]){state.readingJobs[s.storyId]={storyId:s.storyId,status:'pending',texts:[]};save();}start(s.storyId);return {storyId:s.storyId,replayed:true};}
  if(locks.has(id))throw fail('声音还在上传，请稍等一下。',409);
  if(!Number.isInteger(partCount)||partCount<1||partCount>2000||Object.keys(s.parts).length!==partCount||!Number.isFinite(durationMs)||durationMs<0||durationMs>(MAX_SECONDS+5)*1000)throw fail('录音还没有完整上传，请重试保存。',409);
  for(let i=0;i<partCount;i++)if(!s.parts[i])throw fail('还有一段声音没有上传，请重试保存。',409);
  locks.add(id);const merged=path.join(folder(id),'complete.audio');
  try{
   async function* parts(){for(let i=0;i<partCount;i++)yield* fs.createReadStream(path.join(folder(id),i+'.part'));}
   await pipeline(Readable.from(parts()),fs.createWriteStream(merged));
   const seconds=await probe(merged);if(seconds>MAX_SECONDS+1)throw fail('这段录音超过20分钟，请选20分钟以内的声音。',413);
   const story=await submit({actionId:s.actionId,audioType:s.audioType,audioFile:merged,durationMs:Math.round(seconds*1000)});
   s.storyId=story.id;persist(s);
   if(!state.readingJobs[story.id])state.readingJobs[story.id]={storyId:story.id,status:'pending',texts:[]};save();
   start(story.id);
   // Final story audio is durable before duplicate temporary chunks are removed.
   for(let i=0;i<partCount;i++)fs.rmSync(path.join(folder(id),i+'.part'),{force:true});
   fs.rmSync(merged,{force:true});return {storyId:story.id,replayed:false};
  }finally{locks.delete(id);}
 }
 function discard(id){const s=load(id);if(s.storyId)return;if(locks.has(id))throw fail('声音还在上传，请稍等一下。',409);fs.rmSync(folder(id),{recursive:true,force:true});}
 return {create,upload,finish,status,start,discard,settled:()=>completion};
}
module.exports={createReadings,MAX_SECONDS,MAX_BYTES,CHUNK_BYTES,isSilentWav};
