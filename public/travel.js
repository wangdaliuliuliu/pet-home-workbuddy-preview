(() => {
  const dialog = document.createElement('dialog');
  dialog.id = 'travel-dialog';dialog.className = 'game-dialog travel-dialog';
  dialog.setAttribute('aria-labelledby','travel-title');
  dialog.innerHTML = `<header class="dialog-top"><span class="tiny-label">{{petName}}的旅行小信</span><button type="button" class="close-button" aria-label="关闭旅行故事">×</button></header>
    <div class="travel-heading"><p class="travel-place"></p><h2 id="travel-title">路上的小故事</h2></div>
    <figure class="travel-moment"><button type="button" class="travel-photo-open" aria-label="放大这个旅行瞬间"><img alt="{{petName}}的旅行瞬间"></button><figcaption></figcaption></figure>
    <nav class="travel-pages" aria-label="旅行照片"><button type="button" class="travel-prev" aria-label="上一张照片">‹</button><span class="travel-page-count" aria-live="polite"></span><button type="button" class="travel-next" aria-label="下一张照片">›</button></nav>
    <button type="button" class="travel-listen"><svg aria-hidden="true"><use href="#i-sound"/></svg><span>听{{petName}}讲</span></button>
    <button type="button" class="secondary-button travel-original" hidden>打开原版</button>
    <p class="travel-status" role="status"></p><audio class="travel-audio" preload="none"></audio>
    <details class="travel-reading"><summary>读这段小故事 <span>⌄</span></summary><div class="travel-prose"></div></details>
    <details class="travel-archive"><summary>以前的旅行 <span>⌄</span></summary><label for="travel-select">选一段小回忆</label><select id="travel-select"></select></details>`;
  document.body.append(dialog);
  const find = selector => dialog.querySelector(selector), listen = find('.travel-listen'), audio = find('audio'), original = find('.travel-original');
  const shelf = document.createElement('section');shelf.className='travel-story-list';shelf.hidden=true;
  shelf.setAttribute('aria-label','宠物发的旅行故事');
  document.getElementById('stories').before(shelf);
  const storyButton=document.getElementById('show-stories');
  const badge=document.createElement('span');badge.className='travel-unread-count';badge.hidden=true;badge.setAttribute('aria-hidden','true');storyButton.append(badge);
  let current, moment=0, session=0, controller, playing=false, loading=false, replay=false, sourceIndex=-1;
  let clip=0, clipCount=1;
  let archive=[], archiveKey='', readKey='', lastRefresh=0, lastTrip='', refreshing;
  const seen=new Set();
  function readStorage(){
    if(!readKey)return;
    try{const saved=JSON.parse(localStorage.getItem(readKey)||'[]');if(Array.isArray(saved))for(const date of saved)if(typeof date==='string')seen.add(date);}catch{}
  }
  const account=fetch('/api/auth/me').then(r=>r.ok?r.json():null).then(data=>{
    if(data?.user?.id){readKey='zuanzuan-travel-read:'+data.user.id;readStorage();renderShelf();}
  }).catch(()=>{});
  function unread(trip){return trip.status==='ready'&&!!(trip.title||trip.story?.title)&&!seen.has(readItemKey(trip));}
  // 串门故事和旅行故事进同一个故事本：字段对齐成同一形状，只是多一个 visit 标记。
  function asStoryTrip(item){
    return {date:item.storyDate,place:item.place,title:item.title,photos:item.photos||[],story:item.story||null,status:item.status,error:item.error||'',edition:item.edition,originalAvailable:item.originalAvailable,visit:{id:item.id,role:item.role,otherPet:item.otherPet}};
  }
  function itemKey(trip){return trip.visit?'visit:'+trip.visit.id:trip.date;}
  function readItemKey(trip){return trip.visit ? itemKey(trip) : 'trip:'+trip.date;}
  function saveRead(){if(readKey)try{localStorage.setItem(readKey,JSON.stringify([...seen]));}catch{}}
  function migrateReadDates(){
    let changed=false;
    for(const date of seen){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))continue;
      const onDate=archive.filter(trip=>trip.date===date);
      if(!onDate.length)continue;
      // A date alone cannot tell us which of several stories was opened.
      if(onDate.length===1)seen.add(readItemKey(onDate[0]));
      seen.delete(date);changed=true;
    }
    if(changed)saveRead();
  }
  function visitTag(trip){
    if(!trip.visit)return '';
    return trip.visit.role==='requester'?`你去${trip.visit.otherPet}家串门`:`${trip.visit.otherPet}来你家串门`;
  }
  function optionLabel(trip){return trip.date+' · '+(trip.visit?visitTag(trip)+' · ':'')+(trip.title||trip.place)+(unread(trip)?' · NEW':'');}
  function renderShelf(){
    const count=archive.filter(unread).length;
    badge.hidden=!count;badge.textContent=count>99?'99+':String(count);
    storyButton.setAttribute('aria-label',count?`故事本，${count} 篇新故事`:'故事本');
    const key=JSON.stringify(archive.map(trip=>[itemKey(trip),trip.title,trip.place,trip.status,unread(trip)]));
    if(key===archiveKey)return;archiveKey=key;
    shelf.hidden=!archive.length;shelf.replaceChildren();
    for(const trip of archive){
      const row=document.createElement('button');row.type='button';row.className='travel-shelf';
      row.innerHTML='<span class="travel-shelf-icon" aria-hidden="true">✉</span><span><small></small><strong></strong></span><span class="travel-new">NEW</span><span aria-hidden="true">›</span>';
      row.querySelector('.travel-shelf-icon').textContent=trip.visit?'🚪':'✉';
      row.querySelector('small').textContent=trip.visit?`${trip.date} · ${visitTag(trip)}`:trip.date;
      row.querySelector('strong').textContent=trip.title||'在'+trip.place+'的小回忆';
      row.querySelector('.travel-new').hidden=!unread(trip);
      row.onclick=()=>open(itemKey(trip));
      shelf.append(row);
    }
  }
  function markOpened(trip){
    const key=readItemKey(trip);
    if(trip.status!=='ready'||!trip.story||seen.has(key))return;
    readStorage();seen.add(key);saveRead();
    renderShelf();
  }
  window.addEventListener('storage',event=>{if(readKey&&event.key===readKey){readStorage();renderShelf();}});
  const sources=new Map(), sourceJobs=new Map();
  function label(text){listen.querySelector('span').textContent=text;}
  function status(text){find('.travel-status').textContent=text;}
  function halt(){playing=false;audio.pause();label('听{{petName}}讲');}
  function cleanup(){session++;controller?.abort();halt();loading=false;replay=false;listen.disabled=false;audio.removeAttribute('src');audio.load();sourceIndex=-1;clip=0;clipCount=1;for(const value of sources.values())URL.revokeObjectURL(value.url);sources.clear();sourceJobs.clear();}
  function showMoment(index){
    if(!current?.photos.length)return;
    moment=Math.max(0,Math.min(index,current.photos.length-1));
    const photo=current.photos[moment];find('figure img').src=photo.url;find('figure img').alt=current.story?.scenes[moment]?.caption||photo.caption;
    find('figcaption').textContent=current.story?.scenes[moment]?.caption||photo.caption;
    find('.travel-page-count').textContent=`${moment+1} / ${current.photos.length}`;
    find('.travel-prev').disabled=moment===0;find('.travel-next').disabled=moment===current.photos.length-1;
  }
  function renderTrip(trip){
    current=trip;find('.travel-place').textContent=trip.date.replaceAll('-',' · ')+'  /  '+(trip.visit?visitTag(trip)+' · '+trip.place:trip.place);
    find('h2').textContent=trip.story?.title||trip.title||'在'+trip.place+'的小回忆';
    find('figure').hidden=!trip.photos.length;showMoment(moment);
    const prose=find('.travel-prose');prose.replaceChildren();
    if(trip.story)for(const text of [trip.story.intro,...trip.story.scenes.map(s=>s.narration),trip.story.ending]){const p=document.createElement('p');p.textContent=text;prose.append(p);}
    listen.disabled=trip.status!=='ready';
    find('.travel-reading').hidden=!trip.story&&(trip.status!=='ready'||!!trip.visit);
    if(trip.status!=='ready')status(trip.error||'照片还在准备，先看看已经带回的小回忆。');
  }
  async function fetchTrip(date,signal){const response=await fetch('/api/trips/'+date,{signal});if(!response.ok)throw Error('这段旅行暂时没打开，再试一次吧。');return response.json();}
  async function loadArchive(signal){
    const response=await fetch('/api/trips',{signal});if(!response.ok)throw Error('相册暂时没打开。');const {trips,visits=[]}=await response.json();
    await account;if(signal?.aborted)throw new DOMException('故事页已关闭','AbortError');
    archive=[...visits.map(asStoryTrip),...trips].sort((a,b)=>b.date.localeCompare(a.date)||Number(Boolean(b.visit))-Number(Boolean(a.visit)));lastRefresh=Date.now();migrateReadDates();renderShelf();
    const select=find('select'), selectedKey=select.value;select.replaceChildren();for(const trip of archive){const option=document.createElement('option');option.value=itemKey(trip);option.textContent=optionLabel(trip);select.append(option);}
    if(archive.some(trip=>itemKey(trip)===selectedKey))select.value=selectedKey;
    find('.travel-archive').hidden=archive.length<2;
    return archive;
  }
  async function open(key,initialIndex=0){
    cleanup();controller=new AbortController();const token=session;moment=initialIndex;current=null;status('正在打开{{petName}}的小回忆……');
    find('h2').textContent='路上的小故事';find('.travel-place').textContent='';find('figure').hidden=true;find('.travel-reading').open=false;find('.travel-reading').hidden=true;find('.travel-archive').open=false;listen.disabled=true;original.hidden=true;
    document.getElementById('chat-audio').pause();
    document.querySelectorAll('#stories audio').forEach(a=>a.pause());
    if(!dialog.open)dialog.showModal();
    try{const trips=await loadArchive(controller.signal);if(token!==session)return;
      const target=key?trips.find(trip=>itemKey(trip)===key)||trips.find(trip=>trip.date===key):trips[0];
      if(!target)throw Error('{{petName}}还没有带回旅行照片，明天再来看看吧。');
      const trip=target.visit?target:await fetchTrip(target.date,controller.signal);if(token!==session)return;
      renderTrip(trip);find('select').value=itemKey(target);
      if(trip.visit&&!trip.story&&trip.originalAvailable&&trip.status==='ready'){
        loading=true;listen.disabled=true;
        try{await ensureVisitStory(token);}finally{if(token===session){loading=false;listen.disabled=false;}}
      }
      if(token!==session)return;
      markOpened(current);const option=find('select').selectedOptions[0];if(option&&!unread(current)&&current.status==='ready')option.textContent=option.textContent.replace(/ · NEW$/,'');if(current.status==='ready')status(trip.visit?'点一下，听这段串门的小故事。':'点一下，听{{petName}}讲路上发生的事。');}
    catch(error){if(token===session&&error.name!=='AbortError')status(error.message);}
  }
  async function ensureStory(token){
    if(current.story)return;
    if(current.visit)return ensureVisitStory(token);
    status('{{petName}}正在把这段小回忆整理成故事……');
    const response=await fetch('/api/trips/'+current.date+'/story',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:controller.signal});let data=await response.json();if(!response.ok)throw Error(data.error);
    while(!data.story&&data.storyStatus==='generating'&&token===session){
      status('先看看照片，故事一会儿就好。');
      await new Promise((resolve,reject)=>{const signal=controller.signal;const abort=()=>{clearTimeout(timer);reject(new DOMException('故事页已关闭','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},1500);if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
      if(token!==session)return;data=await fetchTrip(current.date,controller.signal);
    }
    if(token!==session)return;if(!data.story)throw Error(data.storyError||'这段故事还没整理好，请再试一次。');renderTrip(data);markOpened(data);
  }
  async function ensureVisitStory(token, useOriginal = false){
    status(useOriginal?'正在打开原版……':'正在准备所选语言的讲述……');
    original.hidden=true;
    try{
      const response=await fetch(`/api/visit/${current.visit.id}/story`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(useOriginal?{edition:'original'}:{}),signal:controller.signal});
      const data=await response.json();
      if(!response.ok||!data.story)throw Error(data.error||'这个语言版本暂时没有准备好。');
      if(token!==session)return;
      renderTrip(asStoryTrip(data));markOpened(current);
      if(!useOriginal){
        archive=archive.map(trip=>itemKey(trip)===itemKey(current)?current:trip);
        renderShelf();
      }
      const option=find('select').selectedOptions[0];
      if(option?.value===itemKey(current)&&!useOriginal)option.textContent=optionLabel(current);
    }catch(error){
      if(token===session&&!current.story)original.hidden=!current.originalAvailable;
      throw error;
    }
  }
  original.onclick=async()=>{
    if(loading||!current?.visit)return;
    const token=session;loading=true;listen.disabled=true;
    try{await ensureVisitStory(token,true);if(token===session)status('现在打开的是原版。点一下就能听。');}
    catch(error){if(token===session&&error.name!=='AbortError')status(error.message);}
    finally{if(token===session){loading=false;listen.disabled=false;}}
  };
  async function source(index,token,part=0){
    const key=index+':'+part;
    if(sources.has(key))return sources.get(key);
    if(sourceJobs.has(key))return sourceJobs.get(key);
    const job=(async()=>{try{
      const endpoint=current.visit?`/api/visit/${current.visit.id}/audio/${index}`:`/api/trips/${current.date}/audio/${index}`;
      const signal=AbortSignal.any&&AbortSignal.timeout?AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]):controller.signal;
      const response=await fetch(endpoint+'?clip='+part,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(current.visit?{edition:current.edition}:{}),signal});
      if(!response.ok){const data=await response.json();throw Object.assign(Error(data.error),{code:data.code});}
      const blob=await response.blob();if(token!==session)return null;
      const result={url:URL.createObjectURL(blob),count:Number(response.headers.get('X-Pet-Story-Clips'))||1,ownKey:response.headers.get('X-Pet-Voice-Source')==='own-key'};
      sources.set(key,result);return result;
    }finally{if(token===session)sourceJobs.delete(key);}})();sourceJobs.set(key,job);return job;
  }
  async function play(index,token){
    loading=true;listen.disabled=true;label('准备声音……');status('{{petName}}马上开口，照片会跟着故事换页。');
    const result=await source(index,token,clip);if(token!==session||!result)return;
    audio.src=result.url;clipCount=result.count;sourceIndex=index;showMoment(index);loading=false;listen.disabled=false;
    try{await audio.play();if(token!==session)return;playing=true;label('暂停故事');status(result.ownKey?'平台额度不足，本段由自己的百炼 Key 朗读。':`正在讲第 ${index+1} 段，共 2 段`);}
    catch{playing=false;label('继续听');status('声音准备好了，再点一下就能听。');}
    if(clip+1<clipCount&&token===session)source(index,token,clip+1).catch(()=>{});
    else if(index===0&&await legacyStoryAudio&&token===session)source(1,token).catch(()=>{});
  }
  const legacyStoryAudio=fetch('/api/capabilities').then(response=>response.json()).then(caps=>!caps.voiceSettings).catch(()=>false);
  function unavailable(error,token,index,offerSettings){
    if(token!==session||error.name==='AbortError')return;
    halt();
    if(index!==moment)showMoment(index);
    label('继续听');
    status((error.name==='TimeoutError'?'这次声音等得有点久，请稍后再试。':error.message||'声音暂时没有接上。')+' 也可以点开文字看故事。');
    if(offerSettings)window.petCompanionUI?.openForVoice(error,()=>{if(token===session)listenToStory(false);});
  }
  async function listenToStory(offerSettings=true){
    if(loading||!current)return;
    if(playing){halt();label('继续听');status('故事暂停了，准备好再继续。');return;}
    if(replay){replay=false;sourceIndex=-1;clip=0;showMoment(0);}
    const token=session;loading=true;listen.disabled=true;
    try{if(offerSettings&&window.petCompanionUI&&!(await window.petCompanionUI.checkVoice(()=>{if(token===session)listenToStory(false);})))return;
      await ensureStory(token);if(token!==session)return;
      if(sourceIndex===moment&&audio.src&&!audio.ended){await audio.play();if(token!==session)return;playing=true;label('暂停故事');status(`正在讲第 ${moment+1} 段，共 2 段`);}
      else await play(moment,token);
    }catch(error){unavailable(error,token,moment,offerSettings);}
    finally{if(token===session){loading=false;listen.disabled=false;}}
  }
  listen.onclick=()=>listenToStory();
  audio.onended=()=>{
    if(!playing)return;
    const token=session;
    let next=sourceIndex;
    if (clip+1<clipCount) clip++;
    else if (next===0) { next=1;clip=0; }
    else {halt();label('再听一遍');replay=true;sourceIndex=-1;status('故事讲完啦。你最喜欢哪个瞬间？');return;}
    play(next,token).catch(error=>{if(token!==session)return;loading=false;listen.disabled=false;unavailable(error,token,next,true);});
  };
  audio.onerror=()=>{if(!audio.getAttribute('src'))return;halt();loading=false;listen.disabled=false;sourceIndex=-1;status('声音这次没播出来，可以再试一次或读文字。');};
  find('.travel-prev').onclick=()=>{if(loading)return;halt();replay=false;sourceIndex=-1;clip=0;showMoment(moment-1);status('从这个瞬间开始听。');};
  find('.travel-next').onclick=()=>{if(loading)return;halt();replay=false;sourceIndex=-1;clip=0;showMoment(moment+1);status('从这个瞬间开始听。');};
  find('.travel-photo-open').onclick=()=>{halt();label(replay?'再听一遍':'继续听');if(current?.photos[moment])window.chatUI?.openPhoto(current.photos[moment]);};
  find('.travel-reading').ontoggle=async()=>{if(!find('.travel-reading').open||current?.story||!current)return;const token=session;try{await ensureStory(token);if(token===session)status('小故事已经收好啦。');}catch(error){if(token===session&&error.name!=='AbortError')status(error.message);}};
  find('select').onchange=()=>open(find('select').value);
  find('.close-button').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{if(!dialog.open)cleanup();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing){halt();label('继续听');}});
  function refreshShelf(){
    if(refreshing)return refreshing;
    lastRefresh=Date.now();
    refreshing=loadArchive().catch(()=>{}).finally(()=>{refreshing=null;});
    return refreshing;
  }
  window.addEventListener('pet-companion-language',refreshShelf);
  function update(state){
    const trip=state.trip, signature=trip?`${trip.date}:${trip.status}:${trip.photos?.length||0}`:'';
    if(signature!==lastTrip||Date.now()-lastRefresh>60000)refreshShelf();
    lastTrip=signature;
  }
  storyButton.addEventListener('click',refreshShelf);
  window.travelUI={open,update};
  if(pet)update(pet);
  refreshShelf();
})();
