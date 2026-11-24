(() => {
 const $=id=>document.getElementById(id),MAX_MS=1200000,PIECE=1024*1024;
 let dbPromise;
 function db(){return dbPromise||=(new Promise((resolve,reject)=>{const r=indexedDB.open('zuanzuan-reading-v1',1);r.onupgradeneeded=()=>{r.result.createObjectStore('meta');r.result.createObjectStore('parts',{keyPath:'key'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('录音没能打开，请找老师帮忙。'));}));}
 async function store(name,mode,action){const d=await db();return new Promise((resolve,reject)=>{const t=d.transaction(name,mode),r=action(t.objectStore(name));let result;r.onsuccess=()=>{result=r.result;};t.oncomplete=()=>resolve(result);t.onerror=()=>reject(Error('录音快放不下了，先点保存吧。'));t.onabort=t.onerror;});}
 const getMeta=()=>store('meta','readonly',s=>s.get('active'));
 const putMeta=m=>store('meta','readwrite',s=>s.put(m,'active'));
 const partKey=(id,index)=>id+':'+String(index).padStart(6,'0');
 const getPart=(id,index)=>store('parts','readonly',s=>s.get(partKey(id,index)));
 async function clearDraft(meta){if(!meta)return;for(let i=0;i<meta.partCount;i++)await store('parts','readwrite',s=>s.delete(partKey(meta.id,i)));await store('meta','readwrite',s=>s.delete('active'));}
 async function api(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});let d;try{d=await r.json();}catch{throw Error('暂时没有连上，录音还在，请再试一次保存。');}if(!r.ok)throw Error(d.error||'暂时没有保存好，请再试一次。');return d;}
 window.createReadingRecorder=({render,toast,uuid,saveText})=>{
  const clock=new ReadingClock();let meta,mode='starting',recorder,stream,previewUrl,interval,wake,saveChain=Promise.resolve(),uploading,ending=false,lastMetaAt=0;
  const pause=$('pause-reading'),button=$('record'),status=$('record-status'),timer=$('reading-timer');
  const format=ms=>{const n=Math.floor(Math.min(MAX_MS,ms)/1000);return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');};
  function ui(message){
   if(message)status.textContent=message;
   const active=mode==='recording'||mode==='paused';
   button.textContent=active?'读完了，停下来':mode==='ready'?'重新录一段':'开始一起读书';
   button.disabled=mode==='starting'||mode==='saving';button.classList.toggle('recording',mode==='recording');
   pause.hidden=!active;pause.textContent=mode==='paused'?'继续读书':'暂停一下';
   $('submit-story').disabled=active||mode==='starting'||mode==='saving';$('audio-file').disabled=active||mode==='starting'||mode==='saving';
   timer.hidden=!meta;timer.textContent=format(active?clock.elapsed():meta?.durationMs||0)+' / 20:00';
  }
  async function wakeScreen(){try{if('wakeLock'in navigator&&!document.hidden)wake=await navigator.wakeLock.request('screen');}catch{}}
  function releaseScreen(){wake?.release().catch(()=>{});wake=null;}
  function tick(){
   ui();if(clock.elapsed()>=MAX_MS){stop();return;}
   if(meta&&Date.now()-lastMetaAt>5000){lastMetaAt=Date.now();meta.durationMs=Math.min(MAX_MS,clock.elapsed());putMeta({...meta}).catch(e=>ui(e.message));}
  }
  async function upload(){
   if(uploading)return uploading;
   uploading=(async()=>{
    while(meta&&meta.uploaded<meta.partCount){const current=meta,index=current.uploaded,part=await getPart(current.id,index);if(!part)throw Error('还有一小段没收好，再点保存吧。');
     let error;
     for(let attempt=0;attempt<2;attempt++){try{const r=await fetch('/api/readings/'+current.id+'/chunks/'+index,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:part.blob,signal:AbortSignal.timeout(45000)});if(!r.ok){const d=await r.json();throw Error(d.error||'声音还没有上传好。');}error=null;break;}catch(e){error=e;}}
     if(error)throw error;if(meta!==current)return;current.uploaded=index+1;await putMeta({...current});
    }
   })().finally(()=>{uploading=null;});return uploading;
  }
  function append(blob){if(!blob.size)return;
   saveChain=saveChain.then(async()=>{if(!meta)return;for(let offset=0;offset<blob.size;offset+=PIECE){const index=meta.partCount,part=blob.slice(offset,offset+PIECE);await store('parts','readwrite',s=>s.put({key:partKey(meta.id,index),blob:part}));meta.partCount++;meta.durationMs=Math.min(MAX_MS,clock.elapsed());await putMeta({...meta});}
    upload().catch(()=>{if(mode==='recording')ui('{{petName}}还在听，声音已在这台设备暂存，联网后再上传。');});
   }).catch(e=>{ui(e.message);stop();throw e;});saveChain.catch(()=>{});
  }
  async function preview(){const blobs=[];for(let i=0;i<meta.partCount;i++){const p=await getPart(meta.id,i);if(p)blobs.push(p.blob);}if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(new Blob(blobs,{type:meta.audioType}));const player=$('audio-preview');player.onloadedmetadata=()=>{if(meta&&Number.isFinite(player.duration)){meta.durationMs=Math.min(MAX_MS,player.duration*1000);putMeta({...meta}).catch(()=>{});ui();}};player.src=previewUrl;player.hidden=false;}
  function stop(){
   if(mode!=='recording'&&mode!=='paused')return;
   clock.pause();meta.durationMs=Math.min(MAX_MS,clock.elapsed());clearInterval(interval);releaseScreen();ending=true;
   if(recorder?.state!=='inactive')recorder.stop();mode='saving';ui('正在收好你的录音…');
  }
  async function start(){
   if(meta&&mode==='ready'){if(!confirm('上一段录音还没有保存，要放下它重新录吗？'))return;await uploading?.catch(()=>{});try{await api('/api/readings/'+meta.id+'/discard',{});}catch(e){ui(e.message);return;}await clearDraft(meta);meta=null;}
   if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){
    ui('这个浏览器暂时不能录音。可以点右上角「…」用系统浏览器打开，或先输入文字、上传录音。');
    const textOptions=$('transcript').closest('details');if(textOptions)textOptions.open=true;
    return;
   }
   mode='starting';ui('准备好书，{{petName}}马上开始听。');
   try{
    stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1}});await db();
    if(!$('story-dialog').open){stream.getTracks().forEach(t=>t.stop());mode='idle';ui();return;}
    const mime=['audio/mp4','audio/webm;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));
    recorder=new MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:64000});
    const audioType=(recorder.mimeType||mime||'audio/webm').split(';')[0],actionId=uuid();
    const created=await api('/api/readings',{audioType,actionId});
    meta={id:created.id,actionId,audioType,partCount:0,uploaded:0,durationMs:0};await putMeta(meta);saveChain=Promise.resolve();ending=false;$('transcript').value='';
    recorder.ondataavailable=e=>append(e.data);
    recorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());try{await saveChain;await preview();mode='ready';ui('这一段读书录好啦，点“收好这次读书”就能保存。');}catch{mode='ready';ui('录音还没收好，先别关这一页。');}ending=false;};
    recorder.onerror=()=>{stop();ui('录音中断了，已录的部分会暂存，请先收好。');};
    clock.start();recorder.start(10000);mode='recording';interval=setInterval(tick,500);wakeScreen();ui('{{petName}}正在听，读完后点“读完了，停下来”。');
   }catch(e){
    stream?.getTracks().forEach(t=>t.stop());mode=meta?'ready':'idle';
    if(['NotAllowedError','PermissionDeniedError','SecurityError'].includes(e.name)||/permission denied/i.test(e.message||'')){
     ui('麦克风权限未开启。请在手机设置里允许微信使用麦克风，再打开本页试一次。也可以点右上角「…」用系统浏览器打开，或先输入文字、上传录音。');
     const textOptions=$('transcript').closest('details');if(textOptions)textOptions.open=true;
    }else ui(e.message||'麦克风没有打开，请允许录音后再试。');
   }
  }
  function togglePause(){
   if(mode==='recording'){recorder.pause();clock.pause();mode='paused';releaseScreen();ui('暂停啦，喝口水，准备好再继续。');}
   else if(mode==='paused'){recorder.resume();clock.resume();mode='recording';wakeScreen();ui('{{petName}}继续听你读书。');}
  }
  async function save(){
   if(mode==='recording'||mode==='paused'||mode==='starting'||mode==='saving'||ending)return;
   if(!meta){return saveText();}
   mode='saving';ui('正在收好整段录音，请稍等一下……');
   try{
    await saveChain;await upload();
    const result=await api('/api/readings/'+meta.id+'/finish',{partCount:meta.partCount,durationMs:meta.durationMs});
    const old=meta;meta=null;await clearDraft(old);render(result);mode='idle';$('story-dialog').close();
    $('audio-preview').removeAttribute('src');$('audio-preview').hidden=true;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;
    $('transcript').value='';ui('点一次开始，{{petName}}可以陪你读20分钟。');toast((result.storyReward?.message||'整段录音收好啦！算一次读书。')+' 录音已完整保存，文字会慢慢整理出来。',7000);
   }catch(e){mode='ready';ui('录音还在，再点保存试试。');$('dialog-error').textContent=e instanceof TypeError||e.name==='TimeoutError'?'刚才没连上，录音还在这一页，再点保存即可。':e.message||'暂时没连上，请重试保存。';}
  }
  button.onclick=()=>{if(mode==='recording'||mode==='paused')stop();else start();};pause.onclick=togglePause;$('submit-story').onclick=save;
  $('audio-file').onchange=async()=>{
   const file=$('audio-file').files[0];if(!file)return;
   if(file.size>64*1024*1024||!file.type.startsWith('audio/')){$('dialog-error').textContent='请选20分钟以内、64MB以内的录音。';return;}
   if(meta){$('dialog-error').textContent='请先保存已有的读书录音。';return;}
   mode='starting';ui('正在收好录音…');
   try{const actionId=uuid(),audioType=file.type.split(';')[0],created=await api('/api/readings',{actionId,audioType});meta={id:created.id,actionId,audioType,partCount:0,uploaded:0,durationMs:0};await putMeta(meta);append(file);await saveChain;await preview();mode='ready';ui('录音选好啦，点“收好这次读书”保存。');}catch(e){mode=meta?'ready':'idle';ui(e.message);}
  };
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&mode==='recording'){togglePause();ui('离开页面时先暂停啦，回来后点“继续读书”。');}});
  window.addEventListener('beforeunload',e=>{if(meta){e.preventDefault();e.returnValue='';}});
  getMeta().then(async saved=>{if(saved){meta=saved;mode='ready';await preview();ui('上次的录音还在，先点“收好这次读书”保存吧。');}else{mode='idle';ui();}}).catch(e=>{mode='idle';ui(e.message);});
  ui('点一次开始，{{petName}}可以陪你读20分钟。');
  return {close(){stop();$('story-dialog').close();},isActive:()=>mode==='recording'||mode==='paused'};
 };
})();
