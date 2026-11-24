const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {reserveStoryEvent}=require('./story-events');
const localAgent=require('./local-agent');
const companionLanguage=require('./companion-language');
const { run } = require('./evolution-service');
const {spawn}=require('node:child_process');
// The image worker writes this checkpoint before exiting. It also survives a service restart.
function lastImageEvent(marker){
 if(!marker)return undefined;
 try{return JSON.parse(fs.readFileSync(marker+'.diagnostic.json','utf8'));}catch{return undefined;}
}
function runTripImage(command,args,env,timeoutMs=900000){
 return new Promise((resolve,reject)=>{
  let stderr='',timedOut=false,done=false;
  const child=spawn(command,args,{env,windowsHide:true,stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-16000)});
  const timer=setTimeout(()=>{timedOut=true;child.kill()},timeoutMs);
  function finish(cause,code,signal){if(done)return;done=true;clearTimeout(timer);
   if(stderr.includes('IMAGE_DIAGNOSTIC_WRITE_FAILED'))console.warn(JSON.stringify({event:'trip_image_diagnostic_write_failed',job:env.PET_IMAGE_JOB_MARKER?path.basename(path.dirname(env.PET_IMAGE_JOB_MARKER)):undefined}));
   if(!cause&&!timedOut&&code===0)return resolve();
   let detail=stderr;for(const key of ['OPENAI_API_KEY','PET_IMAGE_API_KEY','PET_IMAGE_FALLBACK_KEY'])if(env[key])detail=detail.split(env[key]).join('[redacted]');
   detail=detail.replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/https?:\/\/[^\s"']+/gi,'[url]').replace(/sk-[A-Za-z0-9_-]{8,}/g,'[redacted]').slice(-6000);
   const events=stderr.split(/\r?\n/).flatMap(line=>{if(!line.startsWith('IMAGE_EDIT '))return [];try{return [JSON.parse(line.slice(11))];}catch{return [];}});
   const checkpoint=lastImageEvent(env.PET_IMAGE_JOB_MARKER);
   const last=events.at(-1);
   const e=new Error('旅行照片没有完成。');e.diagnostic={stage:'拍摄旅行照片',...(timedOut?{timeout:true,timeoutMs,code:'image_request_outcome_unknown'}:{exitCode:code,signal,...(last?.stage==='failed'?{code:last.code,status:last.status,retryable:last.retryable===true}:{})}),...(cause?{reason:'tool_unavailable',code:cause.code||'UNKNOWN'}:{}),imageEvent:checkpoint||last,detail};reject(e);
  }
  child.once('error',e=>finish(e,null,null));child.once('close',(code,signal)=>finish(null,code,signal));
 });
}
const { python } = require('./photo-service');
const voice = require('./voice-service');
const { planStory, planStoryFromPhotos, publicStory, segmentText } = require('./travel-story');
const {personalizeStory}=require('./child-name');
const PLACES = [['萤光森林','沿着苔藓小路找发光的蘑菇'],['贝壳海湾','在沙滩上收集漂亮的贝壳'],['花朵山谷','在花丛间看蝴蝶飞舞'],['星光湖边','在湖边看星星的倒影'],['彩虹花园','在花架下听小鸟唱歌'],['云朵城堡','在城堡露台看软软的云'],['秋叶小径','把落叶摆成一颗爱心'],['雪花小镇','在暖暖的小屋外看雪花']];
function day(now = Date.now()) { return new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(now)); }
function yesterday(now = Date.now()) { return day(now - 86400000); }
function tomorrow(now = Date.now()) { return day(now + 86400000); }
function promptForPhoto(trip, index, feedback = '') {
  if (trip.guestName) return promptForVisitPhoto(trip, index, feedback);
  const scene = trip.story.scenes[index];
  return `Create one cinematic storybook travel moment starring Zuanzuan, the SAME CURRENT evolved pink gemstone ballet kitten in the reference. The reference is an IDENTITY AND COSTUME guide ONLY, NOT a pose or composition template. Preserve recognizable face, pink fur, crown, costume, wings if present, and current accessories. Do not invent/remove wings or change evolution. Completely re-pose the body, head, limbs and expression for the story action; no default front-facing ballet showcase.\nLocation: ${trip.place}. Story: ${trip.story.title}.\nTHIS SPECIFIC MOMENT: ${scene.imagePrompt}\nCaption meaning to depict (do not render text): ${scene.caption}\nMoment narration: ${scene.narration}\nBody action: ${scene.actionKey}. Camera: ${scene.cameraKey}.\nOther moment in this trip (for continuity and contrast, do NOT depict it): ${trip.story.scenes[1-index].imagePrompt}\n${feedback ? 'Previous candidate rejected; correct these visible problems: '+feedback : ''}\nThe character is absorbed in this experience, with gaze directed at the story object, not posing for the viewer unless explicitly motivated by the scene. Scene details and props must make the event readable. ${trip.companion ? `Two separate pets are present in the same room: the reference pet and one visiting child's pet named ${trip.companion}. Both bodies fully visible and clearly interacting, never fused into one creature. No humans.` : 'One kitten only, no humans.'} Polished exquisite 3D fairytale illustration, natural light, full scenic background, NOT transparent. No typography, watermark, frame or split panels.`;
}
// 串门：两只宠物同框。参考图各管一只，最难的是别把两只画混、画成一只。
function promptForVisitPhoto(trip, index, feedback = '') {
  const scene = trip.story.scenes[index];
  const host = trip.hostName || 'the host pet', guest = trip.guestName;
  const identity = (label, role, ref, custom, name) => custom
    ? `${label} — ${role} ${name}, from reference image ${ref}. Copy its exact species, colors, body shape, face and every visible accessory; never reinterpret it.`
    : `${label} — ${role} ${name}, from reference image ${ref}. Copy its exact face, colors, body shape, costume and every visible accessory; never reinterpret it.`;
  const other = trip.story.scenes[1 - index];
  return `Create one cinematic storybook illustration of moment ${index + 1} of 2 in ONE continuous event between TWO pet characters. The two images are two beats of the same story, so this one must show a DIFFERENT stage, place in the room and camera than the other beat. Each reference image is an IDENTITY AND COSTUME guide ONLY, never a pose or composition template. Fully re-pose both bodies, heads, limbs and expressions for this action.
${identity('PET A', 'the host,', 1, trip.hostCustom, host)}
${identity('PET B', 'the guest,', 2, trip.guestCustom, guest)}
In the moment description below, "the host pet" means PET A and "the visiting pet" means PET B.

TWO DISTINCT INDIVIDUALS — the most important rule:
- Exactly two creatures in frame. Never fuse them into one body, never let one become the other, never merge them into a single silhouette.
- Never move a feature from one to the other: no shared fur color, markings, ear shape, tail, wings, crown, dress, ribbon or accessory. Each keeps only what its own reference shows.
- If their designs are similar (for example both are pink cats in dresses), keep them unmistakably separate by each one's own exact details (dress cut, headwear, eye color, markings, ear shape, body size), and separate them in depth and angle so both faces stay readable. If unsure, keep them slightly apart instead of tangled.
- The two references may look almost identical (two pets of the same design). That is expected and still means TWO pets: draw both as separate bodies in different poses and positions, and a viewer must be able to count two. Never render one pet once and call it done.
- No humans, no third pet, no mirrored duplicate of the same pet.

BOTH PETS MUST BE BUSY:
- Each pet has a visible action aimed at the same object; never one pet working while the other just stands, sits or watches.
- NOBODY LOOKS AT THE VIEWER. If the moment says their eyes meet, they look at each other's face; if it says they look at the object, both eyes go to the object. Eyes facing the lens is a failed image, even if the expression is cute.
- Do not add extra toys, balls, cushions or props that this moment does not mention. Everything in frame must come from the description.
- Place the two pets where this moment's description puts them. Do not default to a side-by-side lineup facing the viewer; if the other beat already reads as two pets lying abreast on the floor, this one must not repeat that arrangement.

Location: ${trip.place}, the host's own familiar place. Story: ${trip.story.title}.
THIS SPECIFIC MOMENT: ${scene.imagePrompt}
Caption meaning to depict (do not render text): ${scene.caption}
Moment narration: ${scene.narration}
Host body action: ${scene.actionKey}. Camera for this beat: ${scene.cameraKey}.
The OTHER beat of this same story, already decided, must look clearly different from yours: ${other.imagePrompt}
So: do not repeat the other beat's framing, camera distance or placement. Whatever shot you pick has to make THIS moment readable on its own; if the result could pass for a second angle of the other beat, it has failed.
Same props for continuity: any ball, cushion, box or food must keep the exact same colour, size and material in both beats.
${feedback ? 'Previous candidate rejected; correct these visible problems: ' + feedback + '\n' : ''}Both pets are doing something in this moment and visibly affect each other — never one acting while the other just stands by. Their bodies and attention connect through the same object or action. The scene props must make the shared event readable.
Polished exquisite 3D fairytale illustration, natural light, full scenic background, NOT transparent. No typography, watermark, frame or split panels.`;
}
// Account runtimes can all become eligible at midnight. Cap how many image requests
// reach the provider at once instead of running strictly one after another.
const IMAGE_CONCURRENCY = Math.min(6, Math.max(1, Number(process.env.PET_IMAGE_CONCURRENCY) || 6));
const IMAGE_MAX_WAITING = Math.max(0, Number(process.env.PET_IMAGE_MAX_WAITING) || 24);
const IMAGE_MEM_FLOOR_MB = Math.max(64, Number(process.env.PET_IMAGE_MEM_FLOOR_MB) || 180);
// 内存一直不够时不能无限等：排队超过这个时长就明确失败，否则调用方会永远停在"生成中"。
const IMAGE_QUEUE_MAX_HOLD_MS = Math.max(60000, Number(process.env.PET_IMAGE_QUEUE_MAX_HOLD_MS) || 900000);
let activeImages = 0, memHoldTimer = null;
const waitingImages = [];

