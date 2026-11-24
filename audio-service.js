const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
async function normalizeRecording(bytes){
 const root=path.join(process.env.PET_DATA_DIR||path.join(__dirname,'data'),'audio-work');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'asr-')),source=path.join(dir,'recording'),output=path.join(dir,'speech.wav');
 try{fs.writeFileSync(source,bytes);await new Promise((resolve,reject)=>{let timedOut=false;const child=spawn(process.env.PET_IMAGE_FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-filter_threads','1','-i',source,'-vn','-threads','1','-ac','1','-ar','16000','-c:a','pcm_s16le','-t','90',output],{windowsHide:true,stdio:'ignore'});const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},20000);child.once('error',()=>{clearTimeout(timer);reject(Object.assign(Error('录音处理工具暂时没准备好。'),{stage:'normalize',reason:'tool_unavailable'}));});child.once('close',code=>{clearTimeout(timer);if(timedOut)reject(Object.assign(Error('录音处理超时，录音还在，可以重新转文字。'),{stage:'normalize',reason:'timeout'}));else code===0?resolve():reject(Object.assign(Error('这段录音没有读出来，靠近手机重新讲几秒吧。'),{stage:'normalize',reason:'decode_failed'}));});});const converted=fs.readFileSync(output);if(converted.length<1000)throw Object.assign(Error('录音太短啦，讲几秒后再点停止。'),{stage:'normalize',reason:'too_short'});return converted;}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
}
async function splitRecording(source,dir){
 await new Promise((resolve,reject)=>{
  const child=spawn(process.env.PET_IMAGE_FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-filter_threads','1','-i',source,'-vn','-threads','1','-ac','1','-ar','16000','-c:a','pcm_s16le','-t','1201','-f','segment','-segment_time','45','-reset_timestamps','1',path.join(dir,'%03d.wav')],{windowsHide:true,stdio:'ignore'});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},90000);
  child.once('error',()=>{clearTimeout(timer);reject(Error('录音处理工具暂时没有准备好。'));});
  child.once('close',code=>{clearTimeout(timer);code===0&&!timedOut?resolve():reject(Error('录音还没整理好，原录音会保留。'));});
 });
 const parts=fs.readdirSync(dir).filter(n=>/^\d{3}\.wav$/.test(n)).sort().map(n=>path.join(dir,n));
 if(!parts.length)throw Error('录音里没有可以整理的声音。');return parts;
}
async function inspectRecording(file){
 if(process.env.PET_PORTABLE==='1'&&process.env.PET_IMAGE_FFMPEG&&!process.env.PET_IMAGE_FFPROBE){
  return new Promise((resolve,reject)=>{
   const child=spawn(process.env.PET_IMAGE_FFMPEG,['-hide_banner','-nostdin','-i',file,'-t','0','-f','null','-'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
   let output='';
   child.stderr.on('data',chunk=>{if(output.length<12000)output+=chunk;});
   const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
   child.once('error',()=>{clearTimeout(timer);reject(Error('录音检查工具暂时没有准备好。'));});
   child.once('close',code=>{
    clearTimeout(timer);
    const parts=/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output);
    const seconds=parts?Number(parts[1])*3600+Number(parts[2])*60+Number(parts[3]):0;
    if(code===0&&seconds>0)resolve(seconds);
    else reject(Object.assign(Error('这段录音没有完整读出来，声音暂存仍会保留。'),{status:422}));
   });
  });
 }
 const ffprobe=process.env.PET_IMAGE_FFPROBE||'ffprobe';
 return new Promise((resolve,reject)=>{let text='';const child=spawn(ffprobe,['-v','error','-show_entries','format=duration','-of','json',file],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  child.stdout.on('data',b=>{if(text.length<10000)text+=b;});const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
  child.once('error',()=>{clearTimeout(timer);reject(Error('录音检查工具暂时没有准备好。'));});
  child.once('close',code=>{clearTimeout(timer);try{const seconds=Number(JSON.parse(text).format.duration);if(code!==0||!Number.isFinite(seconds)||seconds<=0)throw Error();resolve(seconds);}catch{reject(Object.assign(Error('这段录音没有完整读出来，声音暂存仍会保留。'),{status:422}));}});
 });
}
module.exports={normalizeRecording,splitRecording,inspectRecording};
