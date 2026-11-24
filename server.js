'use strict';
const {childError}=require('./child-copy');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createPetRuntime}=require('./pet-runtime');
const {createAccounts,fail}=require('./account-service');
const {createCatalog,createWork}=require('./work-service');
const {createStudioServer}=require('./job-studio-server');
const {browseWorks}=require('./work-discovery');
const {createCompletions}=require('./work-completion');
const {createHarvestQueue}=require('./work-harvest');
const {createPetCreation}=require('./pet-creation-service');
const {createExporter}=require('./portable-export');
const hallServices=require('./local-hall');
const sharedVoice=require('./shared-platform-voice');
const {createInstallCheck}=require('./workbuddy-install-check');
const {createVisits}=require('./visit-service');
const {generateTripPhoto}=require('./trip-service');
const homeService=require('./home-service');
const voice=require('./voice-service');
const voiceConfiguration=require('./companion-voice');
const opsToday=require('./ops-today');
const root=path.join(__dirname,'public');
async function body(req){let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>(req.url?.startsWith('/api/project/export')?3000000:req.url?.startsWith('/api/pet-creation/image')?11500000:req.url?.startsWith('/api/work/complete')?72000:24000))throw fail('内容太长，请缩短后再试。',413);chunks.push(c);}try{const v=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch{throw fail('这次没送好，再试一次吧。');}}
function createServer({dataDir=process.env.PET_DATA_DIR||path.join(__dirname,'data'),now=()=>Date.now(),studioFactory=opts=>createStudioServer(opts),portable=null,onlineHome=null}={}){
 const workbuddyCheck=process.env.PET_LOCAL_FIRST==='1'&&process.env.PET_LOCAL_AGENT==='workbuddy'?createInstallCheck(dataDir,async()=>{
  const agent=require('./local-agent');
  const response=await agent.respond('CHAT',{messages:[{role:'user',content:'Reply with exactly PET_HOME_OK. Do not call tools.'}]},AbortSignal.timeout(22000),{interactive:true});
  return (await response.json()).choices?.[0]?.message?.content;
 }):null;
 fs.mkdirSync(dataDir,{recursive:true});
 const accounts=createAccounts(dataDir,{now}),runtimes=new Map(),catalog=createCatalog(dataDir,{authorName:id=>accounts.users().find(u=>u.id===id)?.childName});
 const rollbackFile=process.env.PET_VOICE_ROLLBACK_FILE;
 const voiceRollbacks=new Set(rollbackFile&&fs.existsSync(rollbackFile)?JSON.parse(fs.readFileSync(rollbackFile,'utf8')):[]);
 // 串门：一条故事存在两家之间，只生成一次，谁有资格谁收到。
 let hall;
 const visits=createVisits({
  dataDir,now,
  people:{
   list:()=>accounts.users().map(u=>profileOf(u)).filter(Boolean),
   get:id=>profileOf(accounts.users().find(u=>u.id===id))
  },
  generator:generateTripPhoto,
  planner:voice.planVisitStory,
  narrator:voice.narrateVisitStory,
  reviewer:voice.reviewTravelPhoto,
  describe:voice.describePhoto
 });
 function profileOf(u){
  if(!u)return null;
  const synced=hall?.profile(u.id);
  const state=runtime(u).state;
  if(synced&&!state.petProfile?.image?.startsWith('/api/pet-appearance/'))return {...synced,lastLoginAt:u.lastLoginAt};
  const form=state.evolution?.forms?.at(-1), dir=accounts.dataPath(u);
  const ready=Object.values(state.trips||{}).filter(t=>t.status==='ready').sort((a,b)=>a.date.localeCompare(b.date));
  // 串门发生在主人家最常待的地方：先看它现在的房间，再看它以前常去的地方。
  let homePlace='';
  try {
   const room=homeService.roomsFor(state).find(r=>r.id===homeService.selectedRoom(state));
   // 写成“球球家的客厅”，故事里直接当地点用，不跟宠物名拼。
   if(room)homePlace=`${state.name||u.petName}家的${room.name}`;
  } catch {}
  return {
   id:u.id, lastLoginAt:u.lastLoginAt, petName:state.name||u.petName, childName:u.childName, petReady:!u.needsPetSetup&&!!(state.name||u.petName),
   customPet:!!state.petProfile,
   formImage:form?.image||state.petProfile?.image||'/assets/zuanzuan.png',
   formFile:form?path.join(dir,'evolutions',form.file):state.petProfile?.file?path.join(dir,state.petProfile.file):path.join(__dirname,'public/assets/zuanzuan.png'),
   homePlace,
   // 串门故事要避开孩子独自出门时做过的事（不是去过的地方）。
   recentStories: ready.slice(-6).filter(t=>t.story).map(t=>({date:t.date,action:t.activity||t.story.theme||t.story.title,title:t.story.title})),
   familiarPlace:ready.at(-1)?.place||''
  };
 }
 hall=hallServices.voiceEnabled()?hallServices.createHall({dataDir,accounts,visits,runtime,json:(...args)=>json(...args),now}):null;
 const exporter=createExporter({dataDir,visits});portable?.attach(accounts,user=>runtime(user));onlineHome?.attach(()=>ownerChildName());function ownerChildName(){const u=accounts.users().find(v=>v.portable);return u?u.childName:'';}
 function runtime(u){if(!runtimes.has(u.id)){const dir=accounts.dataPath(u);
 const hallClient=process.env.PET_LOCAL_FIRST==='1'?hallServices.createHallClient({directory:dir,localProfile:()=>publicHallProfile(pet.state,dir,pet.view().evolution),language:()=>pet.state.companion?.mode||'zh',now}):null;
 const pet=createPetRuntime({dataDir:dir,profile:{owner:u.childName,name:u.petName,danceEnabled:!!u.legacy||u.danceEnabled!==false},rewardMode:'food',preserveExistingState:!!u.legacy||!!u.portable||voiceConfiguration.enabled()&&u.voicePlan!=='daily-v3',visits,userId:u.id,voicePlan:u.voicePlan,voiceCatalog:u.voiceCatalog,voiceDailyFen:u.voiceDailyFen,voiceNow:now,platformRemote:hallClient,companionDisabled:voiceRollbacks.has(u.id),onlineReport:onlineHome?story=>onlineHome.reportReading(story).catch(()=>{}):null,onlineVisits:hallClient?()=>hallArchive(hallClient):onlineHome?()=>onlineHome.visitArchive():null}),studio=studioFactory({dataDir:dir,authenticatedRouter:true,...(pet.companionVoice?{speaker:(text,options)=>pet.companionVoice.speak(text,{...options,purpose:'story'}),speechConfigured:pet.companionVoice.canSpeak}:{})});const work=createWork({state:pet.state,save:pet.save,catalog,studio:studio.work,now,dataDirForPhotos:path.join(dir,'media'),onHarvest:pet.rememberHarvest});const completions=createCompletions({state:pet.state,save:pet.save,work,now,onComplete:pet.rememberWork});const creation=createPetCreation({dataDir:dir,state:pet.state,save:pet.save,deferVoice:voiceConfiguration.enabled()&&!voiceRollbacks.has(u.id),setName:name=>accounts.finishPet(u,name),onReady:()=>pet.preparePet()});runtimes.set(u.id,{...pet,studio,work,completions,creation,hallClient});if(hallClient){hallClient.pump().catch(()=>{});}}const r=runtimes.get(u.id);if(r.state.owner!==u.childName||r.state.name!==u.petName){r.state.owner=u.childName;r.state.ownerNickname=u.childName;r.state.name=u.petName;r.save();}return r;}
 const json=(res,status,value)=>{if(typeof value?.error==='string'&&!String(value.code).startsWith('voice_'))value={...value,error:childError(value.error)};res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 function cookie(req,res,token=''){const secure=req.socket.encrypted||process.env.PET_SECURE_COOKIE==='1';res.setHeader('Set-Cookie',`pet_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token?2592000:0}${secure?'; Secure':''}`);}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  try{
   portable?.before(req);
   const url=new URL(req.url,'http://localhost'),p=url.pathname,user=accounts.current(req);
   // 免登录重新打开小屋也算访问；后台轮询和资源请求不更新排序。
   if(user&&req.method==='GET'&&['/','/index.html'].includes(p))accounts.markLogin(user,{throttleMs:60000});
   if(!['GET','HEAD'].includes(req.method)){
    let origin;try{origin=req.headers.origin&&new URL(req.headers.origin);}catch{throw fail('来源不正确。',403);}
    if((origin&&origin.host!==req.headers.host)||req.headers['sec-fetch-site']==='cross-site')throw fail('请从本站页面操作。',403);
    if(!(['/api/pet-creation/image-file','/api/pet-appearance/upload'].includes(p)&&/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type']||''))&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')&&!/\/api\/readings\/[^/]+\/chunks\/\d+$/.test(p))throw fail('这次没送好，再试一次吧。',415);
   }
   if(process.env.PET_LOCAL_FIRST==='1'&&p==='/api/local-launch'&&req.method==='GET')return json(res,200,{app:'pet-local-home',instance:crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex'),agent:process.env.PET_LOCAL_AGENT||'offline',...(workbuddyCheck?{workbuddy:workbuddyCheck.status()}:{})});
   if(p.startsWith(sharedVoice.prefix)){await sharedVoice.handle({req,res,route:p.slice(sharedVoice.prefix.length),accounts,body,runtime,json,now,voice});return;}
   if(p.startsWith('/api/local-hall/')&&hall){await hall.handle(req,res,url);return;}
   if(portable&&await portable.handle(req,res,url))return;
   // 串门连线上家：绑定/解绑与 /api/visit* 代理，都只在本机模式下暴露。
   if(onlineHome&&await onlineHome.control(req,res,url))return;
   if(onlineHome&&await onlineHome.handle(req,res,url))return;
   if(voiceConfiguration.enabled()&&(p.startsWith('/api/companion/relay/')||p==='/api/operator/companion-voice-credit'))
    throw fail('没有找到这个操作。',404);
   if(!voiceConfiguration.enabled()&&p==='/api/companion/relay/speak'&&req.method==='POST'){
    if(process.env.PET_ENABLE_VOICE_RELAY!=='1')throw fail('没有找到这个操作。',404);
    const match=/^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');
    const target=match&&accounts.users().find(account=>account.id===match[1]);
    if(!target)throw fail('请重新连接语音服务。',401);
    const r=runtime(target),expected=r.state.voiceRelayHash;
    const given=crypto.createHash('sha256').update(match[2]).digest('hex');
    if(typeof expected!=='string'||expected.length!==64||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(given)))
     throw fail('请重新连接语音服务。',401);
    const input=await body(req),controller=new AbortController();
    const cancel=()=>controller.abort();
    res.once('close',cancel);
    try{
     const bytes=await r.meteredSpeak(input.text,controller.signal);
     res.writeHead(200,{'Content-Type':voiceConfiguration.mediaType(bytes),'Cache-Control':'no-store'});
     return res.end(bytes);
    }finally{res.removeListener('close',cancel);}
   }
   if(!voiceConfiguration.enabled()&&p==='/api/operator/voice-credit'&&req.method==='POST'){
    const secret=process.env.PET_VOICE_OPERATOR_TOKEN;
    if(!secret||secret.length<32)throw fail('没有找到这个操作。',404);
    const received=req.headers.authorization||'';
    const digest=value=>crypto.createHash('sha256').update(value).digest();
    if(!crypto.timingSafeEqual(digest(received),digest('Bearer '+secret)))throw fail('没有操作权限。',403);
    const {userId,amount,receipt}=await body(req);
    if(typeof userId!=='string'||!Number.isSafeInteger(amount)||amount<1||amount>10000000||
       typeof receipt!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(receipt))throw fail('充值资料无效。');
    const target=accounts.users().find(account=>account.id===userId);
    if(!target)throw fail('没有找到账号。',404);
    const r=runtime(target);
    const credits=r.state.voiceCredits||=[];
    const previous=credits.find(entry=>entry.receipt===receipt);
    if(previous&&previous.amount!==amount)throw fail('这张充值单已用于其他金额。',409);
    if(!previous){
     if(!Number.isSafeInteger(r.state.voiceBalance))throw fail('这是未设额度上限的账号。',409);
     if(!Number.isSafeInteger(r.state.voiceBalance+amount))throw fail('余额超出范围。');
     credits.push({receipt,amount,at:now()});r.state.voiceBalance+=amount;r.save();
    }
    return json(res,200,{voiceBalance:r.state.voiceBalance,replayed:!!previous});
   }
   if(!portable&&['/setup','/portable-setup.html','/portable-setup.js','/portable-browser.js'].includes(p))throw fail('没有找到这个页面。',404);
   if(p==='/api/auth/me'&&req.method==='GET')return json(res,200,{user:user?accounts.publicUser(user):null});
   if(['/api/auth/register','/api/auth/login'].includes(p)&&req.method==='POST'){accounts.limit(req.socket.remoteAddress);const b=await body(req),register=p.endsWith('register'),u=register?await accounts.register(b,voiceConfiguration.enabled()?{voicePlan:'daily-v3',voiceCatalog:'bilingual-v1',voiceDailyFen:30}:undefined):await accounts.login(b);
    const initial=process.env.PET_NEW_ACCOUNT_VOICE_CREDITS;
    if(register&&!voiceConfiguration.enabled()&&/^\d{1,8}$/.test(initial||'')){const r=runtime(u);r.state.voiceBalance=Number(initial);r.save();}
    if(process.env.PET_LOCAL_FIRST==='1'){
     const client=runtime(u).hallClient;
     const credentials={name:u.login,password:b.password,register};
     const sync=client.ensureIdentity(credentials).catch(error=>{
      if([401,403,409,429].includes(error.status))return;
      setTimeout(()=>client.ensureIdentity(credentials).catch(()=>{}),8000).unref();
     });
     await Promise.race([sync,new Promise(resolve=>setTimeout(resolve,1100).unref())]);
    }
    cookie(req,res,accounts.session(u));return json(res,200,{user:accounts.publicUser(u)});}
   if(p==='/api/auth/logout'&&req.method==='POST'){accounts.logout(req);cookie(req,res);return json(res,200,{ok:true});}
   // 便携版绑定「线上家」用：登录态换一个 90 天设备通行证，之后串门请求带它即可。
   if(p==='/api/auth/device'&&req.method==='POST'){
    if(!user)throw fail('先登录，才能给这台电脑发通行证。',401);
    const token=accounts.deviceToken(user,90);
    return json(res,200,{token,expires:user?Date.now()+90*86400000:0});
   }
   if(p.startsWith('/api/work-examples/')&&req.method==='GET')return require('./work-example').serve(dataDir,p,res);
   if(p==='/api/works'&&req.method==='GET'){
    const states=accounts.users().map(u=>{const live=runtimes.get(u.id);if(live)return live.state;const file=path.join(accounts.dataPath(u),'pet.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};});
    if(url.searchParams.get('browse')==='1')return json(res,200,browseWorks(catalog.list(),states,url.searchParams));
    return json(res,200,{works:catalog.list()});
   }
   // 运营只读面板：不用登录，路径带随机串，只读磁盘，不写任何数据。
   if(p==='/ops-data-7d3f'&&req.method==='GET')return json(res,200,opsToday.build({dataDir,accounts,now:now()}));
   // 便携版就地升级：只读 <dataDir>/portable-update/，清单和文件都由部署脚本生成。
   if(p.startsWith('/portable-update/')&&req.method==='GET'){
    const dir=path.join(dataDir,'portable-update');
    if(p==='/portable-update/manifest.json'){
      const f=path.join(dir,'manifest.json');
      if(!fs.existsSync(f))return json(res,404,{error:'还没有可用的更新。'});
      return json(res,200,JSON.parse(fs.readFileSync(f,'utf8')));
    }
    const m=/^\/portable-update\/file\/(.+)$/.exec(p);
    if(m){
      const rel=decodeURIComponent(m[1]);
      if(rel.includes('..')||rel.startsWith('/')||/\\/.test(rel))throw fail('没有找到这个文件。',404);
      const f=path.join(dir,'files',rel.replace(/[\\/]/g,'__'));
      if(!fs.existsSync(f))return json(res,404,{error:'没有找到这个文件。'});
      const buf=fs.readFileSync(f);
      res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store'});return res.end(buf);
    }
    throw fail('没有找到这个页面。',404);
   }
   if(p.startsWith('/api/')){
    if(!user)throw fail('先登录，才能回到自己的宠物身边。',401);
    if(p==='/api/account'&&req.method==='PATCH'){const u=await accounts.update(user,await body(req));runtime(u);cookie(req,res,accounts.session(u));return json(res,200,{user:accounts.publicUser(u)});}
    if(p==='/api/account/claim'&&req.method==='POST'){accounts.limit(req.socket.remoteAddress);const u=accounts.claim(user,(await body(req)).code);runtimes.delete(u.id);runtime(u);return json(res,200,{user:accounts.publicUser(u)});}
    const r=runtime(user);
    if(r.hallClient&&p==='/api/local-home/verify'&&req.method==='POST'){
     accounts.limit(req.socket.remoteAddress);
     const {password}=await body(req);
     await accounts.login({name:user.login,password});
     return json(res,200,await r.hallClient.ensureIdentity({name:user.login,password}));
    }
    if(r.hallClient&&await localHallRoute(req,res,url,r,json))return;
    if(!voiceConfiguration.enabled()&&p==='/api/companion/relay/key'&&req.method==='POST'){
     if(process.env.PET_ENABLE_VOICE_RELAY!=='1'||voiceConfiguration.localMode())throw fail('没有找到这个操作。',404);
     const {revoke}=await body(req);
     if(revoke===true){delete r.state.voiceRelayHash;r.save();return json(res,200,{revoked:true});}
     const secret=crypto.randomBytes(32).toString('base64url');
     r.state.voiceRelayHash=crypto.createHash('sha256').update(secret).digest('hex');r.save();
     return json(res,200,{token:user.id+'.'+secret});
    }
    if(p==='/api/project/export'&&req.method==='POST'){const b=await body(req);await exporter.start(user,accounts.dataPath(user),r.state,catalog.list(),b.drafts||{},r.view().visit);return json(res,202,exporter.status(user));}
    if(p==='/api/project/export'&&req.method==='GET')return json(res,200,exporter.status(user));
    if(p==='/api/project/download'&&req.method==='GET'){
     const job=exporter.download(user);if((server.portableDownloads||0)>=3)throw fail('下载的小伙伴有点多，等一会儿再点吧。',429);
     const range=req.headers.range;let start=0,end=job.bytes-1,status=200;if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m||Number(m[1])>=job.bytes||m[2]&&Number(m[2])<Number(m[1])){res.writeHead(416,{'Content-Range':'bytes */'+job.bytes});return res.end();}start=Number(m[1]);end=m[2]?Math.min(end,Number(m[2])):end;status=206;}
     server.portableDownloads=(server.portableDownloads||0)+1;job.downloads=(job.downloads||0)+1;const stream=fs.createReadStream(job.file,{start,end});let done=false;const release=()=>{if(done)return;done=true;server.portableDownloads--;job.downloads--;stream.destroy()};res.once('close',release);stream.once('error',()=>{release();res.destroy()});
     res.writeHead(status,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="my-pet-project.zip"; filename*=UTF-8\'\''+encodeURIComponent(user.petName+'的宠物项目.zip'),'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, no-store',...(status===206?{'Content-Range':`bytes ${start}-${end}/${job.bytes}`}:{})});return stream.pipe(res);
    }
    if(p==='/api/pet-appearance'||p.startsWith('/api/pet-appearance/')){
     if(user.needsPetSetup)throw fail('先让宠物安家，再来更改形象。',409);
     const {state,animation}=r, dataDir=accounts.dataPath(user);
     r.appearance ||= createPetCreation({dataDir,state,save:r.save,appearance:true});
     const appearance=r.appearance;
     const candidate=appearance.candidate();
     const status=()=>{const form=appearance.candidate();return {...appearance.view(),id:form?.id||null,animation:form?animation.view(form.image):null,applied:!!form&&state.petProfile?.image===form.image};};
     const serve=file=>{res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'private, no-store'});return fs.createReadStream(file).pipe(res);};
     if(req.method==='GET'){
      if(p==='/api/pet-appearance')return json(res,200,status());
      if(p==='/api/pet-appearance/preview'&&candidate)return serve(path.join(dataDir,candidate.file));
      const profile=[state.petProfile,...(state.previousEvolutions||[]).map(e=>e.profile)].find(item=>item?.image===p);
      if(profile&&/^\/api\/pet-appearance\/[a-f0-9-]{36}\.png$/.test(p))return serve(path.join(dataDir,profile.file));
     }
     if(req.method==='POST'){
      if(p==='/api/pet-appearance/upload'){
       if(candidate&&animation.view(candidate.image).status==='generating')throw fail('等新形象的动作准备好，再选另一张画。',409);
       await appearance.upload(req);
       return json(res,200,status());
      }
      const b=await body(req);
      if(p==='/api/pet-appearance/retry-image'){
       if(appearance.view().imageStatus!=='failed')throw fail('只有处理失败的图片可以重试。',409);
       await appearance.act('retry-image',{async:true});
       return json(res,200,status());
      }
      if(!candidate||candidate.id!==b.id||appearance.candidate()?.id!==b.id)throw fail('这张画还没准备好，请刷新预览。',409);
      if(p==='/api/pet-appearance/prepare'){
       if(animation.view(candidate.image).status!=='ready'&&!animation.start(candidate)&&animation.view(candidate.image).status!=='generating')throw fail('现在无法准备动作，请稍后再试。',409);
       return json(res,200,status());
      }
      if(p==='/api/pet-appearance/apply'){
       if(state.petProfile?.image===candidate.image)return json(res,200,status());
       if(state.evolution.status==='generating')throw fail('等这次进化准备好，再更改形象。',409);
       const motion=animation.view(candidate.image);
       if(motion.status!=='ready')throw fail('新形象的动作还没准备完整。',409);
       const prior={evolution:state.evolution,petProfile:state.petProfile,previousEvolutions:state.previousEvolutions};
       state.previousEvolutions=[...(prior.previousEvolutions||[]),{...prior.evolution,profile:prior.petProfile}];
       state.petProfile={...prior.petProfile,version:1,image:candidate.image,file:candidate.file,createdAt:Date.now(),initialStatic:false,...(!prior.petProfile?{legacyRules:true}:{})};
       state.evolution={level:0,status:'idle',forms:[],feedOffset:state.feeds};
       try{r.save();}catch(error){Object.assign(state,prior);throw error;}
       return json(res,200,status());
      }
     }
     throw fail('没有这个操作。',404);
    }
    if(p==='/api/pet-creation/image-file'&&req.method==='POST')return json(res,200,await r.creation.upload(req));
    if(p==='/api/pet-creation'&&req.method==='GET')return json(res,200,r.creation.view());
    if(p.startsWith('/api/pet-creation/')){
     const kind=p.slice('/api/pet-creation/'.length);
     if(req.method==='GET'&&['image','original','audio'].includes(kind)){const file=r.creation.asset(kind);res.writeHead(200,{'Content-Type':kind==='audio'?'audio/mpeg':kind==='image'?'image/png':'application/octet-stream','Cache-Control':'private, no-store'});return fs.createReadStream(file).pipe(res);}
     if(req.method==='POST'){if(!user.needsPetSetup)throw fail('宠物已经在家啦，不用再创建。',409);return json(res,200,await r.creation.act(kind,await body(req)));}
    }
    if(p==='/api/works'&&req.method==='POST'){const b=await body(req);return json(res,201,{work:catalog.publish(user,b.job,b.id,b.example?await require('./work-example').publishSnapshot(dataDir,accounts.dataPath(user),require('./work-service').validate(b.job),b.example):null)});}
    if(p==='/api/work/today'&&req.method==='GET'){const v=r.work.view();return json(res,200,{active:v.active,next:v.next,date:v.date,completion:r.completions.today(),issue:v.issue,eligible:v.eligible,serviceEnabled:v.serviceEnabled,quota:r.view().home.storyRewards,food:r.view().home.totalFood});}
    if(p==='/api/work/complete'&&req.method==='POST'){const result=r.completions.submit(await body(req));return json(res,200,{...result,pet:r.view()});}
    if(p==='/api/work/selection'&&req.method==='GET'){const v=r.work.view();return json(res,200,{active:v.active,next:v.next,changesTomorrow:v.changesTomorrow});}
    if(p==='/api/work'&&req.method==='GET')return json(res,200,r.work.view());
    if(p==='/api/work/harvests'&&req.method==='GET')return json(res,200,{items:r.work.harvests()});
    if(p==='/api/work/harvests/read'&&req.method==='POST'){const b=await body(req);return json(res,200,{items:r.work.markRead(b.ids)});}
    if(p==='/api/work/install'&&req.method==='POST')return json(res,200,r.work.install((await body(req)).id));
    if(p==='/api/work/retry'&&req.method==='POST'){await body(req);harvestQueue.drain().catch(()=>{});return json(res,202,r.work.view());}
    if(p.startsWith('/api/studio/'))return r.studio.emit('request',req,res);
    return await r.handle(req,res);
   }
   if(req.method!=='GET'&&req.method!=='HEAD')throw fail('不支持这种操作。',405);
   const routes={'/':'/index.html','/office':'/office.html','/account':'/account.html','/studio':'/job-studio.html','/create-pet':'/create-pet.html'};
   const requested=routes[p]||decodeURIComponent(p);
   if(['/index.html','/job-studio.html','/create-pet.html'].includes(requested)&&!user){res.writeHead(302,{Location:'/account.html?next='+encodeURIComponent(requested)});return res.end();}
   if(user?.needsPetSetup&&['/index.html','/job-studio.html'].includes(requested)){res.writeHead(302,{Location:'/create-pet'});return res.end();}
   const file=path.resolve(root,'.'+requested);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())throw fail('没有找到这个页面。',404);
   const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2','.mp3':'audio/mpeg'};
   res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});if(req.method==='HEAD')return res.end();if(portable&&requested.endsWith('.html'))return res.end(fs.readFileSync(file,'utf8').replace('</body>','<script src="/portable-browser.js"></script></body>'));fs.createReadStream(file).pipe(res);
  }catch(e){if(!res.headersSent)json(res,e.status||500,{code:e.status?e.code:undefined,error:e.status?e.message:'这一步没完成，请稍后再试。'});else res.end();}
 });
 const harvestQueue=createHarvestQueue(()=>accounts.users().map(u=>runtime(u).work));server.harvestQueue=harvestQueue;
 const tick=()=>{
  harvestQueue.drain().catch(e=>console.error('Work queue failed:',e.code||'QUEUE_ERROR'));
  if(process.env.PET_DISABLE_VISIT_GEN!=='1')visits.resumeDeferred().catch(e=>console.error('Visit queue failed:',e.code||'QUEUE_ERROR'));
 };
 let timer,localVisitTimer;
 if(process.env.PET_SKIP_ENV!=='1'){timer=setInterval(tick,60000);timer.unref();server.once('listening',tick);}
 if(process.env.PET_LOCAL_FIRST==='1'){
  const resumeLocalVisits=()=>{
   for(const user of accounts.users()){
    if(!fs.existsSync(path.join(accounts.dataPath(user),'local-hall-link.json')))continue;
    try{runtime(user).hallClient?.pump().catch(()=>{});}catch{}
   }
  };
  server.once('listening',resumeLocalVisits);
  localVisitTimer=setInterval(resumeLocalVisits,60000);localVisitTimer.unref();
 }
 server.once('close',()=>{clearInterval(timer);clearInterval(localVisitTimer);harvestQueue.close();exporter.close()});
 return server;
}
if(require.main===module)createServer().listen(Number(process.env.PORT||3210),process.env.HOST||'0.0.0.0',()=>console.log('奇遇事务所与宠物小家：http://localhost:'+(process.env.PORT||3210)));

