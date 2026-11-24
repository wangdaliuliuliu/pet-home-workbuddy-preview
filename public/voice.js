(() => {
  const el = id => document.getElementById(id);
  const chip = document.createElement('button'); chip.className = 'chat-chip'; chip.textContent = '♡ 和{{petName}}聊天'; chip.setAttribute('aria-label', '和{{petName}}聊天'); el('scene').append(chip);
  let caps = {}, stream, recorder, recording = false, busy = false, audioUrl, timeout, requestController, session = 0;
  let nextBefore = null, historyController, capabilitiesRequest;
  const spokenProactive = new Set();
  const unreadBadge=document.createElement('span');
  unreadBadge.hidden=true;
  unreadBadge.setAttribute('aria-hidden','true');
  unreadBadge.style.cssText='position:absolute;right:-3px;top:-3px;width:11px;height:11px;border-radius:50%;background:#e54860;border:2px solid #fff;box-shadow:0 1px 4px #0002';
  chip.append(unreadBadge);
  function showUnread(data){
    unreadBadge.hidden=!data.count;
    chip.setAttribute('aria-label','和'+(window.pet?.name||'宠物')+'聊天'+(data.count?'，有未读消息':''));
  }
  let unreadPolling=false;
  async function refreshUnread(){
    if(document.hidden||unreadPolling)return;
    unreadPolling=true;
    try{
      const data=await chatJson('/api/chat/unread');
      showUnread(data);
      if(data.count&&el('chat-dialog').open&&!busy&&!recording)await loadHistory(session);
    }catch{}finally{unreadPolling=false;}
  }
  setInterval(refreshUnread,15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshUnread();});
  window.addEventListener('focus',refreshUnread);
  refreshUnread();

  let playedReplyId = null;
  const chatAudio = el('chat-audio');
  chatAudio.addEventListener('ended', () => { playedReplyId = chatAudio.dataset.replyId || null; });
  window.addEventListener('pet-companion-language', () => {
    playedReplyId = null;
    delete chatAudio.dataset.replyId;
    if (!caps.voiceSettings && el('chat-dialog').open) close();
  });
  let speechController;
  const retrySpeech = document.createElement('button');
  retrySpeech.type = 'button'; retrySpeech.className = 'secondary-button';
  retrySpeech.textContent = '再试一次声音'; retrySpeech.hidden = true;
  const adjustSpeech=document.createElement('button');
  adjustSpeech.type='button';adjustSpeech.className='secondary-button';adjustSpeech.textContent='声音设置';adjustSpeech.hidden=true;
  adjustSpeech.onclick=()=>window.petCompanionUI?.open();
  el('chat-status').after(retrySpeech,adjustSpeech);
  let selectedPhoto=null,uploadedPhoto=null,uploadActionId=null,referencePhoto=null,previewUrl=null;
  const photoTools=document.createElement('div');photoTools.className='chat-photo-tools';photoTools.innerHTML='<button type="button" class="secondary-button" id="chat-camera">📷 拍照</button><button type="button" class="secondary-button" id="chat-album">🖼 发图片</button>';
  const camera=document.createElement('input'),album=document.createElement('input');for(const input of [camera,album]){input.type='file';input.accept='image/*';input.hidden=true;photoTools.append(input);}camera.setAttribute('capture','user');
  const preview=document.createElement('div');preview.className='photo-preview';preview.hidden=true;preview.innerHTML='<img alt="待发送照片"><label><input type="checkbox" id="photo-is-me"> 这是我<br><small>点一下，告诉它照片里是你。</small></label><button type="button" aria-label="取消照片">×</button>';
  const reference=document.createElement('div');reference.className='photo-reference';reference.hidden=true;
  const tripBanner=document.createElement('div');tripBanner.className='trip-banner';
  el('chat-form').before(photoTools,preview,reference);el('chat-messages').before(tripBanner);
  const viewer=document.createElement('dialog');viewer.className='game-dialog photo-viewer';viewer.innerHTML='<div class="dialog-top"><span class="tiny-label">{{petName}}的小相册</span><button class="close-button" aria-label="关闭照片">×</button></div><img alt="照片大图"><p class="dialog-copy"></p><button class="secondary-button photo-view-cite">聊聊这张照片</button>';document.body.append(viewer);viewer.querySelector('.close-button').onclick=()=>viewer.close();
  function openPhoto(photo){viewer.querySelector('img').src=photo.url;viewer.querySelector('p').textContent=photo.caption||'我们分享的照片';viewer.querySelector('.photo-view-cite').onclick=()=>{viewer.close();if(!el('chat-dialog').open)chip.onclick().then(()=>cite(photo));else cite(photo);};viewer.showModal();}
  el('chat-camera').onclick=()=>camera.click();el('chat-album').onclick=()=>album.click();
  function clearPhoto(){selectedPhoto=null;uploadedPhoto=null;uploadActionId=null;preview.hidden=true;camera.value=album.value='';if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;}
  preview.querySelector('button').onclick=clearPhoto;
  function selectPhoto(input){const file=input.files?.[0];if(!file)return;if(file.size>8*1024*1024){el('chat-error').textContent='选一张8MB以内的照片吧。';return;}clearPhoto();selectedPhoto=file;uploadActionId=uuid();previewUrl=URL.createObjectURL(file);preview.querySelector('img').src=previewUrl;el('photo-is-me').checked=false;preview.hidden=false;referencePhoto=null;reference.hidden=true;}
  camera.onchange=()=>selectPhoto(camera);album.onchange=()=>selectPhoto(album);
  function cite(photo){referencePhoto=photo;reference.hidden=false;reference.replaceChildren(document.createTextNode('正在聊这张照片：'+(photo.caption||'照片').slice(0,35)));const cancel=document.createElement('button');cancel.textContent='×';cancel.type='button';cancel.onclick=()=>{referencePhoto=null;reference.hidden=true;};reference.append(cancel);el('chat-text').focus();}
  function bubble(m){const p=document.createElement('article');p.className='chat-bubble '+(m.role==='user'?'my-message':'pet-reply');p.textContent=m.content;p.dataset.messageId=m.id||'';if(m.proactive&&m.role==='assistant'){
      const listen=document.createElement('button');listen.type='button';listen.className='secondary-button';listen.textContent='听它说';
      listen.setAttribute('aria-label','朗读这条主动话题');
      listen.onclick=async()=>{if(busy||recording)return;const turn=session;await refreshCapabilities().catch(()=>{});if(turn===session&&!busy&&!recording&&el('chat-dialog').open)await playReply(m.content,turn,m.actionId||m.id);};
      p.append(document.createElement('br'),listen);
    }if(m.referencePhoto){const quote=document.createElement('button');quote.type='button';quote.className='secondary-button';quote.textContent='↪ 刚才的照片';quote.onclick=()=>openPhoto(m.referencePhoto);p.append(quote);}const travelPhotos=(m.photos||[]).filter(photo=>photo.kind==='trip');if(travelPhotos.length){const gallery=document.createElement('div');gallery.className='travel-chat-photos';for(const photo of travelPhotos){const button=document.createElement('button');button.type='button';button.setAttribute('aria-label',photo.caption);const image=document.createElement('img');image.src=photo.url;image.alt=photo.caption;image.loading='lazy';button.append(image);button.onclick=()=>window.travelUI?.open(photo.date);gallery.append(button);}const listen=document.createElement('button');listen.type='button';listen.className='secondary-button travel-chat-listen';listen.dataset.identityUi='';listen.textContent='听{{petName}}讲这段旅行';listen.onclick=()=>window.travelUI?.open(travelPhotos[0].date);p.append(gallery,listen);}for(const photo of (m.photos||[]).filter(photo=>photo.kind!=='trip')){const image=document.createElement('img');image.className='chat-photo';image.src=photo.url;image.alt=photo.caption||'聊天照片';image.loading='lazy';image.onclick=()=>openPhoto(photo);const button=document.createElement('button');button.type='button';button.className='secondary-button';button.textContent='聊聊这张照片';button.onclick=()=>cite(photo);p.append(image,button);}return p;}
  async function preparePhoto(file){const image=await createImageBitmap(file);const scale=Math.min(1,1600/Math.max(image.width,image.height));const c=document.createElement('canvas');c.width=Math.round(image.width*scale);c.height=Math.round(image.height*scale);const context=c.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,c.width,c.height);context.drawImage(image,0,0,c.width,c.height);image.close();return await new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error('照片没有读出来。')),'image/jpeg',.9));}
  function updateTrip(state){const t=state.trip;if(!t)return;tripBanner.replaceChildren();const text=document.createElement('div');text.textContent=t.status==='ready'?`{{petName}}今天去了${t.place}，带回两张照片啦！`:t.status==='generating'?`{{petName}}正在${t.place}玩，照片准备中……`:t.status==='failed'?t.error:t.eligible?'{{petName}}今天会带回两张旅行照片。':'今天先在小屋玩。今天讲个故事，明天{{petName}}就能带回旅行照片。';tripBanner.append(text);
    const next=state.storyPreparation;
    if(next){const notice=document.createElement('p');notice.textContent=next.status==='ready'?'明天的故事已经做好啦，零点后可以看。':next.status==='failed'?`明天的故事还没做好${next.stage?'（'+next.stage+'）':''}，已经准备好的内容会保留。`:'宠物正在准备明天的故事。';tripBanner.append(notice);}
    if(t.photos?.length){const button=document.createElement('button');button.type='button';button.textContent=t.story?.title?'听《'+t.story.title+'》':'打开旅行小故事';button.onclick=()=>window.travelUI?.open(t.date);tripBanner.append(button);}
    if(t.status==='failed'||next?.status==='failed'){const retry=document.createElement('button');retry.textContent='继续准备故事';retry.onclick=async()=>{retry.disabled=true;try{await mutate('/api/trip/retry',{actionId:uuid()});}catch(e){el('chat-error').textContent=e.message;}finally{retry.disabled=false;}};tripBanner.append(retry);}
  }
  window.chatUI={updateTrip,openPhoto};
  const older = document.createElement('button'); older.className = 'secondary-button'; older.textContent = '看看更早的聊天'; older.hidden = true; el('chat-messages').before(older);
  async function chatJson(route, options = {}, controller = new AbortController()) {
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(route, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error('Chat request failed (' + response.status + ')');
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  function refreshCapabilities() {
    if (!capabilitiesRequest) {
      capabilitiesRequest = chatJson('/api/capabilities').then(data => { caps = data; })
        .finally(() => { capabilitiesRequest = null; });
    }
    return capabilitiesRequest;
  }
  refreshCapabilities().catch(() => {});
  async function showMissingVoiceServices(currentSession) {
    const missing=[!caps.transcriptionConfigured&&'录音转文字',!caps.chatConfigured&&'陪聊'].filter(Boolean);
    const target=el('chat-error');
    target.textContent=missing.join('和')+'还没接通。'+(caps.chatConfigured?'你可以先打字。':'接通陪聊后就能发消息。');
    if(!['localhost','127.0.0.1','[::1]'].includes(location.hostname))return;
    try{
      const response=await fetch('/api/portable/settings',{signal:AbortSignal.timeout?.(3500)});
      if(!response.ok||currentSession!==session||!el('chat-dialog').open)return;
      const link=document.createElement('a');link.href='/setup';link.textContent='打开本地服务设置';
      target.append(' ',link);
    }catch{}
  }
  function controls() { el('chat-send').disabled = busy || recording; el('chat-text').disabled = busy || recording; el('chat-record').disabled = busy; el('chat-camera').disabled=busy||recording;el('chat-album').disabled=busy||recording;el('photo-is-me').disabled=busy||recording;preview.querySelector('button').disabled=busy||recording; }
  function message(text, mine) { const p = document.createElement('p'); p.className = 'chat-bubble ' + (mine ? 'my-message' : 'pet-reply'); p.textContent = text; el('chat-messages').append(p); el('chat-messages').scrollTop = el('chat-messages').scrollHeight; }
  function status(text) { el('chat-status').textContent = text; }
  async function api(route, body) { const res = await fetch('/api/voice/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: requestController.signal }); let result; try { result = await res.json(); } catch (error) { if (route === 'chat' && res.ok && error.name !== 'AbortError') window.zuanzuanHealthReport?.('chat_response'); throw error; } if (!res.ok) {const requestId=result.requestId||res.headers.get('X-Request-ID');throw Object.assign(new Error((result.error||'刚才没有听清，再试一次吧。')+(requestId?'（反馈编号：'+requestId+'）':'')),{requestId,code:result.code,stage:result.stage});} if (route === 'chat' && (typeof result?.reply !== 'string' || !result.reply.trim())) { window.zuanzuanHealthReport?.('chat_response'); throw new Error('这次没收到宠物的回答，请再试一次。'); } return result; }
  async function loadHistory(currentSession, earlier = false) {
    if (historyController || busy || recording || (earlier && nextBefore === null)) return;
    const controller = new AbortController();
    historyController = controller;
    older.disabled = true;
    try {
      const data = await chatJson('/api/chat/history' + (earlier ? '?before=' + nextBefore : ''), {}, controller);
      if (historyController !== controller || currentSession !== session || !el('chat-dialog').open) return;
      const area = el('chat-messages'), fragment = document.createDocumentFragment();
      for (const m of data.messages) fragment.append(bubble(m));
      const height = area.scrollHeight;
      if (earlier) { area.prepend(fragment); area.scrollTop += area.scrollHeight - height; }
      else {
        area.replaceChildren(fragment);
        if (!data.messages.length) {
          const greeting = { zh:'想聊聊今天读的书，还是别的有趣事情？', mixed:'Hi there! 今天有什么好玩的事吗？', en:'Hi! What did you do today?' };
          message(greeting[data.mode] || greeting.zh, false);
        }
        area.scrollTop = area.scrollHeight;
      }
      nextBefore = data.nextBefore; older.hidden = nextBefore === null;
      const newest = data.messages.at(-1);
      if (!earlier && !document.hidden) {
        if (newest?.proactive && newest.unread && !spokenProactive.has(newest.id)) {
          void refreshCapabilities().catch(() => {}).then(() => {
            if (session !== currentSession || !el('chat-dialog').open || document.hidden || busy || recording || spokenProactive.has(newest.id)) return;
            spokenProactive.add(newest.id);
            return playReply(newest.content, currentSession, newest.actionId || newest.id);
          });
        }
        const last = data.messages.filter(message => message.proactive && message.unread).at(-1);
        if (last) {
          void chatJson('/api/chat/unread', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: last.id })
          }).then(result => { if (session === currentSession) showUnread(result); }).catch(() => {});
        }
      }
    } catch {
      if (currentSession === session && historyController === controller && !el('chat-error').textContent) {
        el('chat-error').textContent = '之前的聊天暂时没加载出来，你可以继续聊，或者重新打开再试。';
      }
    } finally {
      if (historyController === controller) cancelHistory();
    }
  }
  function cancelHistory() {
    historyController?.abort();
    historyController = null;
    older.disabled = false;
  }
  chip.onclick = async () => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id === 'story-dialog') closeStory(); else d.close(); });
    el('chat-dialog').showModal(); el('chat-error').textContent = caps.chatConfigured !== false ? '' : '还不能聊天，请找老师帮忙。';
    if(caps.voiceSettings&&caps.chatConfigured){
      const turn=session;
      fetch('/api/companion/voice/readiness',{signal:AbortSignal.timeout?.(1600)}).then(async r=>{
        if(!r.ok)return;
        const {notice}=await r.json();
        if(turn===session&&el('chat-dialog').open&&!el('chat-error').textContent&&notice)el('chat-error').textContent=notice;
      }).catch(()=>{});
    }
    if(pet)updateTrip(pet);
    controls();
    void refreshCapabilities().catch(() => {});
    void loadHistory(session);
  };
  older.onclick = () => loadHistory(session, true);
  function stop() { clearTimeout(timeout); if (recording && recorder?.state === 'recording') recorder.stop(); recording = false; el('chat-record').classList.remove('recording'); el('chat-record').textContent = '开始说话'; }
  function close() { session++; requestController?.abort(); speechController?.abort(); speechController = null; retrySpeech.hidden=true; adjustSpeech.hidden=true; stop(); stream?.getTracks().forEach(t => t.stop()); chatAudio.pause(); playedReplyId=null; delete chatAudio.dataset.replyId; busy = false; cancelHistory(); clearPhoto();referencePhoto=null;reference.hidden=true;controls(); el('chat-dialog').close(); }
  el('close-chat').onclick = close;
  el('chat-dialog').addEventListener('cancel', close);
  el('chat-dialog').addEventListener('close', () => { if (!el('chat-dialog').open && (recording || busy || historyController || speechController)) close(); });
  async function playReply(text, currentSession, replyId) {
    if (session !== currentSession || !el('chat-dialog').open) return;
    speechController?.abort();
    const playback = new AbortController();
    speechController = playback;
    retrySpeech.hidden = true;
    adjustSpeech.hidden=true;
    chatAudio.pause();
    playedReplyId = null;
    delete chatAudio.dataset.replyId;
    if (!caps.speechConfigured && !caps.voiceSettings) { status('文字回答已经收好，声音服务还没接通。'); return; }
    status('{{petName}}准备开口啦……');
    const retry = () => { if (speechController === playback) playReply(text,currentSession,replyId); };
    try {
      const signal = caps.voiceSettings&&AbortSignal.any&&AbortSignal.timeout?AbortSignal.any([playback.signal,AbortSignal.timeout(30000)]):playback.signal;
      const res = await fetch('/api/voice/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text}),signal});
      if (!res.ok) {
        const result = await res.json();
        throw Object.assign(new Error(result.error),{code:result.code});
      }
      const ownKey=res.headers.get('X-Pet-Voice-Source')==='own-key';
      const free=res.headers.get('X-Pet-Voice-Source')==='free-while-syncing';
      const blob = await res.blob();
      if (playback.signal.aborted || session !== currentSession) return;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(blob);
      chatAudio.src = audioUrl; chatAudio.dataset.replyId = replyId; chatAudio.hidden = false;
      try { await chatAudio.play(); if (!playback.signal.aborted) status(ownKey?'平台额度不足，已用自己的百炼 Key 朗读。':free?'账号同步前，先用免费声音朗读。':'{{petName}}在和你说话。'); }
      catch { if (!playback.signal.aborted) status(ownKey?'已用自己的百炼 Key 生成。点一下播放。':'点一下播放，听它的回答。'); }
    } catch(error) {
      if (playback.signal.aborted || session !== currentSession) return;
      status('回答已经显示。'+(error.name==='TimeoutError'?'这次声音等得有点久，可以重试。':error.message||'声音暂时没有播放出来。'));
      if (caps.voiceSettings) {
        retrySpeech.hidden=false; retrySpeech.onclick=retry;
        adjustSpeech.hidden=!['voice_setup','voice_points'].includes(error.code);
      }
    }
  }
  async function reply(text, currentSession, spoken = false, heardReplyId = null) {
    cancelHistory();
    if (caps.voiceSettings) { speechController?.abort(); retrySpeech.hidden=true; adjustSpeech.hidden=true; chatAudio.pause(); }
    status(selectedPhoto?'照片保存中，{{petName}}在看一看……':'{{petName}}在想一想……');
    if(selectedPhoto&&!uploadedPhoto){const prepared=await preparePhoto(selectedPhoto);const response=await fetch('/api/photos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:await toBase64(prepared),selfLabeled:el('photo-is-me').checked,actionId:uploadActionId}),signal:requestController.signal});const data=await response.json();if(!response.ok)throw Error(data.error);if(session!==currentSession)return;uploadedPhoto=data.photo;}
    const photo=uploadedPhoto,ref=referencePhoto;const messageText=text||(photo?.selfLabeled?'这是我，看看我今天的照片吧！':'{{petName}}，看看这张照片吧！');
    const actionId = uuid();
    const result=await api('chat',{message:messageText,spoken,actionId,heardReplyId,...(photo?{photoId:photo.id}:ref?{referencePhotoId:ref.id}:{})});if(session!==currentSession)return;
    el('chat-messages').append(bubble({role:'user',content:messageText,photos:photo?[photo]:[]}));clearPhoto();referencePhoto=null;reference.hidden=true;message(result.reply,false);if(result.degraded){el('chat-text').value=messageText;el('chat-error').textContent='这次回答没有准备好，原话已经保留，点发送再试一次。反馈编号：'+result.requestId;}el('speech').textContent=result.reply.length>23?result.reply.slice(0,22)+'…':result.reply;
    const playback=playReply(result.reply,currentSession,actionId);
    if (!caps.voiceSettings) await playback;
    return !result.degraded;
  }
  el('chat-form').onsubmit = async event => { event.preventDefault(); const text = el('chat-text').value.trim(); if ((!text&&!selectedPhoto&&!referencePhoto) || busy || recording) return; busy = true; controls(); el('chat-error').textContent = ''; requestController = new AbortController(); const currentSession = session; try { const answered=await reply(text, currentSession); if (session === currentSession&&answered) el('chat-text').value = ''; } catch(e) { if (session === currentSession && e.name !== 'AbortError') { el('chat-error').textContent = e instanceof TypeError?'刚才网络没有接上，请再点一次。':e.message || '暂时没有接上，请再试一次。'; status(''); } } finally { if (session === currentSession) { busy = false; controls(); } } };
  el('chat-record').onclick = async () => {
    if (recording) { stop(); return; } if (busy) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { el('chat-error').textContent = '话筒打不开，请找老师帮忙。'; return; }
    const openedSession=session;
    busy=true;controls();
    try { await refreshCapabilities(); }
    catch {
      if(openedSession===session)el('chat-error').textContent='暂时没法确认语音服务，请刷新页面再试。';
      return;
    } finally {
      if(openedSession===session){busy=false;controls();}
    }
    if(openedSession!==session||!el('chat-dialog').open)return;
    if(!caps.transcriptionConfigured||!caps.chatConfigured){await showMissingVoiceServices(openedSession);return;}
    el('chat-error').textContent = ''; busy = true; controls(); chatAudio.pause(); const currentSession = session;
    const heardReplyId = playedReplyId;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session !== currentSession || !el('chat-dialog').open) { stream.getTracks().forEach(t => t.stop()); return; }
      const chunks = []; const currentStream = stream; recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        currentStream.getTracks().forEach(t => t.stop()); if (session !== currentSession) return;
        busy = true; controls(); status('把你的声音变成文字……'); requestController = new AbortController();
        let transcript = '';
        try {
          const blob = new Blob(chunks, {type: recorder.mimeType || 'audio/webm'});
          const result = await api('transcribe', {audio: await toBase64(blob), audioType: blob.type});
          if (session !== currentSession) return;
          transcript = result.text;
          await reply(transcript, currentSession, true, heardReplyId);
        } catch (error) {
          if (session !== currentSession || error.name === 'AbortError') return;
          const input = el('chat-text');
          if (transcript) {
            input.value = [input.value.trim(), transcript].filter(Boolean).join(' ');
            el('chat-error').textContent = '这次没收到回复，语音已经转成文字。点发送再试一次。'+(error.requestId?'反馈编号：'+error.requestId:'');
          } else {
            el('chat-error').textContent = error instanceof TypeError
              ? '刚才网络没有接上，可以先打字继续聊天。'
              : error.message || '这次没有听清，试试再说一次。';
          }
          status('');
        }
        finally { if (session === currentSession) { busy = false; controls(); } }
      };
      recorder.onerror = () => { stop(); currentStream.getTracks().forEach(t => t.stop()); el('chat-error').textContent = '这次录音没完成，请再试一次。'; };
      recorder.start(); recording = true; busy = false; controls(); el('chat-record').classList.add('recording'); el('chat-record').textContent = '讲完啦，停一下'; status('我在听，讲完再点一下按钮。'); timeout = setTimeout(stop, 60000);
    } catch { stream?.getTracks().forEach(t => t.stop()); el('chat-error').textContent = '麦克风没有打开，请允许录音后再试。'; busy = false; controls(); }
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden && recording) close(); });
})();
