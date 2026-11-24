const $ = id => document.getElementById(id);
let pet, busy = false;
let toastTimer;
let storyActionId = null, lastStoriesKey = '';
let voiceCapabilities = {};
fetch('/api/capabilities').then(r => r.json()).then(c => { voiceCapabilities = c; }).catch(() => {});
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const dayFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
function recordLabel(text) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-mic'); icon.append(use);
  $('record').replaceChildren(icon, document.createTextNode(text));
}
$('date').textContent = dayFormat.format(new Date()) + ' · ' + new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(new Date());
function toast(message, duration = 4000) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), duration);
}
function render(state) {
  pet = state; window.applyPetIdentity?.(state);
  const evolution = state.evolution || { level: 0, nextAt: 3, totalEvolutions: 4, image: '/assets/zuanzuan.png', status: 'idle' };
  document.body.classList.toggle('custom-pet',!!state.petProfile);
  const stage = evolution.level;
  const growthFeeds = evolution.feeds ?? state.feeds;
  const target = evolution.nextAt;
  const previous = [0, 3, 8, 15, 25][stage];
  const motionPending = stage > 0 && evolution.complete === false;
  $('stage').textContent = stage ? `${state.name} · 第 ${stage} 次进化${motionPending ? '准备中' : ''}` : (state.petProfile?'我的新搭档 · ':'宝石芭蕾猫 · ')+state.name;
  const formImage = evolution.image;
  if ($('cat').getAttribute('src') !== formImage) $('cat').src = formImage;
  $('cat').alt = stage ? `{{petName}}第 ${stage} 次进化后的形象` : state.name+'的形象';
  $('cat').classList.toggle('evolved-art', stage > 0);
  const portrait = document.querySelector('.growth-portrait img');
  portrait.src = formImage; portrait.classList.toggle('evolved-art', stage > 0);
  document.querySelector('.avatar img').src = formImage;
  $('growth-stage').textContent = $('stage').textContent;
  $('level').textContent = stage + 1;
  $('together-days').textContent = Math.max(1, Math.floor((Date.now() - state.createdAt) / 86400000) + 1);
  $('total-stories').textContent = state.stories.length;
  $('food-counter').textContent = state.home?.totalFood ?? state.food;
  $('dock-food-count').textContent = state.home?.totalFood ?? state.food;
  $('cat-wrap').style.transform = 'none';
  $('scene').classList.toggle('sleeping', state.sleeping);
  $('speech').textContent = state.sleeping ? '呼呼……喂我就能醒来哦' : state.home ? `今天想吃${state.home.wish.name}～` : '给我讲一个故事吧～';
  $('mood').textContent = state.sleeping ? '☾ 睡个小觉' : state.daysHungry >= 1 ? '♡ 想吃点东西' : '♡ 开开心心';
  $('feed-count').textContent = `吃过 ${state.feeds} 份食物`;
  $('food-badge').textContent = `背包里 ${state.food} 份`;
  $('growth-text').textContent = state.petProfile&&state.animation?.status!=='ready'?'动作还在准备，先一起读故事':evolution.status === 'generating' ? '{{petName}}正在准备新模样……' : motionPending ? '这次进化还在准备动作' : target === null ? '四次进化完成啦！' : evolution.eligible ? '{{petName}}已经可以进化啦' : `再吃 ${Math.max(0, target - growthFeeds)} 份，就能进化`;
  $('growth-bar').style.width = target === null ? '100%' : `${Math.max(0, Math.min(100, (growthFeeds - previous) / (target - previous) * 100))}%`;
  $('mini-growth').style.width = $('growth-bar').style.width;
  $('evolution-progress').textContent = `已完成 ${evolution.completedLevel ?? stage} / ${evolution.totalEvolutions} 次进化`;
  $('evolution-status').textContent = evolution.status === 'failed' ? evolution.error : evolution.status === 'generating' ? '新模样需要一点时间，你可以先去讲故事。' : '';
  if (evolution.status === 'idle' && state.animation?.status === 'generating') $('evolution-status').textContent = '正在为新模样准备待机和跳舞动作，完成后才算准备齐全。';
  if (evolution.status === 'idle' && state.animation?.status === 'unavailable' && stage > 0) $('evolution-status').textContent = '新模样的动作还没准备好，可以点“准备动作”继续。';
  if (evolution.status === 'idle' && state.animation?.status === 'failed') $('evolution-status').textContent = state.animation.error;
  $('evolve').hidden = !evolution.eligible || evolution.status === 'generating';
  $('evolve').disabled = busy;
  $('evolve').textContent = evolution.status === 'failed' ? '再试一次进化' : '让{{petName}}进化';
  $('feed').disabled = busy;
  $('bag-feed').disabled = busy || (state.home?.totalFood ?? state.food) < 1;
  $('reward-feed').disabled = busy || (state.home?.totalFood ?? state.food) < 1;
  $('claim').disabled = busy || state.availableRewards < 1;
  $('mission-claim').disabled = $('claim').disabled;
  $('claim').textContent = state.availableRewards ? `领取食材 · 可以选 ${state.availableRewards} 个` : state.home?.storyRewards?.remaining===0 ? '今日奖励已拿满 · 明天再来' : '讲一个故事，就能领取食材';
  $('mission-claim').textContent = $('claim').textContent;
  $('reading-count').textContent = `读书 ${state.readings} 次 · 讲故事 ${state.stories.length} 次`;
  const progress = Math.min(2, state.availableRewards);
  $('mission-counter').textContent = `${state.availableRewards} 个待领`;
  $('mission-progress').textContent = `可领 ${state.availableRewards} 个食材`;
  $('dot1').classList.toggle('done', progress >= 1);
  $('dot2').classList.toggle('done', progress >= 2);
  document.querySelector('.reward-dot').classList.toggle('ready', state.availableRewards > 0);
  const key = state.stories.map(s => s.id+':'+(s.transcriptionStatus||'')).join(',');
  if (key !== lastStoriesKey) {
    lastStoriesKey = key;
    $('stories').replaceChildren();
    for (const story of state.stories.slice(0, 20)) {
      const entry = document.createElement('article'); entry.className = 'story-entry';
      const time = document.createElement('time'); time.textContent = dayFormat.format(story.createdAt) + ' · 读书的小脚印'; entry.append(time);
      const text = document.createElement('p'); text.textContent = story.kind==='reading' ? `🎙 读书录音 · ${Math.floor((story.durationMs||0)/60000)}分${Math.floor((story.durationMs||0)%60000/1000)}秒`+(story.transcriptionStatus==='ready'?' · 文字已整理':story.transcriptionStatus==='processing'?' · 正在整理文字':' · 录音已收好') : story.transcript || window.petText('🎙 讲给{{petName}}听的一段小故事'); entry.append(text);
      if(story.kind==='reading'){
        const details=document.createElement('details'),summary=document.createElement('summary'),content=document.createElement('p');summary.textContent='看看读到的文字';content.textContent=story.transcript||'文字还在整理，录音已经收好。';details.append(summary,content);
        details.ontoggle=async()=>{if(!details.open)return;try{const r=await fetch('/api/readings/'+story.id+'/transcription'),d=await r.json();if(r.ok)content.textContent=d.transcript||'文字还在整理，录音已经收好。';}catch{}};entry.append(details);
        if(['failed','interrupted','pending'].includes(story.transcriptionStatus)){const retry=document.createElement('button');retry.className='secondary-button';retry.textContent='继续转文字';retry.onclick=async()=>{retry.disabled=true;try{await fetch('/api/readings/'+story.id+'/transcription',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await refresh();}finally{retry.disabled=false;}};entry.append(retry);}
      }
      if (story.audioType) { const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = '/api/recordings/' + story.id; entry.append(audio); }
      $('stories').append(entry);
    }
  }
  window.homeUI?.render(state);
  if(['food','ingredients'].includes(state.taskRewardMode)){
    const q=state.home.storyRewards;
    $('claim').disabled=!state.availableRewards;$('mission-claim').disabled=!state.availableRewards;
    const hint=document.querySelector('.reward-hint');if(hint)hint.textContent=state.petProfile&&!state.petProfile.legacyRules?'每件事每天1次，一天最多2次':'每天最多拿2个食材奖励';
    const copy=document.querySelector('.quest-inner>p');if(copy)copy.textContent='做完任务，选食材，做好吃的。';
    const mission=$('mission-dialog');mission.querySelector('h2').textContent='完成任务，领取食材';mission.querySelector('.dialog-copy').textContent=state.petProfile&&!state.petProfile.legacyRules?'读书、做工作，每件事每天奖励1次，一天最多选2个食材。':'做完任务就能选食材，每天最多奖励2次。';
  }
  window.petWorkUI?.update(state);
  window.petMotion?.update(state);
  window.chatUI?.updateTrip(state);
  window.travelUI?.update(state);
  window.visitUI?.update?.(state);
}
async function refresh() {
  try { const res = await fetch('/api/pet'); if (!res.ok) throw new Error(); render(await res.json()); }
  catch { toast('暂时连不上{{petName}}的小家，检查一下网络再试吧。'); }
}
window.refreshPet = refresh;
async function mutate(endpoint, body) {
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const state = await res.json();
  if (!res.ok) throw new Error(state.error || '刚才没保存成功，再试一次吧。');
  render(state);
  return state;
}
async function simpleAction(kind) {
  if (busy) return;
  const previousForm = pet.evolution?.level || 0;
  busy = true; render(pet);
  try {
    await mutate('/api/' + kind, { actionId: uuid() });
    if (kind === 'feed') { window.gameEffects?.feed(); $('scene').classList.add('celebrate'); $('speech').textContent = '好好吃！谢谢'+pet.owner+' ♡'; setTimeout(() => $('scene').classList.remove('celebrate'), 1500); toast(pet.evolution?.status === 'generating' ? '吃饱啦！{{petName}}开始准备进化的新模样。' : previousForm !== (pet.evolution?.level || 0) ? '{{petName}}进化啦！' : '{{petName}}吃饱啦，谢谢你！'); }
    else if (kind === 'evolve') { toast('{{petName}}开始准备新模样啦！'); }
    else { window.gameEffects?.reward(); }
  } catch (err) { toast(err.message || '网络没连上，再试一次吧。'); }
  finally { busy = false; render(pet); if (kind === 'feed' && pet.lastFedAt && Date.now() - pet.lastFedAt < 3000) $('speech').textContent = '好好吃！谢谢'+pet.owner+' ♡'; }
}
$('feed').onclick = () => simpleAction('feed');
$('claim').onclick = () => simpleAction('claim');
$('evolve').onclick = () => simpleAction('evolve');
$('open-story').onclick = () => { $('dialog-error').textContent = ''; $('story-dialog').showModal(); };
function closeStory(){readingRecorder.close();}
$('close-story').onclick=closeStory;
$('story-dialog').addEventListener('cancel',event=>{event.preventDefault();closeStory();});
function toBase64(blob) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);}); }
const readingRecorder=createReadingRecorder({render,toast,uuid,saveText:async()=>{
 if(busy)return;const transcript=$('transcript').value.trim();if(!transcript){$('dialog-error').textContent='先录一段读书声音，或写下今天读的故事吧。';return;}
 busy=true;$('submit-story').disabled=true;
 try{storyActionId ||= uuid();const saved=await mutate('/api/story',{actionId:storyActionId,transcript});$('story-dialog').close();$('transcript').value='';storyActionId=null;toast(saved.storyReward?.message||'读书记录收好啦！');}
 catch(e){$('dialog-error').textContent=e.message;}finally{busy=false;$('submit-story').disabled=false;}
}});

refresh();
setInterval(() => { if (!busy && !document.hidden && !$('story-dialog').open) refresh(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) refresh(); });