function publicHallProfile(state,directory,evolution){
 const forms=state.evolution?.forms||[],form=forms.find(item=>item.level===evolution.completedLevel);
 const rel=form?path.join('evolutions',form.file):state.petProfile?.file;
 const data=rel?readHallImage(directory,rel):undefined;
 const customRoom=path.join(directory,'hall-room.png');
 return {petName:state.name,roomId:homeService.selectedRoom(state),image:data,roomImage:fs.existsSync(customRoom)?readHallImage(directory,'hall-room.png'):undefined};
}
function readHallImage(directory,relative){
 const base=fs.realpathSync(directory)+path.sep,file=fs.realpathSync(path.resolve(directory,relative)),stat=fs.statSync(file);
 if(!file.startsWith(base)||!stat.isFile()||stat.size>2*1024*1024)throw fail('请选一张 2MB 以内的宠物或房间图。',400);
 return fs.readFileSync(file).toString('base64');
}
async function hallArchive(client){return client.visitArchive();}
async function localHallRoute(req,res,url,r,json){
 const c=r.hallClient,p=url.pathname,method=req.method;
 if(p==='/api/local-home'&&method==='GET')return json(res,200,await c.refreshInfo())||true;
 if(p==='/api/local-home/connect'&&method==='POST')return json(res,200,await c.connect(await hallServices.jsonBody(req)))||true;
 if(p==='/api/local-home/publish'&&method==='POST'){
  if(!r.state.petProfile||!c.linked())throw fail('请先创建宠物并连接线上账号。',409);
  if(!(await c.refreshInfo()).hallEnabled)throw fail('串门暂时还没接通，稍后再试。',503);
  return json(res,200,await c.sync(true))||true;
 }
 if(p==='/api/local-home/visit-progress'&&method==='GET')return json(res,200,{progress:c.visitProgress()})||true;
 if(p==='/api/local-home/retry'&&method==='POST'){
  const {id}=await hallServices.jsonBody(req);
  c.retryVisit(id);
  return json(res,202,{started:true})||true;
 }
 const match=/^\/api\/visit\/([a-f0-9-]{36})\/(story|photo\/[01]|audio\/[01])$/.exec(p);
 if(match){
  const [,id,part]=match;
  if(part.startsWith('audio/')){
   const stored=await c.storedVisit(id,'story',url.searchParams.get('edition'));if(!stored)return false;
   const item=JSON.parse(stored.bytes);if(!item.story)throw fail('这个语言版本还没准备好。',409);
   const ix=Number(part.at(-1));
   const text=ix===0?item.story.intro+'\n'+item.story.scenes[0].narration:item.story.scenes[1].narration+'\n'+item.story.ending;
   const clip=new URL(req.url,'http://localhost').searchParams.get('clip');
   const result=r.companionVoice.usesLocal()&&clip!==null?await r.companionVoice.localStoryClip(text,Number(clip)):{audio:await r.companionVoice.speak(text,{purpose:'story'})};
   res.writeHead(200,{'Content-Type':voiceConfiguration.mediaType(result.audio),...(result.count?{'X-Pet-Story-Clips':result.count}:{})});res.end(result.audio);return true;
  }
  const result=await c.storedVisit(id,part,url.searchParams.get('edition'));if(!result)return false;
  res.writeHead(200,{'Content-Type':result.type});res.end(result.bytes);return true;
 }
 if(p==='/api/visit'&&method==='GET'){
  const info=r.state.petProfile?await c.prepareVisit():await c.refreshInfo();
  const local=r.view().visit;
  const waiting={...local,enabled:!!r.state.petProfile,remoteVisit:true,canVisit:false,credit:0,targets:[],visitUnavailable:info.visitSyncError||'串门暂时没连上，待会儿再来看看。'};
  if(!info.inHall||!info.hallEnabled)return json(res,200,waiting)||true;
  const v=await c.visitView().catch(()=>null);
  if(!v)return json(res,200,waiting)||true;
  return json(res,200,{...local,...v,remoteVisit:true,canVisit:v.canVisit&&local.canVisit,credit:v.canVisit?local.credit:0,storyToday:local.storyToday})||true;
 }
 if(p==='/api/pet'&&method==='GET'){
  if(r.state.petProfile)c.prepareVisit().then(()=>c.pump()).catch(()=>{});
  return false;
 }
 if(!c.info().inHall)return false;
 if(p==='/api/visit/send'&&method==='POST'){
  const b=await hallServices.jsonBody(req);
  const local=r.view().visit;
  if(!local.canVisit)throw fail('今天先读书，才有力气去串门。',409);
  const visit=await c.send(b);
  r.state.visitCredit={day:local.today,left:0};r.save();
  return json(res,200,{...visit,remoteVisit:true,credit:0,storyToday:local.storyToday})||true;
 }
 const avatar=/^\/api\/visit\/avatar\/([a-f0-9-]{36})$/.exec(p);
 if(avatar&&method==='GET'){
  const response=await c.fetchLocal('avatar/'+avatar[1]);
  res.writeHead(200,{'Content-Type':response.headers.get('content-type'),'Cache-Control':'no-store'});
  res.end(Buffer.from(await response.arrayBuffer()));return true;
 }
 return false;
}
module.exports={createServer};