function availableMemMb() {
  try {
    const matched = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
    return matched ? Number(matched[1]) / 1024 : Infinity;
  } catch { return Infinity; }
}

function pumpImages() {
  if (memHoldTimer) return;
  while (activeImages < IMAGE_CONCURRENCY && waitingImages.length) {
    if (availableMemMb() < IMAGE_MEM_FLOOR_MB) {
      for (const item of waitingImages) item.blockedBy = 'memory';
      memHoldTimer = setTimeout(() => { memHoldTimer = null; pumpImages(); }, 2000);
      return;
    }
    const item = waitingImages.shift();
    clearTimeout(item.timer);
    activeImages++;
    Promise.resolve()
      .then(item.start)
      .then(item.resolve, item.reject)
      .catch(() => {})
      .finally(() => { activeImages--; pumpImages(); });
  }
}

function generateTripPhoto(input) {
  return new Promise((resolve, reject) => {
    if (waitingImages.length >= IMAGE_MAX_WAITING) {
      reject(Object.assign(new Error('今天的旅行照片有点多，过一会儿再试一次。'),{diagnostic:{stage:'排队等待',code:'image_queue_full',retryable:true}}));
      return;
    }
    const item={start:()=>renderTripPhoto(input),resolve,reject,blockedBy:null,timer:setTimeout(()=>{
      const ix=waitingImages.indexOf(item);
      if(ix<0)return;
      waitingImages.splice(ix,1);
      reject(Object.assign(new Error('电脑有点忙，照片还没开始画。'),{diagnostic:{stage:'排队等待',code:'image_queue_timeout',retryable:true,holdMs:IMAGE_QUEUE_MAX_HOLD_MS,availableMb:availableMemMb(),memoryFloorMb:IMAGE_MEM_FLOOR_MB,activeImages,imageConcurrency:IMAGE_CONCURRENCY,observedMemoryHold:item.blockedBy==='memory'}}));
    },IMAGE_QUEUE_MAX_HOLD_MS)};
    waitingImages.push(item);
    pumpImages();
  });
}
async function renderTripPhoto({ formFile, guestFile, roomFile, trip, index, dir, feedback, allowResubmit=false }) {
  fs.mkdirSync(dir,{recursive:true});
  const prompt = path.join(dir,'prompt.txt'), raw = path.join(dir,'source.png'), final = path.join(dir,'photo.jpg');
  const checkpoint = path.join(dir, 'validated-source.img');
  async function normalize(source) {
    try {
      const pending = final + '.tmp';
      await run(python(),[path.join(__dirname,'scripts/normalize-photo.py'),source,pending],process.env,'保存旅行照片');
      fs.renameSync(pending,final);
      return fs.readFileSync(final);
    } catch (error) {
      error.diagnostic = {...error.diagnostic,stage:'保存旅行照片',code:'image_local_normalize_failed',retryable:true};
      throw error;
    }
  }
  if (fs.existsSync(final)) return fs.readFileSync(final);
  const savedSource = [checkpoint, raw].find(file=>fs.existsSync(file));
  if (savedSource) return normalize(savedSource);
  const marker=path.join(dir,'request-started');
  if (!allowResubmit && fs.existsSync(marker)) throw Object.assign(Error('上次画图的结果尚未确认。'),{diagnostic:{stage:'拍摄旅行照片',code:'image_request_outcome_unknown',retryable:false,imageEvent:lastImageEvent(marker)}});
  if (!localAgent.enabled() && (process.env.PET_LOCAL_FIRST==='1'||!process.env.PET_IMAGE_API_KEY)) throw Error('图片生成还没有连接 Agent。');
  const base = promptForPhoto(trip,index,feedback);
  // 串门的两只宠物各自用参考图决定外观，不能再套默认猫的替换文案。
  const text = roomFile ? base+' Use image 3 as the reference for the room and its important visible features.' :
    trip.guestName || !trip.customPet ? base : base.replace('Zuanzuan, the SAME CURRENT evolved pink gemstone ballet kitten','the SAME pet character').replace('face, pink fur, crown, costume, wings if present, and current accessories','face, colors, body shape and all visible accessories').replaceAll('kitten','pet character');
  fs.writeFileSync(prompt,text);
  const images = [formFile,guestFile,roomFile].filter(Boolean);
  if(localAgent.enabled()){
    try{
      await localAgent.generateImage({prompt:text,files:images,destination:raw,onStart:()=>fs.writeFileSync(marker,localAgent.provider())});
    }catch(error){
      if(fs.existsSync(marker))error.diagnostic={stage:'拍摄旅行照片',code:'image_request_outcome_unknown',retryable:false};
      throw error;
    }
    return normalize(raw);
  }
  const env = { ...process.env,OPENAI_API_KEY:process.env.PET_IMAGE_API_KEY,OPENAI_BASE_URL:process.env.PET_IMAGE_BASE_URL,PYTHONUTF8:'1',PET_IMAGE_JOB_MARKER:marker,PET_IMAGE_VALIDATED_SOURCE:checkpoint };
  try {
    await runTripImage(python(),[process.env.PET_IMAGE_CLI||path.join(__dirname,'scripts/image_gen.py'),'edit','--model',process.env.PET_TRIP_IMAGE_MODEL||process.env.PET_IMAGE_MODEL||'gpt-image-2',...images.flatMap(file=>['--image',file]),'--prompt-file',prompt,'--size','1024x1024','--quality','high','--output-format','png','--out',raw],env,900000);
  } catch (error) {
    if (!fs.existsSync(checkpoint)) throw error;
    return normalize(checkpoint);
  }
  return normalize(fs.existsSync(checkpoint) ? checkpoint : raw);
}
function createTrips({ state,save,dataDir,media,memory,visits=null,userId='',localFirst=false,generator=generateTripPhoto,planner=planStory,legacyPlanner=planner===planStory?planStoryFromPhotos:planner,reviewer=voice.reviewTravelPhoto,describe=voice.describePhoto,speaker=voice.speak,speakerIdentity=()=>voice.speechCacheIdentity(state.voiceProfile),now=()=>Date.now() }) {
  state.trips ||= {};
  for (const trip of Object.values(state.trips)) {
    if (trip.status==='generating') { trip.status='failed';trip.error='上次旅行准备中断了，可以继续准备。';trip.diagnostic={stage:trip.pendingPhoto?'拍摄旅行照片':'创作旅行故事',code:'trip_interrupted',imageEvent:trip.pendingPhoto?.file?lastImageEvent(path.join(path.dirname(trip.pendingPhoto.file),'request-started')):undefined};trip.resumeInterrupted=true; }
    if (trip.storyStatus==='generating') trip.storyStatus='failed';
  }
  let active=false,completion=Promise.resolve();
  const storyJobs = new Map(), audioJobs = new Map();
  function eligible() { return state.stories.some(s=>day(s.createdAt)===yesterday(now())); }
  function visible(t){return !!t&&(!t.sourceReadingDay||t.date<=day(now()));}
  function preparation(){
    const t=Object.values(state.trips).filter(item=>item.sourceReadingDay&&!visible(item)).sort((a,b)=>b.date.localeCompare(a.date))[0];
    return t?{date:t.date,status:t.status,error:t.error||'',stage:t.diagnostic?.stage||''}:null;
  }
  let describedForm = null;
  function currentReference() {
    const form=state.evolution?.forms.at(-1), profile=state.petProfile;
    return {image:form?.image||profile?.image||'/assets/zuanzuan.png',level:form?.level||0,custom:!!profile,
      file:form?path.join('evolutions',form.file):profile?.file||null};
  }
  function startReference(trip) {
    const current=currentReference();
    const recorded=media.get(trip.photos[0]);
    const image=recorded?.formImage||trip.pendingPhoto?.formImage;
    if(!image||image===current.image)return current;
    const history=state.previousEvolutions||[];
    const form=[...(state.evolution?.forms||[]),...history.flatMap(item=>item.forms)].find(item=>item.image===image);
    if(form)return {image,level:form.level,custom:!!trip.customPet,file:path.join('evolutions',form.file)};
    const profile=history.map(item=>item.profile).find(item=>item?.image===image);
    if(profile)return {image,level:0,custom:true,file:profile.file};
    if(image==='/assets/zuanzuan.png')return {image,level:0,custom:false,file:null};
    return current;
  }
  const referenceFile = ref => ref.file?path.resolve(dataDir,ref.file):path.join(__dirname,'public/assets/zuanzuan.png');
  async function travelAnatomy(ref) {
    const key=ref.image, file=referenceFile(ref);
    if (describedForm?.key === key) return describedForm.description;
    if (!file.startsWith(path.resolve(dataDir) + path.sep)) return '';
    try {
      const bytes = fs.readFileSync(file);
      const type = /\.jpe?g$/i.test(file) ? 'jpeg' : /\.webp$/i.test(file) ? 'webp' : 'png';
      const description = (await describe([`data:image/${type};base64,${bytes.toString('base64')}`], '只描述参考宠物实际可见的身体结构和可用于动作的部位，例如钳、翅、足、轮、鳍。不要从名字推断品种，不要添加看不见的身体部位或故事。')).slice(0, 400);
      describedForm = { key, description };
      return description;
    } catch { return ''; }
  }
  function recent() { return Object.values(state.trips).filter(t=>t.status==='ready').sort((a,b)=>a.date.localeCompare(b.date)).slice(-5).map(t=>({ date:t.date,place:t.place,title:t.story?.title,scenes:t.story?.scenes.map(s=>({actionKey:s.actionKey,cameraKey:s.cameraKey,caption:s.caption})),observedActions:t.photos.map(id=>media.get(id)?.observedAction||media.get(id)?.caption) })); }
  function view(date=day(now())) {
    const t=state.trips[date];
    if(t&&!visible(t))return {date,status:'none',eligible:false,photos:[]};
    return { eligible:date===day(now())&&eligible(),date,status:t?.status||'none',error:t?.error||'',place:t?.place,
      storyStatus:t?.storyStatus||(t?.story?'ready':'none'),storyError:t?.storyError||'',story:publicStory(t?.story),
      photos:(t?.photos||[]).map((id,index)=>{const p=media.publicPhoto(media.get(id));return p&&t.story?{...p,caption:t.story.scenes[index]?.caption||p.caption}:p;}).filter(Boolean) };
  }
  function storeStoryMemory(trip) {
    memory.put({type:'trip',key:'trip-'+trip.date,text:`${trip.date}${state.name||'宠物'}去了${trip.place}。${trip.story ? trip.story.title+'：'+trip.story.intro+' '+trip.story.scenes.map(s=>s.narration).join(' ')+' '+trip.story.ending : trip.activity}。照片编号：${trip.photos.join('、')}`},'trip-'+trip.date);
  }
  function announce(trip){
    if(!visible(trip)||trip.status!=='ready'||state.chatArchive.some(m=>m.tripDate===trip.date))return;
    const language=trip.storyLanguage||companionLanguage.storyLanguage(trip.story);
    const content=language==='en'?"I'm back! I brought two pictures from my trip. Want to hear what happened?":
      `喵！今天在${trip.place}发生了一件小事，叫《${trip.story.title}》。我带回了两张照片，想讲给你听。`;
    state.chatArchive.push({id:crypto.randomUUID(),role:'assistant',content,createdAt:now(),tripDate:trip.date,photoIds:[...trip.photos]});
    storeStoryMemory(trip);save();
  }
  function start(retry=false, scheduledDate) {
    const date=scheduledDate||day(now());let trip=state.trips[date];
    // 今天有串门故事（我去了别人家或别人来我家），当天的故事就是那一篇，不再另外旅行。
    if(visits&&userId&&visits.hasFor(userId,date))return false;
    if(active||trip?.status==='ready'||trip?.status==='generating'||(trip?.status==='failed'&&!retry&&!trip.resumeInterrupted&&!(trip.retryAt&&now()>=trip.retryAt))||(!localFirst&&!eligible())||(localFirst&&!trip))return false;
    if(!trip)trip=createTrip(date);
    const companion={mode:companionLanguage.settings(state.companion).mode};
    const reference=trip.formReference ||= startReference(trip);
    trip.customPet=reference.custom;active=true;trip.status='generating';trip.error='';delete trip.diagnostic;delete trip.retryAt;delete trip.resumeInterrupted;save();
    completion=(async()=>{
      let stage='创作旅行故事';
      try {
        if(!trip.story){
          if(trip.photos.length)await ensureStory(date);
          else {
            const key='trip:'+(userId||'local')+':'+date;
            trip.storyEvent ||= visits?.reserveEvent && userId
              ? visits.reserveEvent(key,date,[userId])
              : reserveStoryEvent(dataDir,{key,date,roles:[userId||'local']});
            trip.activity=trip.storyEvent.action;save();
            const anatomy=reference.custom?await travelAnatomy(reference):undefined;
            trip.story=personalizeStory(await planner({storyEvent:trip.storyEvent,companion,owner:state.owner,ownerNickname:state.ownerNickname,customPet:reference.custom,petName:state.name,place:trip.place,activity:trip.activity,recent:recent(),anatomy}),state);trip.storyLanguage=companion.mode;trip.storyStatus='ready';save();}
        }
        for(let index=trip.photos.length;index<2;index++) {
          let approved=false;
          for(let attempt=0;attempt<2&&!approved;attempt++) {
            let candidate=trip.pendingPhoto,bytes;
            if(candidate?.index===index&&!candidate.feedback&&candidate.file&&fs.existsSync(candidate.file)) bytes=fs.readFileSync(candidate.file);
            else {
              const formImage=reference.image, formFile=referenceFile(reference);
              const prior=candidate?.index===index?candidate:null;
              const oldDir=prior?.file&&path.dirname(prior.file);
              const prefix=path.resolve(dataDir,'trip-work',date)+path.sep;
              const reuse=oldDir&&path.resolve(oldDir).startsWith(prefix)&&!prior.feedback;
              const dir=reuse?oldDir:path.join(dataDir,'trip-work',date,crypto.randomUUID());
              candidate={index,formImage:reuse?prior.formImage:formImage,formLevel:reuse?prior.formLevel:reference.level,startedAt:now(),file:path.join(dir,'candidate.jpg'),requestFeedback:prior?.feedback||prior?.requestFeedback||''};
              trip.pendingPhoto=candidate;save();stage='拍摄旅行照片';
              bytes=await generator({formFile,formImage,trip,index,dir,feedback:candidate.requestFeedback,allowResubmit:retry});
              fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(candidate.file+'.tmp',bytes);fs.renameSync(candidate.file+'.tmp',candidate.file);save();
            }
            stage='核对旅行照片';
            const previous=Object.values(state.trips).filter(t=>t.date<=date).sort((a,b)=>a.date.localeCompare(b.date)).flatMap(t=>t.photos).slice(-3).map(id=>media.get(id)).filter(Boolean);
            const review=await reviewer([`data:image/jpeg;base64,${bytes.toString('base64')}`,...previous.map(p=>media.dataUrl(p.id))],trip.story.scenes[index],previous.map(p=>({date:p.date,caption:p.caption,observedAction:p.observedAction})));
            if(!review.matches||review.duplicate){candidate.feedback=review.issues||'核心动作不符或与近期姿势重复，请按情节重新设计姿态和视角。';save();if(attempt===1)throw Error('旅行照片两次未通过画面核对。');continue;}
            const scene=trip.story.scenes[index];
            const photo=media.put(bytes,'image/jpeg',{kind:'trip',date,place:trip.place,activity:trip.activity,caption:scene.caption,storyTitle:trip.story.title,sceneIndex:index,actionKey:scene.actionKey,observedAction:review.observedAction,formImage:candidate.formImage,formLevel:candidate.formLevel});
            trip.photos.push(photo.id);delete trip.pendingPhoto;save();approved=true;
            // Preview and normalized work files can duplicate the committed JPEG.
            if(candidate.file&&path.resolve(candidate.file).startsWith(path.resolve(dataDir,'trip-work',date)+path.sep)){
              for(const file of [candidate.file,path.join(path.dirname(candidate.file),'photo.jpg')]){
                try{if(fs.readFileSync(file).equals(bytes))fs.unlinkSync(file);}catch{}
              }
            }
          }
        }
        trip.status='ready';
        announce(trip);
      } catch(error) { trip.status='failed';trip.error='这次旅行还没准备完整，已经收好的故事和照片会留下。可以继续准备。';trip.diagnostic=error.diagnostic||{stage};if(trip.diagnostic.retryable&&(trip.autoFailures||0)<2){trip.autoFailures=(trip.autoFailures||0)+1;trip.retryAt=now()+[30,120][trip.autoFailures-1]*60000;} }
      finally {active=false;save();if(localFirst)queueMicrotask(()=>resume());}
    })();return true;
  }
  function createTrip(date){
    const [place,activity]=PLACES[Math.abs(Math.floor(new Date(date+'T00:00:00+08:00').getTime()/86400000))%PLACES.length];
    const trip={date,place,activity,photos:[],status:'queued'};state.trips[date]=trip;return trip;
  }
  function prepare(reading){
    if(!localFirst||state.travelEnabled===false)return;
    const date=tomorrow(reading.createdAt);
    if(state.trips[date])return;
    createTrip(date).sourceReadingDay=day(reading.createdAt);save();resume();
  }
  function resume(retry=false){
    if(!localFirst||state.travelEnabled===false)return false;
    for(const trip of Object.values(state.trips))if(trip.sourceReadingDay)announce(trip);
    const item=Object.values(state.trips).sort((a,b)=>b.date.localeCompare(a.date)).find(t=>t.sourceReadingDay&&(t.status==='queued'||t.resumeInterrupted||(t.status==='failed'&&(retry||(t.retryAt&&t.retryAt<=now())))));
    return !!item&&start(retry,item.date);
  }
  function getTrip(date) { const trip=state.trips[date];if(!visible(trip)) { const e=Error('这段旅行还没有收进相册。');e.status=404;throw e; } return trip; }
  function ensureStory(date) {
    const trip=getTrip(date);
    if(trip.story)return Promise.resolve(view(date));
    if(storyJobs.has(date))return storyJobs.get(date);
    if(!trip.photos.length){const e=Error('照片还在准备中。');e.status=409;return Promise.reject(e);}
    const companion={mode:companionLanguage.settings(state.companion).mode};
    const job=(async()=>{
      trip.storyStatus='generating';trip.storyError='';save();
      let stage='理解旧照片';
      try {
        const images=trip.photos.map(id=>media.dataUrl(id));
        const observations=await Promise.all(images.map(image=>describe([image],state.petProfile?'客观描述参考宠物的身体姿态、视线、表情、接触的物件与场景。不要编故事，不能假设画面之外发生的事。':'客观描述宠物的身体姿态、视线、表情、接触的物件与场景。不要编故事，不能假设画面之外发生的事。')));
        let accepted,feedback='';
        for(let attempt=0;attempt<2;attempt++){
          stage='为旧照片创作故事';
          const proposed=personalizeStory(await legacyPlanner({companion,owner:state.owner,ownerNickname:state.ownerNickname,customPet:!!state.petProfile,petName:state.name,images,place:trip.place,activity:trip.activity,recent:recent(),observations,feedback}),state);
          trip.pendingStory={story:proposed};save();
          stage='核对旧照片与故事';const issues=[];
          for(let index=0;index<trip.photos.length;index++){
            const {caption,narration}=proposed.scenes[index];
            const review=await reviewer([images[index]],{caption,narration},[]);
            if(!review.matches)issues.push(`第${index+1}个瞬间：${review.issues}`);
          }
          if(!issues.length){accepted=proposed;break;}feedback='不能更换旧照片。请修改故事、配文和导演描述以忠实匹配实际照片，纠正：'+issues.join('；');trip.pendingStory.feedback=feedback;save();
        }
        if(!accepted)throw Error('旧照片与故事没有对应好。');
        trip.story=accepted;trip.storyLanguage=companion.mode;trip.storyStatus='ready';delete trip.storyDiagnostic;delete trip.pendingStory;
        trip.photos.forEach((id,index)=>{const photo=media.get(id);if(photo){photo.originalCaption ||= photo.caption;photo.caption=trip.story.scenes[index].caption;photo.storyTitle=trip.story.title;photo.sceneIndex=index;photo.observedAction=observations[index];}});
        storeStoryMemory(trip);save();return view(date);
      } catch(error) {trip.storyStatus='failed';trip.storyError='宠物这次还没把故事讲好，照片还在，可以再试一次。';trip.storyDiagnostic={stage,reason:error instanceof voice.VoiceError?'provider_unavailable':'story_validation'};save();throw error;}
      finally {storyJobs.delete(date);}
    })();storyJobs.set(date,job);return job;
  }
  function audio(date,index) {
    const trip=getTrip(date);if(!trip.story||trip.photos.length!==2||trip.status!=='ready') {const e=Error('旅行故事还在准备中。');e.status=409;throw e;}
    if(index!==0&&index!==1){const e=Error('没有找到这段故事。');e.status=400;throw e;}
    const text=segmentText(trip.story,index),key=crypto.createHash('sha256').update(date+'\n'+text+'\n'+speakerIdentity(text)).digest('hex');
    const dir=path.join(dataDir,'trip-audio'),file=path.join(dir,key+'.mp3');
    if(fs.existsSync(file))return Promise.resolve(fs.readFileSync(file));
    if(audioJobs.has(key))return audioJobs.get(key);
    const job=(async()=>{try{const bytes=await speaker(text,{voiceProfile:state.voiceProfile});fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file+'.tmp',bytes);fs.renameSync(file+'.tmp',file);return bytes;}finally{audioJobs.delete(key);}})();
    audioJobs.set(key,job);return job;
  }
  return { view,start,prepare,resume,preparation,ensureStory,audio,settled:()=>completion,
    list:()=>Object.values(state.trips).filter(t=>visible(t)&&t.photos.length).sort((a,b)=>b.date.localeCompare(a.date)).map(t=>({date:t.date,place:t.place,title:t.story?.title,cover:media.publicPhoto(media.get(t.photos[0])),status:t.status})),
    context:()=>Object.values(state.trips).filter(visible).sort((a,b)=>a.date.localeCompare(b.date)).slice(-14).map(t=>({date:t.date,place:t.place,activity:t.activity,status:t.status,photoIds:t.photos,story:publicStory(t.story)})) };
}
module.exports={createTrips,day,yesterday,generateTripPhoto,promptForPhoto};
