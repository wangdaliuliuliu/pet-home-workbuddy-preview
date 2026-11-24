(()=>{'use strict';const $=id=>document.getElementById(id);let draft={},step=0,busy=false,recording=null;
async function api(kind,data){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);try{const r=await fetch('/api/pet-creation'+(kind?'/'+kind:''),{...(data?{method:'POST',headers:{'Content-Type':data instanceof Blob?'application/octet-stream':'application/json'},body:data instanceof Blob?data:JSON.stringify(data)}:{}),signal:controller.signal});if(r.status===401){location.href='/account?next=/create-pet';throw Error('先登录，再来找宠物吧。')}const text=await r.text();let d;try{d=JSON.parse(text)}catch{throw Error(r.status===504?'服务器刚才等太久了，原图可能已经收好，刷新看看。':'这次没连上，请稍后再试。')}if(!r.ok)throw Error(d.error||'这次还没准备好，再试一次吧。');return d;}catch(e){if(e.name==='AbortError')throw Error('这次等得有点久，刷新看看，已经上传的画不会丢。');throw e}finally{clearTimeout(timer)}}
async function waitImage(d){const started=Date.now();while(['queued','processing'].includes(d.imageStatus)){draft=d;const seconds=Math.floor((Date.now()-(d.imageStartedAt||started))/1000);$('status').textContent=(d.imageStatus==='queued'?'画已经收到，正在排队…':'正在去掉背景…')+' 已等 '+seconds+' 秒';if(Date.now()-started>120000)throw Error('还在准备，原图已收好。稍后刷新看看，不用反复上传。');await new Promise(r=>setTimeout(r,1200));d=await api('');}if(d.imageStatus==='failed')throw Error(d.imageError||'没准备好，点一下再试试。');return d;}
async function preparePicture(file){if(!/^image\//.test(file.type)&&!(/\.(heic|heif|avif|tiff?|bmp|gif|png|jpe?g|webp)$/i.test(file.name)))throw Error('选一张照片或图片吧。');if(file.size>40*1024*1024)throw Error('这张图片太大了，换一张试试。');const url=URL.createObjectURL(file);try{const im=await new Promise((resolve,reject)=>{const i=new Image(),t=setTimeout(()=>reject(Error('正在交给服务器识别这张图片。')),15000);i.onload=()=>{clearTimeout(t);resolve(i)};i.onerror=()=>{clearTimeout(t);reject(Error('正在交给服务器识别这张图片。'))};i.src=url});const ratio=Math.min(1,1600/Math.max(im.naturalWidth,im.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.round(im.naturalWidth*ratio);canvas.height=Math.round(im.naturalHeight*ratio);let ctx=canvas.getContext('2d');ctx.drawImage(im,0,0,canvas.width,canvas.height);let blob=await new Promise(r=>canvas.toBlob(r,'image/png'));if(blob.size>2*1024*1024){ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.9));}canvas.width=canvas.height=1;if(!blob||blob.size>8*1024*1024)throw Error('图片没准备好，换张照片再试试。');return blob;}finally{URL.revokeObjectURL(url)}}
function show(n){if(recording||busy)return;step=n;document.querySelectorAll('[data-panel]').forEach(e=>e.hidden=Number(e.dataset.panel)!==n);document.querySelectorAll('[data-step]').forEach(e=>e.classList.toggle('selected',Number(e.dataset.step)===n));$('status').textContent='';}
function render(){
  const deferVoice=draft.deferVoice===true;
  document.querySelector('[data-step="2"]').hidden=deferVoice;
  document.querySelector('.paper nav').classList.toggle('two-steps',deferVoice);
  document.querySelector('.intro p').textContent=deferVoice?'画好它，给它起个名字。':'画好它，叫叫它，听它说话。';
  $('name-next').textContent=deferVoice?'带它回家 →':'名字起好啦 →';
  if(!deferVoice)renderVoicePresets();if(draft.image){$('pet-picture').src=draft.image;$('pet-picture').hidden=false;$('empty-pet').hidden=true;$('upload-label').textContent='换一张画'}$('pet-tag').textContent=draft.name||'等待认识你';$('pet-name').value=draft.name||'';$('voice-description').textContent=draft.voice?.description||'';if(draft.audio){$('voice-audio').src=draft.audio;$('voice-audio').hidden=false}else{$('voice-audio').hidden=true;$('voice-audio').removeAttribute('src')}$('finish').disabled=!draft.audio||!draft.image||!draft.name;}
async function work(message,fn){if(busy||recording)return;busy=true;$('picture').disabled=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);$('status').textContent=message;try{draft=await fn();render();$('status').textContent='准备好啦！';return true}catch(e){$('status').textContent=e.message;return false}finally{busy=false;$('picture').disabled=false;try{const latest=await api('');draft=latest;render();retryImage.hidden=!latest.canRetryImage||latest.imageStatus==='ready';}catch{}document.querySelectorAll('button').forEach(b=>b.disabled=false);$('finish').disabled=!draft.audio||!draft.image||!draft.name;}}
document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>show(Number(b.dataset.step)));
const base64=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(blob)});
$('picture').onchange=async e=>{const file=e.target.files[0];if(!file)return;await work('正在收好你的画…',async()=>{let blob;try{blob=await preparePicture(file)}catch(e){if(file.size<=8*1024*1024&&(/^image\//.test(file.type)||/\.(heic|heif|avif|tiff?|bmp|gif|png|jpe?g|webp)$/i.test(file.name))){$('status').textContent='正在识别图片，系统会自动转换…';return waitImage(await api('image-file',file));}throw e;}return waitImage(await api('image',{image:await base64(blob),async:true}));});};
const retryImage=document.createElement('button');retryImage.textContent='用刚才的画再试一次';retryImage.hidden=true;$('status').after(retryImage);retryImage.onclick=()=>work('正在重新准备…',async()=>waitImage(await api('retry-image',{async:true})));
$('image-next').onclick=()=>{if(!draft.image){$('status').textContent='先选一张宠物的画吧。';return}show(1)};
$('name-next').onclick=async()=>{
 const input=$('pet-name'),name=input.value.trim();
 if(!name){$('status').textContent='先给宠物起个名字吧。';input.focus();return}
 if(await work('记下名字…',()=>api('draft',{name}))){if(draft.deferVoice)await finishCreation();else show(2);}
};
function voiceChanged(){delete draft.audio;$('voice-audio').pause();$('voice-audio').hidden=true;$('finish').disabled=true;}
function renderVoicePresets(){
 const presets=$('voice-presets');
 if(presets.children.length||!draft.voices?.length)return;
 const initial=draft.voice?.voice||draft.voices[0].id;
 for(const [gender,title] of [['female','女孩童声'],['male','男孩童声']]){
  const group=document.createElement('fieldset'),legend=document.createElement('legend');
  legend.textContent=title;group.append(legend);
  for(const voice of draft.voices.filter(item=>item.gender===gender)){
   const label=document.createElement('label'),radio=document.createElement('input');
   radio.type='radio';radio.name='voice-preset';radio.value=voice.id;radio.checked=voice.id===initial;
   radio.onchange=()=>{$('voice-words').value='';voiceChanged();};
   label.append(radio,voice.name);group.append(label);
  }
  presets.append(group);
 }
}
$('voice-words').addEventListener('input',voiceChanged);
document.querySelectorAll('[data-voice]').forEach(b=>b.onclick=()=>{$('voice-words').value=b.dataset.voice;voiceChanged();});
$('listen').onclick=async()=>{
 if(!draft.name){$('status').textContent='先给新朋友起个名字吧。';return}
 const text=$('voice-words').value.trim();
 const preset=$('voice-presets').querySelector(':checked')?.value;
 const ok=await work('正在准备试听…',async()=>{
  if(text){
   const matched=await api('understand',{field:'voice',text});
   for(const radio of $('voice-presets').querySelectorAll('input'))radio.checked=radio.value===matched.voice?.voice;
   return api('listen',{});
  }
  return api('listen',preset?{preset}:{});
 });
 if(ok)$('voice-audio').play().catch(()=>{});
};
async function finishCreation(){if(await work('正在带它回家…',()=>api('finish',{}))){document.querySelector('.creation').hidden=true;document.querySelector('.intro').hidden=true;$('welcome').hidden=false;$('welcome-title').textContent=draft.name+'，欢迎来到我的小世界！';}}
$('finish').onclick=finishCreation;
let pendingVoice=null;const retryVoice=document.createElement('button');retryVoice.hidden=true;retryVoice.textContent='用刚才的录音再试一次';$('status').after(retryVoice);
async function usePendingVoice(){if(!pendingVoice)return;const saved=pendingVoice;return work('正在把声音变成文字…',async()=>{if(saved.blob.size<100||saved.blob.size>2*1024*1024){pendingVoice=null;retryVoice.hidden=true;throw Error('这段录音太短或太长，再说一段吧。');}if(!saved.text){let r;try{r=await fetch('/api/voice/transcribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audio:await base64(saved.blob),audioType:saved.blob.type}),signal:AbortSignal.timeout(85000)});}catch{throw Error('刚才网络没连上，录音还在这一页。点“用刚才的录音再试一次”。');}let d;try{d=JSON.parse(await r.text())}catch{throw Error('服务器刚才没接上，录音还在这一页，可以点一下重试。');}if(!r.ok){if(r.status===422||/没听到声音|没有声音|靠近手机/.test(d.error||'')){pendingVoice=null;retryVoice.hidden=true;throw Error('这段没听到清楚的人声，靠近话筒说几秒再试。');}throw Error(d.error||'声音还没变成文字，录音保留着，可以点一下重试。');}saved.text=saved.field==='name'?d.text.trim().replace(/[。．.!！?？,，;；:：、…]+$/u,'').trim():d.text;}if(saved.field==='voice')$('voice-words').value=saved.text;const next=await api('understand',{field:saved.field,text:saved.text});pendingVoice=null;retryVoice.hidden=true;return next;});}
retryVoice.onclick=usePendingVoice;
function microphoneMeter(stream,button){
 const box=document.createElement('div');box.className='mic-meter';box.innerHTML='<svg viewBox="0 0 360 52" preserveAspectRatio="none" aria-hidden="true"><path d="M0 26 H360"/></svg><span role="status">正在听，试着说句话吧</span>';button.after(box);
 const line=box.querySelector('path'),label=box.querySelector('span');let context,source,frame,closed=false,lastLabel='';
 const stop=()=>{if(closed)return;closed=true;cancelAnimationFrame(frame);try{source?.disconnect();context?.close().catch(()=>{});}catch{}box.remove();};
 try{const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio){label.textContent='正在录音，说完点上面的按钮';return stop}context=new Audio();const analyser=context.createAnalyser();analyser.fftSize=1024;source=context.createMediaStreamSource(stream);source.connect(analyser);const data=new Uint8Array(analyser.fftSize);context.resume().catch(()=>{});
 const draw=()=>{if(closed)return;analyser.getByteTimeDomainData(data);let sum=0;for(const value of data)sum+=((value-128)/128)**2;const active=Math.sqrt(sum/data.length)>.012;let path='';for(let i=0;i<=120;i++){const value=active?(data[Math.min(data.length-1,Math.floor(i*data.length/121))]-128)/128:0;path+=(i?' L':'M')+(i*3)+' '+(26-Math.max(-22,Math.min(22,value*95))).toFixed(1)}line.setAttribute('d',path);box.classList.toggle('has-sound',active);const text=active?'收到声音啦，继续说吧':'这里很安静，靠近话筒说句话吧';if(text!==lastLabel){label.textContent=text;lastLabel=text}frame=requestAnimationFrame(draw)};draw();return stop;
 }catch{try{source?.disconnect();context?.close().catch(()=>{});}catch{}label.textContent='正在录音，说完点上面的按钮';return stop}
}
document.querySelectorAll('[data-record]').forEach(button=>button.onclick=async()=>{
 if(recording){if(recording.button===button)recording.rec.stop();return}if(busy)return;
 if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){$('status').textContent='话筒暂时用不了，可以直接写下来。';return}
 try{const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}}),rec=new MediaRecorder(stream,{audioBitsPerSecond:32000}),chunks=[],field=button.dataset.record;recording={rec,stream,button,stopMeter:microphoneMeter(stream,button)};button.classList.add('recording');button.textContent='■ 说完了';$('status').textContent='我在听，说完点一下。';const timer=setTimeout(()=>rec.state==='recording'&&rec.stop(),300000);rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};rec.onstop=async()=>{clearTimeout(timer);recording?.stopMeter();stream.getTracks().forEach(t=>t.stop());recording=null;button.classList.remove('recording');button.textContent=field==='name'?'🎙 再说一次名字':'🎙 描述一下它说话的声音';const blob=new Blob(chunks,{type:rec.mimeType});pendingVoice={field,blob,text:null};retryVoice.hidden=false;await usePendingVoice();};rec.start();}catch{if(recording){recording.stopMeter();recording.stream.getTracks().forEach(t=>t.stop());recording.button.classList.remove('recording');recording.button.textContent='🎙 再说一次';recording=null}$('status').textContent='话筒没能打开，可以先写下来。';}
});
window.addEventListener('pagehide',()=>{if(recording){recording.rec.onstop=null;recording.stopMeter();recording.stream.getTracks().forEach(t=>t.stop())}});
api('').then(async d=>{draft=d;if(['queued','processing'].includes(d.imageStatus)){await work('正在准备你的画…',()=>waitImage(d));d=draft;}retryImage.hidden=!d.canRetryImage||d.imageStatus==='ready';if(d.imageError)$('status').textContent=d.imageError;if(d.complete){document.querySelector('.creation').hidden=true;document.querySelector('.intro').hidden=true;$('welcome').hidden=false;$('welcome-title').textContent='你的朋友已经在家等你啦';return}render();show(d.image?(d.name&&!d.deferVoice?2:1):0);if(d.imageError)$('status').textContent=d.imageError}).catch(e=>{$('status').textContent=e.message});})();
