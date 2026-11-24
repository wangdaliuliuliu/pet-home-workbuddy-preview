const chatDiagnostics=require('./chat-diagnostics');
const {childError}=require('./child-copy');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createTaskQueue}=require('./task-queue');
const transcriptionQueue=createTaskQueue();
const liveTranscriptionQueue=createTaskQueue({maxActive:3,maxWaiting:4,waitTimeoutMs:2500});
const liveSpeechQueue=createTaskQueue({maxActive:4,maxWaiting:6,waitTimeoutMs:2500});
const backgroundSpeechQueue=createTaskQueue({maxActive:2,maxWaiting:4,waitTimeoutMs:5000});
const companion=require('./companion-language');
const voiceConfiguration=require('./companion-voice');
const {segmentText}=require('./travel-story');
const voice = require('./voice-service');
const { createEvolution } = require('./evolution-service');
const { createAnimation } = require('./animation-service');
const home = require('./home-service');
const storyRewards = require('./story-rewards');
const { createMemory } = require('./memory-service');
const chatHistory = require('./chat-history');
const {createMediaStore}=require('./media-store');
const {uploadPhoto}=require('./photo-service');
const {createTrips,day:travelDay}=require('./trip-service');
const {nextDay}=require('./visit-service');
const {createReadings}=require('./reading-service');
const {setTravelPolicy}=require('./pet-travel-policy');
const {serveRecording}=require('./recording-response');
const root = path.join(__dirname, 'public');
function createPetRuntime({dataDir, profile={owner:'小朋友',name:'宠物'},rewardMode,preserveExistingState=false,visits=null,userId='',voicePlan,voiceCatalog,voiceDailyFen,voiceNow,platformRemote,companionDisabled=false,onlineReport=null,onlineVisits=null } ) {
fs.mkdirSync(dataDir, { recursive: true });
const stateFile = path.join(dataDir, 'pet.json');
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {
  owner: profile.owner, name: profile.name, createdAt: Date.now(), lastFedAt: null,
  readings: 0, food: 0, claimedRewards: 0, feeds: 0, stories: [], actions: []
};
let initializing=true;
let languageRevision = 0;
const visitAudioJobs = new Map();
const companionVoice = !companionDisabled&&voiceConfiguration.enabled() ? voiceConfiguration.createCompanionVoice({state,save,dataDir,voicePlan,voiceCatalog,voiceDailyFen,platformRemote,liveQueue:liveSpeechQueue,storyQueue:backgroundSpeechQueue,now:voiceNow}) : null;
async function meteredSpeak(text,signal,queue=liveSpeechQueue){
  const cost=typeof text==='string'?text.trim().length:0;
  if(!cost||cost>1200)throw new voice.VoiceError('请提交 1 到 1200 字的朗读内容。',400);
  const release=await queue.acquire(signal);
  const metered=Number.isSafeInteger(state.voiceBalance);
  try{
    if(metered&&state.voiceBalance<cost)throw new voice.VoiceError('语音额度不足，可以先读文字，请大人补充额度。',429);
    if(metered){state.voiceBalance-=cost;save();}
    try{return await voice.speak(text,{voiceProfile:state.voiceProfile,signal});}
    catch(error){if(metered){state.voiceBalance+=cost;save();}throw error;}
  }finally{release();}
}
function save() {
  if(initializing&&preserveExistingState)return;
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(stateFile + '.tmp', stateFile);
}
const animation = createAnimation({ state, save, dataDir });
const evolution = createEvolution({ state, save, dataDir, onForm: form => animation.start(form), animationView: () => animation.view() });
if(rewardMode)state.taskRewardMode=rewardMode;
home.migrate(state);
chatHistory.migrate(state);
const memory = createMemory({ state, save, extract: voice.extractMemory });
function rememberHarvest(issue){if(!state.petProfile||issue.status!=='ready'||!issue.result)return;const key='harvest-'+issue.id;if(state.memories.some(m=>m.type==='work'&&m.key===key))return;memory.put({type:'work',key,text:(issue.sourceDate||issue.date)+'带回作品《'+issue.result.title+'》：'+(issue.result.body||issue.result.lyrics||issue.result.imagePrompt||'').slice(0,190)},key);save();}
if(state.petProfile){for(const i of Object.values(state.work?.issues||{}))rememberHarvest(i);for(const m of state.memories)if(m.type==='trip'&&/^\d{4}-\d{2}-\d{2}钻钻去了/.test(m.text))m.text=m.text.replace('钻钻去了',state.name+'去了');}
const media=createMediaStore({state,save,dataDir});
const localFirst=process.env.PET_LOCAL_FIRST==='1';
const trips=createTrips({state,save,dataDir,media,memory,visits,userId,localFirst,speakerIdentity:companionVoice?.identity,speaker:(text,options)=>{
  if(companionVoice)return companionVoice.speak(text,{...options,purpose:'story'});
  if(!Number.isSafeInteger(state.voiceBalance))return voice.speak(text,options);
  return meteredSpeak(text,options?.signal,backgroundSpeechQueue);
}});
const readingTopics=require('./reading-topics').createReadingTopics({state,save,prepare:voice.prepareReading,chat:voice.chatWithRecovery,pet:()=>({...view(),companion:companion.settings(companionDisabled?null:state.companion)}),remember:(id,text)=>{memory.put({type:'story',key:id,text},id);save();},report:error=>chatDiagnostics.record(error,{stage:'reading_prepare'})});
const readings=createReadings({state,save,dataDir,queue:transcriptionQueue,transcribe:body=>voice.transcribe(body,async bytes=>bytes),enabled:process.env.PET_DISABLE_READING_ASR!=='1',onTranscript:story=>{void readingTopics.schedule(story);},submit:({actionId,audioType,audioFile,durationMs})=>{
  const existing=state.stories.find(s=>s.actionId===actionId);if(existing)return existing;
  const id=crypto.randomUUID();fs.renameSync(audioFile,path.join(dataDir,id+'.audio'));
  const story={id,actionId,transcript:'',createdAt:Date.now(),audioType,durationMs,kind:'reading',transcriptionStatus:'pending'};
  state.stories.unshift(story);state.readings++;storyRewards.grant(state,story);home.grantVisitCredit(state);save();trips.prepare(story);if(onlineReport&&!localFirst)try{onlineReport(story);}catch{}return story;
}});
// 便携版在家里读完书后，把这件事告诉线上家，让线上那边的串门体力与资格同步到账。
function reportReadingDone(body){
  const today=travelDay();
  const summary=String(body?.title||body?.transcript||'').trim().slice(0,60)||'在家里读完的一本书';

  const existing=state.stories.find(s=>s.kind==='reading'&&s.remote===true&&travelDay(s.createdAt)===today);
  if(!existing){
    state.stories.unshift({id:crypto.randomUUID(),actionId:'remote-'+today,transcript:summary,createdAt:Date.now(),audioType:null,kind:'reading',remote:true});
    state.readings++;home.grantVisitCredit(state);save();
    return {ok:true,created:true,credit:visitCredit()};
  }
  if(!state.visitCredit||state.visitCredit.day!==today){home.grantVisitCredit(state);save();}
  return {ok:true,created:false,credit:visitCredit()};
}
if (!state.memoryBackfilled) {
  for (const story of [...state.stories].reverse().slice(-60)) memory.story(story);
  const pastChat = (state.chatMessages || []).filter(m => m.role === 'user').map(m => m.content).join('\n').slice(-2000);
  if (pastChat) memory.learn(pastChat, 'previous-chat');
  state.memoryBackfilled = true;
}
initializing=false;
// 体力改由"读完书"发放后，当天已经读过书却还没领到的人补一次，别让孩子今天白等。
if(state.stories.some(s=>s&&travelDay(s.createdAt)===travelDay())&&!(state.visitCredit&&state.visitCredit.day===travelDay())){home.grantVisitCredit(state);save();}
if(!preserveExistingState)save();
// Only the current day's earned outing runs. Failed/interrupted paid work needs a manual retry.
if(process.env.PET_SKIP_ENV!=='1') setTimeout(()=>animation.ensureCurrent(),1000).unref();
let travelTimer;function startTravel(){if(process.env.PET_SKIP_ENV==='1')return;if(state.petProfile&&!state.petProfile.legacyRules){if(state.travelEnabled!==false&&(require('./local-agent').enabled()||(process.env.PET_PORTABLE!=='1'||process.env.PET_DISABLE_TRIPS!=='1')&&process.env.STUDIO_ALLOW_PAID==='1'))trips.start();}else if(process.env.PET_DISABLE_TRIPS!=='1')trips.start();if(visits&&userId&&process.env.PET_DISABLE_VISIT_GEN!=='1')visits.ensureForDate(userId,travelDay()).catch(()=>{});}
if(localFirst){setImmediate(()=>trips.resume());setInterval(()=>trips.resume(),60000).unref();}
if(process.env.PET_SKIP_ENV!=='1'){if(!preserveExistingState)setTimeout(startTravel,1500).unref();travelTimer=setInterval(startTravel,15*60*1000);travelTimer.unref();}
function visitCredit() {
  if (!visits || !userId) return 0;
  const today = travelDay();
  return state.visitCredit && state.visitCredit.day === today ? Math.max(0, state.visitCredit.left || 0) : 0;
}
// 串门点击留痕：孩子点失败时，也要能查到他想去哪家、为什么没成。
function visitEvent(entry) {
  try {
    const file = path.join(process.env.PET_DATA_DIR || dataDir, 'visit-events.log');
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), user: userId, pet: state.name, ...entry }) + '\n');
    if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1');
  } catch {}
}
function visitTargetName(id) {
  try { return visits ? (visits.targets(userId).find(t => t.id === id)?.petName || '') : ''; } catch { return ''; }
}
// 今天留下过故事，明天才收得到串门的故事——所以串门这件事，今天必须先讲过故事。
function toldStoryToday() {
  const today = travelDay();
  return state.stories.some(s => s && travelDay(s.createdAt) === today);
}
// 今天该收到的串门故事按我自己的资格放行：昨天没留下故事，今天就不投递，另一个人照旧。
function visitView() {
  const today = travelDay();
  if (!visits || !userId) return { enabled: false, credit: 0, canVisit: false, storyToday: false, targets: [], todayVisits: [], archive: [] };
  const eligible = trips.view(today).eligible;
  const mode = companion.settings(companionDisabled?null:state.companion).mode;
  const credit = visitCredit(), storyToday = toldStoryToday();
  // 今天是否已经领到过串门机会：今天读完并保存一个故事后就会到账。
  const creditGranted = !!state.visitCredit && state.visitCredit.day === today;
  return {
    enabled: true,
    credit,
    // 读完一本书就有一次体力，今天读过故事才能约明天一起玩。
    canVisit: credit > 0 && storyToday,
    creditGranted,
    today,
    eligible,
    // 明天有没有故事，取决于今天有没有留下故事。
    storyToday,
    targets: visits.targets(userId),
    todayVisits: visits.forDate(userId, today, eligible, mode),
    // 标了 preview 的次日故事，今天就能先看（运营用，仅当天有效）。
    previewVisits: visits.previewFor ? visits.previewFor(userId, today, mode) : [],
    archive: visits.listFor(userId, mode, record => visitAvailable(record, today, eligible)).slice(0, 20)
  };
}
function visitAvailable(record, today = travelDay(), eligible = trips.view(today).eligible) {
  return Boolean(record?.status === 'ready' &&
    (record.storyDate < today || (record.storyDate === today && (eligible||record.external)) ||
      (record.preview === true && record.storyDate === nextDay(today))));
}
function relevantStories(message) {
  if (!/串门|旅行|故事|《[^》]+》|后来.{0,10}(?:呢|怎么|发生)|\b(?:visit(?:ed|ing)?|trip|story|stories|what happened)\b/i.test(message)) return [];
  const today = travelDay();
  const eligible = trips.view(today).eligible;
  const shared = visits && userId ? visits.listFor(userId, 'original', record => visitAvailable(record, today, eligible)) : [];
  return [...shared.map(item => ({date:item.storyDate, kind:'串门', story:item.story})),
    ...trips.context().filter(item => item.status === 'ready').map(item => ({date:item.date, kind:'旅行', story:item.story}))]
    .filter(item => item.story).sort((a,b) => b.date.localeCompare(a.date)).slice(0, 5);
}
function view() {
  const daysHungry = Math.floor((Date.now() - (state.lastFedAt || state.createdAt)) / 86400000);
  const { readingTopics:privateReadingTopics,readingTopicDay,readingTopicAngles,memories, memoryRevision, memoryBackfilled, chatMessages, chatArchive, animationPacks, previousEvolutions, photos, readingJobs, trips:privateTrips, visitCredit:privateVisitCredit, storyRewards:privateRewards, ownerPhotoId, voiceRelayHash, voiceCredits, companionProgress, companionListening, companionWallet, companionDailyVoice, ...publicState } = state;
  if(publicState.work)publicState.work={...publicState.work,issues:Object.fromEntries(Object.entries(publicState.work.issues||{}).map(([id,i])=>[id,i.status==='ready'?i:{id:i.id,date:i.date,sourceDate:i.sourceDate,status:i.status,stage:i.stage,work:i.work,error:i.error}]))};
  return { ...publicState, danceEnabled:profile.danceEnabled!==false, stories:state.stories.map(s=>s.kind==='reading'?{...s,transcript:s.transcript.slice(0,1000),transcriptTruncated:s.transcript.length>1000}:s), evolution: evolution.view(), animation: animation.view(), trip: trips.view(), visit: visitView(), actions: undefined, daysHungry, sleeping: daysHungry >= 3,
    availableRewards: home.available(state), home: home.view(state) };
}
function json(res, status, body) {
  if(typeof body?.error==='string'&&!String(body.code).startsWith('voice_'))body={...body,error:childError(body.error.replace(/钻钻/g,state.name||'宠物'))};
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const handle = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if(url.pathname==='/api/pet/travel-settings'&&req.method==='POST'){let chunks=[];for await(const c of req){chunks.push(c);if(chunks.reduce((s,x)=>s+x.length,0)>1000)return json(res,413,{error:'内容太多了。'});}const b=JSON.parse(Buffer.concat(chunks).toString());setTravelPolicy(state,b.enabled);save();if(b.enabled)startTravel();return json(res,200,{enabled:state.travelEnabled});}
  if(url.pathname==='/api/readings'||url.pathname.startsWith('/api/readings/')){
    try{
      const route=/^\/api\/readings\/([a-f0-9-]{36})(?:\/(chunks|finish|transcription|discard)(?:\/(\d+))?)?$/.exec(url.pathname);
      if(route&&req.method==='PUT'&&route[2]==='chunks'&&route[3]!==undefined)return json(res,200,await readings.upload(route[1],Number(route[3]),req));
      if(route&&req.method==='GET'&&route[2]==='transcription')return json(res,200,readings.status(route[1]));
      if(req.method!=='POST')return json(res,404,{error:'没有找到这次读书录音。'});
      let size=0;const chunks=[];for await(const bytes of req){size+=bytes.length;if(size>65536)return json(res,413,{error:'这次请求有点大，请重试。'});chunks.push(bytes);}
      const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
      if(url.pathname==='/api/readings')return json(res,200,readings.create(body.audioType,body.actionId));
      if(route?.[2]==='discard'){readings.discard(route[1]);return json(res,200,{discarded:true});}
      if(route?.[2]==='finish'){
        const result=await readings.finish(route[1],body),story=state.stories.find(s=>s.id===result.storyId);
        return json(res,200,{...view(),reading:result,storyReward:storyRewards.result(state,story,Date.now(),result.replayed)});
      }
      if(route?.[2]==='transcription'){readings.start(route[1]);return json(res,202,readings.status(route[1]));}
      return json(res,404,{error:'没有找到这次读书录音。'});
    }catch(e){return json(res,e.status||500,{error:e.status?e.message:'录音还没收好，请保留录音并重试保存。'});}
  }
  if (req.method === 'POST' && url.pathname === '/api/read') return json(res, 410, { error: '现在要讲一个故事并保存，才能领取食材啦。' });
  if (url.pathname === '/api/chat/unread') {
    if(req.method==='GET'){readingTopics.ensureLatest();return json(res,200,chatHistory.unread(state));}
    if(req.method==='POST'){
      try{
        let raw='';
        for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>1000)return json(res,413,{error:'内容太多了。'});}
        const body=JSON.parse(raw||'{}');
        const result=chatHistory.markRead(state,body.id);
        save();
        return json(res,200,result);
      }catch{return json(res,400,{error:'已读状态没有保存好，请稍后重试。'});}
    }
    return json(res,405,{error:'这个操作暂时不能用。'});
  }
  if (req.method === 'GET' && url.pathname === '/api/chat/history') {
    try { const result=chatHistory.page(state, url.searchParams.get('before'));result.messages=result.messages.map(m=>({...m,photos:(m.photoIds||[]).map(id=>media.publicPhoto(media.get(id))).filter(Boolean),...(m.referencePhotoId?{referencePhoto:media.publicPhoto(media.get(m.referencePhotoId))}:{})}));return json(res, 200,{...result,mode:companion.settings(companionDisabled?null:state.companion).mode}); }
    catch (err) { return json(res, err.status || 500, { error: err.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/capabilities') return json(res,200,{...voice.capabilities(),...(companionVoice?{voiceSettings:true}: {})});
  if(req.method==='GET'&&url.pathname==='/api/visit')return json(res,200,visitView());
  // 便携版代理转发来的"今天读完书了"：幂等落一条当日读书记录并发串门体力。
  if(req.method==='POST'&&url.pathname==='/api/visit/reading-done'){
    try{
      let chunks=[],size=0;
      for await(const c of req){size+=c.length;if(size>4000)return json(res,413,{error:'内容太多了。'});chunks.push(c);}
      const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
      return json(res,200,reportReadingDone(body));
    }catch(err){return json(res,err.status||500,{error:err.status?err.message:'这一步没完成，请稍后再试。'});}
  }
  if(req.method==='POST'&&url.pathname==='/api/visit/send'){
    let targetId='';
    try{
      let chunks=[],size=0;
      for await(const c of req){size+=c.length;if(size>4000)return json(res,413,{error:'内容太多了。'});chunks.push(c);}
      const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
      targetId=String(body.targetId||'');
      if(!visits||!userId){visitEvent({result:'rejected',reason:'visit_closed',targetId});return json(res,409,{error:'现在还不能出门找朋友。'});}
      if(!toldStoryToday()){visitEvent({result:'rejected',reason:'no_story_today',targetId,targetName:visitTargetName(targetId)});return json(res,409,{error:'今天还没给宠物讲故事，讲完故事才能约朋友一起玩。'});}
      if(visitCredit()<1){
        const today=travelDay(), granted=!!state.visitCredit&&state.visitCredit.day===today;
        visitEvent({result:'rejected',reason:granted?'credit_used':'no_credit',targetId,targetName:visitTargetName(targetId)});
        return json(res,409,{error:granted?'今天的串门机会已经用掉啦，明天再来。':'今天还没读完一本书。读完并保存故事，串门机会就会到账。'});
      }
      const sent=visits.send(userId,targetId);
      state.visitCredit={day:travelDay(),left:0};save();
      visitEvent({result:'ok',targetId,targetName:visitTargetName(targetId),storyDate:sent&&sent.storyDate});
      return json(res,200,{...visitView(),sent});
    }catch(err){
      visitEvent({result:'failed',reason:err.message,targetId,targetName:visitTargetName(targetId)});
      return json(res,err.status||400,{error:err.status?err.message:'这一步没完成，请稍后再试。'});
    }
  }
  const visitStoryRoute = /^\/api\/visit\/([a-f0-9-]{36})\/(story|audio\/([01]))$/.exec(url.pathname);
  if (req.method === 'POST' && visitStoryRoute) {
    const [,id,action,index] = visitStoryRoute;
    const record = visits?.read(id);
    if (!visitAvailable(record) || !visits.roleOf(record,userId) || !record.story) return json(res,404,{error:'这篇故事还没有准备好。'});
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1000) return json(res,413,{error:'内容太多了。'});
      }
      const {edition} = JSON.parse(raw || '{}');
      const mode = companion.settings(companionDisabled?null:state.companion).mode;
      if (action === 'story') {
        const language = edition === 'original' ? 'original' : mode;
        await visits.prepareNarration(record, language);
        return json(res,200,visits.view(record,userId,language));
      }
      if (edition !== undefined && edition !== 'original' && !companion.MODES.includes(edition)) return json(res,400,{error:'这段声音没有找到。'});
      const { story } = visits.view(record,userId,edition || mode);
      if (!story) return json(res,409,{error:'这个讲法的声音还没准备好。'});
      const text = index === '0' ? `${story.intro}\n${story.scenes[0].narration}` : `${story.scenes[1].narration}\n${story.ending}`;
      const identity=companionVoice ? companionVoice.identity(text) : voice.speechCacheIdentity(state.voiceProfile);
      const key = crypto.createHash('sha256').update(id+'\n'+text+'\n'+identity).digest('hex');
      const dir = path.join(dataDir,'visit-audio'), file = path.join(dir,key+'.mp3');
      if (companionVoice) {
        if(companionVoice.usesLocal()&&url.searchParams.has('clip')){
          const {audio,count}=await companionVoice.localStoryClip(text,Number(url.searchParams.get('clip')));
          res.writeHead(200,{'Content-Type':voiceConfiguration.mediaType(audio),...(audio.usedOwnKey?{'X-Pet-Voice-Source':'own-key'}:{}),'Cache-Control':'private, no-store','X-Pet-Story-Clips':count});
          return res.end(audio);
        }
        const audio=fs.existsSync(file)?fs.readFileSync(file):await companionVoice.speak(text,{purpose:'story'});
        res.writeHead(200,{'Content-Type':voiceConfiguration.mediaType(audio),...(audio.usedOwnKey?{'X-Pet-Voice-Source':'own-key'}:{}),'Cache-Control':'private, no-store'});
        return res.end(audio);
      }
      if (!fs.existsSync(file) && !visitAudioJobs.has(key)) {
        const job = (async () => {
          const bytes = Number.isSafeInteger(state.voiceBalance)
            ? await meteredSpeak(text,undefined,backgroundSpeechQueue)
            : await voice.speak(text,{voiceProfile:state.voiceProfile});
          fs.mkdirSync(dir,{recursive:true});
          fs.writeFileSync(file+'.tmp',bytes);
          fs.renameSync(file+'.tmp',file);
        })().finally(() => visitAudioJobs.delete(key));
        visitAudioJobs.set(key,job);
      }
      await visitAudioJobs.get(key);
      const bytes = fs.readFileSync(file);
      res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'private, max-age=86400'});
      return res.end(bytes);
    } catch (err) {
      const diagnostic=chatDiagnostics.record(err,{stage:action==='story'?'story_language':'story_audio'});
      const languageError=err.diagnostic?.code==='story_language_mismatch'?'这次英文故事仍返回了中文，请再试一次或打开原版。':err.diagnostic?.code==='story_too_short'?'这次故事正文不完整，请再试一次或打开原版。':null;
      return json(res,err.status||502,{code:err.diagnostic?.code||err.code||diagnostic.code,stage:err.diagnostic?.stage||diagnostic.stage,error:languageError||(err.status?err.message:action==='story'?'这个语言版本还没准备好，可以再试一次或打开原版。':'这段故事的声音还没准备好，可以先读文字。')});
    }
  }
  if(req.method==='GET'){
    const visitAvatar=/^\/api\/visit\/avatar\/([a-f0-9-]{36})$/.exec(url.pathname);
    if(visitAvatar){
      const avatar=visits?visits.avatar(visitAvatar[1]):null;
      if(!avatar)return json(res,404,{error:'这只宠物的照片还没有准备好。'});
      try{const bytes=fs.readFileSync(avatar.file);res.writeHead(200,{'Content-Type':avatar.type,'Cache-Control':'private, max-age=86400'});return res.end(bytes);}
      catch{return json(res,404,{error:'这只宠物的照片还没有准备好。'});}
    }
    const visitPhoto=/^\/api\/visit\/([a-f0-9-]{36})\/photo\/(\d+)$/.exec(url.pathname);
    if(visitPhoto){const record=visits?.read(visitPhoto[1]);const bytes=visitAvailable(record)?visits.photo(visitPhoto[1],Number(visitPhoto[2]),userId):null;if(!bytes)return json(res,404,{error:'这张照片没有找到。'});res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=3600'});return res.end(bytes);}
  }
  if (req.method === 'GET' && url.pathname === '/api/trips') {
    // 串门故事和旅行故事共用故事本：提前放出来的（preview）也一并给，按 id 去重。
    const v = visitView();
    const seen = new Set();
    let visitItems = [...(v.previewVisits || []), ...(v.archive || [])].filter(item => (seen.has(item.id) ? false : (seen.add(item.id), true)));
    // 连了线上家的便携版：把线上串门条目也并进同一个故事本（失败的合并不影响本地内容）。
    if (onlineVisits) {
      try {
        const remote = await onlineVisits();
        for (const item of Array.isArray(remote) ? remote : []) {
          if (item && item.id && !seen.has(item.id)) { seen.add(item.id); visitItems.push(item); }
        }
      } catch {}
    }
    visitItems.sort((a, b) => String(b.storyDate || b.date || '').localeCompare(String(a.storyDate || a.date || '')));
    return json(res, 200, { trips: trips.list(), visits: visitItems });
  }
  const tripRoute = url.pathname.match(/^\/api\/trips\/(\d{4}-\d{2}-\d{2})(?:\/(story|audio)(?:\/([01]))?)?$/);
  if (tripRoute) {
    const [,date,action,index] = tripRoute;
    if (req.method === 'GET' && !action) {
      const trip = trips.view(date);return json(res, trip.status === 'none' ? 404 : 200, trip);
    }
    if (req.method === 'POST' && action) {
      try {
        if (action === 'story') {
          const existing=trips.view(date);
          if(existing.status==='none')return json(res,404,{error:'这段旅行还没有收进相册。'});
          if(existing.story)return json(res,200,existing);
          if(!existing.photos.length)return json(res,409,{error:'照片还在准备中。'});
          trips.ensureStory(date).catch(()=>{});
          return json(res,202,trips.view(date));
        }
        if(companionVoice?.usesLocal()&&index!==undefined&&url.searchParams.has('clip')){
          const trip=trips.view(date);
          if(!trip.story||trip.status!=='ready'||trip.photos.length!==2)return json(res,409,{error:'旅行故事还在准备中。'});
          const {audio,count}=await companionVoice.localStoryClip(segmentText(trip.story,Number(index)),Number(url.searchParams.get('clip')));
          res.writeHead(200,{'Content-Type':voiceConfiguration.mediaType(audio),...(audio.usedOwnKey?{'X-Pet-Voice-Source':'own-key'}:{}),'Cache-Control':'private, no-store','X-Pet-Story-Clips':count});
          return res.end(audio);
        }
        const bytes = await trips.audio(date, index === undefined ? -1 : Number(index));
        res.writeHead(200, { 'Content-Type':voiceConfiguration.mediaType(bytes),...(bytes.usedOwnKey?{'X-Pet-Voice-Source':'own-key'}:{}),'Cache-Control':companionVoice?'private, no-store':'private, max-age=86400' });return res.end(bytes);
      } catch(err) { return json(res, err.status || 502, {code:err.code, error: err instanceof voice.VoiceError || err.code?.startsWith('voice_') ? err.message : '这次旅行故事没准备好，可以稍后再试。' }); }
    }
  }
  if(req.method==='GET'&&url.pathname.startsWith('/api/media/')){const id=url.pathname.split('/').pop(),p=media.get(id);if(!p)return json(res,404,{error:'照片没有找到。'});res.writeHead(200,{'Content-Type':p.type,'Cache-Control':'private, max-age=3600'});return res.end(media.bytes(id));}
  if(req.method==='POST'&&url.pathname==='/api/photos'){
    try{let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>12*1024*1024)return json(res,413,{error:'选一张8MB以内的照片吧。'});chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());if(typeof body.actionId!=='string'||body.actionId.length>100)return json(res,400,{error:'重新选一次照片吧。'});
      const old=state.photos.find(p=>p.uploadActionId===body.actionId);if(old)return json(res,200,{photo:media.publicPhoto(old)});
      const p=await uploadPhoto(body,media,dataDir);p.uploadActionId=body.actionId;if(p.selfLabeled)state.ownerPhotoId=p.id;save();return json(res,200,{photo:media.publicPhoto(p)});
    }catch{return json(res,400,{error:'照片没能保存。请选择 JPG、PNG 或 WebP 图片再试一次。'});}
  }
  if(companionDisabled&&url.pathname.startsWith('/api/companion'))return json(res,404,{error:'没有找到这个操作。'});
  if (req.method === 'GET' && url.pathname === '/api/companion') return json(res,200,{mode:companion.settings(companionDisabled?null:state.companion).mode,voiceBalance:state.voiceBalance??null});
  if (companionVoice && req.method==='GET' && url.pathname==='/api/companion/voice') return json(res,200,await companionVoice.view());
  if (companionVoice && req.method==='GET' && url.pathname==='/api/companion/voice/readiness') return json(res,200,companionVoice.readiness());
  const localPreview = /^\/api\/companion\/voice\/preview\/(local-(?:soft|warm))$/.exec(url.pathname);
  if (companionVoice && req.method==='GET' && localPreview && voiceConfiguration.localMode()) {
    const offline=require('./local-speech');
    const file=path.join(offline.root,localPreview[1]+'.wav');
    if (!offline.installation()||!fs.existsSync(file)) return json(res,404,{error:'本机试听还没准备好。'});
    res.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'private, no-store'});
    return res.end(fs.readFileSync(file));
  }
  if (req.method === 'POST' && (['/api/voice/transcribe', '/api/voice/chat', '/api/voice/speak','/api/companion/settings'].includes(url.pathname)||companionVoice&&url.pathname==='/api/companion/voice')) {
    const requestId=chatDiagnostics.requestId();
    res.setHeader('X-Request-ID',requestId);
    let requestStage='request_parse';
    let releaseTranscription;
    const transcriptionAbort=new AbortController();
    const cancelTranscription=()=>{if(!res.writableEnded)transcriptionAbort.abort();};
    req.once('aborted',cancelTranscription);res.once('close',cancelTranscription);
    try {
      if(url.pathname.endsWith('/transcribe'))releaseTranscription=await liveTranscriptionQueue.acquire(transcriptionAbort.signal);
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 12 * 1024 * 1024) return json(res, 413, { error: '声音文件太长啦，请讲短一点。' }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      chunks.length=0;
      if(url.pathname==='/api/companion/voice')return json(res,200,await companionVoice.configure(body,transcriptionAbort.signal));
      if(url.pathname==='/api/companion/settings'){
        if(!companion.MODES.includes(body.mode))return json(res,400,{error:'请选择陪伴语言。'});
        if (body.mode !== companion.settings(companionDisabled?null:state.companion).mode) languageRevision++;
        state.companion={...state.companion,mode:body.mode};save();
        return json(res,200,{mode:body.mode});
      }
      if (url.pathname.endsWith('/transcribe')) return json(res, 200, { text: await voice.transcribe(body,undefined,{signal:transcriptionAbort.signal}) });
      if (url.pathname.endsWith('/speak')) {
        const audio=companionVoice?await companionVoice.speak(body.text,{signal:transcriptionAbort.signal}):Number.isSafeInteger(state.voiceBalance)?await meteredSpeak(body.text,transcriptionAbort.signal):
          await voice.speak(body.text,{voiceProfile:state.voiceProfile,signal:transcriptionAbort.signal});
        res.writeHead(200, { 'Content-Type': voiceConfiguration.mediaType(audio), ...(audio.usedOwnKey?{'X-Pet-Voice-Source':'own-key'}:audio.usedFreeWhileSyncing?{'X-Pet-Voice-Source':'free-while-syncing'}:{}), 'Cache-Control': 'no-store' }); return res.end(audio);
      }
      if (body.actionId && state.chatArchive.some(m => m.actionId === body.actionId && m.role === 'assistant')) {const recorded=state.chatArchive.find(m => m.actionId === body.actionId && m.role === 'assistant');return json(res,200,{reply:recorded.content,requestId:recorded.requestId||requestId,...(recorded.degraded?{degraded:true,code:recorded.diagnosticCode,stage:recorded.diagnosticStage}:{})});}
      const message=typeof body.message==='string'?body.message.trim():'';
      if(message.length>2000||(!message&&!body.photoId&&!body.referencePhotoId))return json(res,400,{error:'说一句话或选一张照片吧。'});
      const photo=media.get(body.photoId||body.referencePhotoId);
      if((body.photoId||body.referencePhotoId)&&!photo)return json(res,404,{error:'这张照片没有找到。'});
      const text=message||(photo?.selfLabeled?'这是我，看看我今天的照片吧！':state.name+'，看看这张照片吧！');
      const memoryRevision = state.memoryRevision;
      let visualContext='';
      requestStage='photo_analysis';
      if(photo){if(photo.kind==='trip'){visualContext=photo.caption+' 地点：'+photo.place+'，日期：'+photo.date+'。这是一张'+state.name+'的旅行照片。 '+await voice.describePhoto([media.dataUrl(photo.id)],text,{interactive:true,signal:transcriptionAbort.signal});if(!photo.visualDescription)photo.visualDescription=visualContext;save();}
        else{visualContext=await voice.describePhoto([media.dataUrl(photo.id)],text,{interactive:true,signal:transcriptionAbort.signal});if(!photo.analyzedAt){photo.caption=visualContext;photo.analyzedAt=Date.now();}if(photo.selfLabeled)state.ownerPhotoId=photo.id;
          memory.put({type:'photo',key:photo.selfLabeled?'owner-reference':'photo-'+photo.id,text:(photo.selfLabeled?'孩子主动标记这是自己。':'孩子分享了照片。')+photo.caption.slice(0,150)},photo.id);save();}}
      requestStage='chat_prepare';
      const photoContext={referencedPhoto:photo?{id:photo.id,description:visualContext,selfLabeled:!!photo.selfLabeled,date:photo.date,place:photo.place,activity:photo.activity,formLevel:photo.formLevel,formImage:photo.formImage}:null,ownerReference:media.get(state.ownerPhotoId)?.caption||null};
      const mode=companion.settings(companionDisabled?null:state.companion).mode;
      const revision=languageRevision;
      const progress=state.companionListening?.[mode];
      const configured=companion.settings({...state.companion,level:progress?.level});
      const language=companion.forTurn(configured,text);
      const preceding=state.chatMessages?.at(-1);
      const heardEnglish=body.spoken===true&&typeof body.heardReplyId==='string'&&preceding?.role==='assistant'&&
        preceding.actionId===body.heardReplyId&&preceding.mode===mode&&/[a-z]{2,}/i.test(preceding.content);
      let evidence;
      const readingContext=readingTopics.context(text,state.chatMessages||[]);
      requestStage='chat_reply';
      const {reply,degraded,code:diagnosticCode,stage:diagnosticStage} = await voice.chatWithRecovery(text, state.chatMessages || [], {...view(),photoContext,readingContext,storyContext:relevantStories(text),companion:language}, memory.relevant(text),
        heardEnglish&&language.level===configured.level?value=>{evidence=value;}:undefined,{signal:transcriptionAbort.signal,requestId});
      requestStage='chat_save';
      if(degraded)evidence=undefined;
      const recorded=body.actionId&&state.chatArchive.find(m=>m.actionId===body.actionId&&m.role==='assistant');
      if(recorded)return json(res,200,{reply:recorded.content,requestId:recorded.requestId||requestId,...(recorded.degraded?{degraded:true,code:recorded.diagnosticCode,stage:recorded.diagnosticStage}:{})});
      if(evidence?.understood===true&&revision===languageRevision&&memoryRevision===state.memoryRevision&&preceding===state.chatMessages?.at(-1)){
        state.companionListening ||= {};
        const observation=state.companionListening[mode] ||= {level:configured.level,observations:[]};
        const next=companion.recordEvidence(observation,configured,evidence);
        if(next.level!==configured.level)state.companionListening[mode]={level:next.level,observations:[]};
      }
      state.chatMessages ||= [];
      chatHistory.append(state, text, reply, body.actionId);
      Object.assign(state.chatArchive.at(-1),{requestId,degraded,...(degraded?{diagnosticCode,diagnosticStage}:{})});
      const userRecord=state.chatArchive.at(-2);if(body.photoId)userRecord.photoIds=[photo.id];if(body.referencePhotoId)userRecord.referencePhotoId=photo.id;
      if (memoryRevision === state.memoryRevision) {
        state.chatMessages.push({ role: 'user', content: text+(photo?' [照片内容：'+visualContext+']':''), actionId: body.actionId }, { role: 'assistant', content: reply, actionId: body.actionId, ...(readingContext.excerpts[0]?{readingStoryId:readingContext.excerpts[0].storyId}:{}), mode:degraded?undefined:mode });
        state.chatMessages = state.chatMessages.slice(-24); save();
        memory.learn(text, body.actionId || crypto.randomUUID());
      }
      save();
      return json(res, 200, {reply,degraded,requestId,...(degraded?{code:diagnosticCode,stage:diagnosticStage}:{})});
    } catch (err) { const diagnostic=chatDiagnostics.record(err,{requestId,stage:url.pathname.endsWith('/chat')?requestStage:url.pathname.split('/').at(-1)});return json(res,err.status||502,{requestId,code:err.code||diagnostic.code,stage:diagnostic.stage,error:err instanceof voice.VoiceError || err.status===429 || err.code?.startsWith('voice_') ? err.message : '刚才没有完成，请再试一次。'}); }
    finally{releaseTranscription?.();req.removeListener('aborted',cancelTranscription);res.removeListener('close',cancelTranscription);}
  }
  if (req.method === 'GET' && url.pathname === '/api/pet') return json(res, 200, {...view(),...(localFirst?{storyPreparation:trips.preparation()}:{})});
  if (req.method === 'GET' && url.pathname.startsWith('/api/animations/')) {
    const file=animation.asset(url.pathname);
    if(!file)return json(res,404,{error:'动作还没准备好。'});
    res.writeHead(200,{'Content-Type':file.endsWith('.json')?'application/json; charset=utf-8':'image/png','Cache-Control':'private, no-store'});
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/evolutions/')) {
    const form = state.evolution.forms.find(f => f.image === url.pathname) || (state.previousEvolutions||[]).flatMap(e=>e.forms).find(f=>f.image===url.pathname);
    if (!form) return json(res, 404, { error: '这个形态还没有准备好。' });
    const file = path.join(dataDir, 'evolutions', form.file);
    if (!fs.existsSync(file)) return json(res, 404, { error: '这个形态暂时没有找到。' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/recordings/')) {
    const id = url.pathname.split('/').pop();
    const story = state.stories.find(s => s.id === id && s.audioType);
    if (!story) return json(res, 404, { error: '这段录音没有找到。' });
    return serveRecording(req,res,path.join(dataDir,id+'.audio'),story.audioType);
  }
  if (req.method === 'POST' && ['/api/story', '/api/claim', '/api/cook', '/api/feed', '/api/evolve', '/api/animate', '/api/trip/retry', '/api/room', '/api/birthday', '/api/celebrate', '/api/memory/delete'].includes(url.pathname)) {
    try {
      let chunks = [], size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) { json(res, 413, { error: '录音太长啦，请讲一个短一点的故事。' }); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!body.actionId || typeof body.actionId !== 'string' || body.actionId.length > 100) return json(res, 400, { error: '请重新试一次。' });
      if(url.pathname==='/api/story'){
        const oldStory=state.stories.find(story=>story.actionId===body.actionId);
        if(oldStory)return json(res,200,{...view(),storyReward:storyRewards.result(state,oldStory,Date.now(),true)});
      }
      if (state.actions.includes(body.actionId)) return json(res, 200, view());
      let submittedStory;
      if (url.pathname === '/api/story') {
        const transcript = typeof body.transcript === 'string' ? body.transcript.trim().slice(0, 2000) : '';
        const allowedTypes = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a', 'audio/aac', 'audio/x-wav'];
        const audioType = typeof body.audioType === 'string' ? body.audioType.split(';')[0] : '';
        const audio = typeof body.audio === 'string' ? Buffer.from(body.audio, 'base64') : null;
        if (!transcript && !(audio && audio.length >= 1000 && allowedTypes.includes(audioType))) return json(res, 400, { error: '先讲一小段故事，再告诉钻钻吧。' });
        if (audio && !allowedTypes.includes(audioType)) return json(res, 400, { error: '请选一段录音文件。' });
        const id = crypto.randomUUID();
        if (audio) fs.writeFileSync(path.join(dataDir, id + '.audio'), audio);
        submittedStory={id,actionId:body.actionId,transcript,createdAt:Date.now(),audioType:audio?audioType:null};
      state.stories.unshift(submittedStory);
      state.readings++;
      storyRewards.grant(state,submittedStory);
      home.grantVisitCredit(state);
      trips.prepare(submittedStory);
      if(onlineReport&&!localFirst)try{onlineReport(submittedStory);}catch{}
        void readingTopics.schedule(state.stories[0]);
      } else if (url.pathname === '/api/memory/delete') {
        if (!memory.remove(body.id)) return json(res, 404, { error: '这条记忆已经不在啦。' });
      } else if (url.pathname === '/api/trip/retry') {
        if(!(localFirst?trips.resume(true):trips.start(true)))return json(res,409,{error:'没有待补的旅行照片，或照片正在准备。'});
      } else if (url.pathname === '/api/animate') {
        if (animation.view().status==='ready') return json(res,409,{error:'钻钻的动作已经准备好啦。'});
        if (!animation.start()) return json(res,409,{error:'动作正在准备，或还没有可以绑定的新形态。'});
      } else if (url.pathname === '/api/evolve') {
        if (!evolution.view().complete) return json(res, 409, { error: '这次进化的动作还没准备齐全，请先完成动作，再进行下一次进化。' });
        if (!evolution.view().eligible) return json(res, 409, { error: '还没到进化的时候，继续喂钻钻吧。' });
        evolution.start();
      } else {
        home.action(state, url.pathname.slice(5), body);
        if (url.pathname === '/api/feed' && state.evolution.status === 'idle') evolution.start();
      }
      state.actions.push(body.actionId);
      state.actions = state.actions.slice(-500);
      save();
      return json(res, 200, {...view(),...(submittedStory?{storyReward:storyRewards.result(state,submittedStory)}:{})});
    } catch (err) {
      console.error('请求未完成:', err.message);
      return json(res, err.status || 400, { error: err.status ? err.message : '刚才没有保存成功，请再试一次。' });
    }
  }
  if (req.method !== 'GET') return json(res, 405, { error: '这个操作暂时不能用。' });
  let filename;
  try { filename = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
  catch { return json(res, 400, { error: '地址不正确。' }); }
  if (!filename.startsWith(root + path.sep)) return json(res, 403, { error: '这里不能打开。' });
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return json(res, 404, { error: '没有找到这个页面。' });
  res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(filename).pipe(res);
};
return {handle,state,save,view,meteredSpeak,companionVoice,rememberHarvest,preparePet:()=>animation.ensureCurrent(),animation,rememberWork:completion=>{memory.put({type:'work',key:completion.id,text:'完成工作“'+completion.work.job.title+'”：'+(completion.input||'已完成每日约定').slice(0,180)},completion.id);}};
}
module.exports={createPetRuntime};
