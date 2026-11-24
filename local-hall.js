'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {write}=require('./account-service');
const {chinaDay,planVisitDraft}=require('./visit-service');
const {reserveStoryEvent}=require('./story-events');
const voice=require('./voice-service');
const {generateTripPhoto}=require('./trip-service');
const ROOT=__dirname;
const MAX_IMAGE=2*1024*1024;
const issue=(message,status=400,code)=>Object.assign(Error(message),{status,code});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const privateFile=directory=>path.join(directory,'local-hall-link.json');
const enabled=()=>process.env.PET_LOCAL_HALL_ENABLED==='1';
const voiceEnabled=()=>enabled()||process.env.PET_LOCAL_PLATFORM_VOICE_ENABLED==='1';
const sampleIds=new Set(voice.BILINGUAL_VOICES.map(v=>v.id));

async function jsonBody(req,max=24000){
  const parts=[];let count=0;
  for await(const part of req){count+=part.length;if(count>max)throw issue('发送的内容太大。',413);parts.push(part);}
  try{const body=JSON.parse(Buffer.concat(parts).toString()||'{}');if(body&&typeof body==='object'&&!Array.isArray(body))return body;}catch{}
  throw issue('这次内容无法读取。');
}

function png(value){
  if(typeof value!=='string'||value.length>Math.ceil(MAX_IMAGE/3)*4)throw issue('形象或房间图太大。',413);
  const b=Buffer.from(value,'base64');
  if(b.length<100||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||b.toString('ascii',12,16)!=='IHDR'||
    b.readUInt32BE(16)<1||b.readUInt32BE(16)>2048||b.readUInt32BE(20)<1||b.readUInt32BE(20)>2048||
    b.toString('ascii',b.length-8,b.length-4)!=='IEND')throw issue('请使用完整的 PNG 图片。');
  return b;
}

function saveBytes(file,bytes){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file+'.tmp',bytes);fs.renameSync(file+'.tmp',file);
}

function createHall({dataDir,accounts,visits,runtime,json,now=Date.now}){
  const profiles=path.join(dataDir,'local-hall-profiles');
  const profileFile=id=>path.join(profiles,id,'profile.json');
  function profile(id){
    if(!fs.existsSync(profileFile(id)))return null;
    const p=JSON.parse(fs.readFileSync(profileFile(id),'utf8'));
    const childName=accounts.users().find(user=>user.id===id)?.childName||'';
    return {...p,id,childName,petReady:true,customPet:!!p.image,
      formFile:p.image?path.join(profiles,id,p.image+'.png'):path.join(ROOT,'public/assets/zuanzuan.png'),
      roomFile:p.roomImage?path.join(profiles,id,p.roomImage+'.png'):null};
  }
  function publish(user,b){
    const petName=String(b.petName||'').trim();
    if(!petName||petName.length>16)throw issue('请先给宠物起个名字。');
    const rooms=require('./home-service').roomsFor({petProfile:{}});
    const room=rooms.find(item=>item.id===b.roomId)||rooms[0];
    const dir=path.join(profiles,user.id);
    const saveImage=value=>{
      if(!value)return null;const bytes=png(value),hash=digest(bytes);
      const file=path.join(dir,hash+'.png');if(!fs.existsSync(file))saveBytes(file,bytes);return hash;
    };
    const p={petName,homePlace:petName+'的'+(room?.name||'小屋'),roomId:room?.id||null,image:saveImage(b.image),roomImage:saveImage(b.roomImage)};
    fs.mkdirSync(dir,{recursive:true});
    write(profileFile(user.id),p);
    const keep=new Set([p.image,p.roomImage].filter(Boolean).map(hash=>hash+'.png'));
    for(const file of fs.readdirSync(dir))if(/^[a-f\d]{64}\.png$/.test(file)&&!keep.has(file))fs.unlinkSync(path.join(dir,file));
    return {petName,roomId:p.roomId};
  }
  async function handle(req,res,url){
    const route=url.pathname.slice('/api/local-hall/'.length);
    if(!voiceEnabled())throw issue('线上服务暂未开放。',404);
    if(route==='status'&&req.method==='GET')return json(res,200,{localHall:enabled()?1:0,platformVoice:1});
    if(!enabled()&&!['device','voice'].includes(route))throw issue('串门暂未开放。',404);
    if(route==='device'&&req.method==='POST'){
      const user=accounts.current(req);
      if(!user||req.headers.authorization)throw issue('请先连接你的线上账号。',401);
      return json(res,200,{token:accounts.deviceToken(user,90,'local-hall'),accountId:user.id,expires:now()+90*86400000});
    }
    const auth={headers:{authorization:req.headers.authorization}};
    const u=accounts.current(auth,'local-hall')||(enabled()?accounts.current(auth,'local-voice'):null);
    if(!u)throw issue('请重新登录小家，恢复线上连接。',401);
    if(route==='profile'&&req.method==='POST')return json(res,200,publish(u,await jsonBody(req,5800000)));
    if(route==='voice'&&req.method==='GET')return json(res,200,runtime(u).companionVoice?.platform()||{plan:'unavailable'});
    if(route==='voice'&&req.method==='POST'){
      const b=await jsonBody(req);
      if(!sampleIds.has(b.voice))throw issue('请选择一种平台声音。',400,'voice_setup');
      const cv=runtime(u).companionVoice;
      if(!cv)throw issue('平台声音还没连接。',503,'voice_setup');
      const controller=new AbortController(),abort=()=>controller.abort();res.once('close',abort);
      try{
        const audio=await cv.speak(b.text,{purpose:b.purpose==='story'?'story':'chat',platformVoice:b.voice,signal:controller.signal,
          receiptAudit:process.env.PET_HALL_TTS_AUDIT==='1'?receipt=>fs.appendFileSync(path.join(dataDir,'hall-tts-usage.jsonl'),JSON.stringify({...receipt,account:u.id,purpose:b.purpose==='story'?'story':'chat'})+'\n',{mode:0o600}):undefined});
        res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'no-store'});return res.end(audio);
      }finally{res.removeListener('close',abort);}
    }
    if(route==='visit'&&req.method==='GET'){
      const d=chinaDay(now()),me=profile(u.id);
      const visible=r=>r.storyDate<=d;
      const targets=visits.targets(u.id);
      return json(res,200,{enabled:!!me,targets,today:d,canVisit:!!me&&visits.externalDay(u.id),
        todayVisits:visits.forDate(u.id,d,true,url.searchParams.get('language')),archive:visits.listFor(u.id,url.searchParams.get('language'),visible).slice(0,50)});
    }
    if(route==='visit/send'&&req.method==='POST'){
      const b=await jsonBody(req);
      if(!profile(u.id))throw issue('请先开启串门。',409);
      const target=String(b.targetId||'');
      return json(res,200,{sent:visits.externalDay(u.id,target)||visits.send(u.id,target,{external:true})});
    }
    const avatar=/^avatar\/([a-f0-9-]{36})$/.exec(route);
    if(avatar&&req.method==='GET'&&visits.targets(u.id).some(v=>v.id===avatar[1])){
      const asset=visits.avatar(avatar[1]);
      if(!asset)throw issue('没有这个宠物的头像。',404);
      res.writeHead(200,{'Content-Type':asset.type,'Cache-Control':'no-store'});return res.end(fs.readFileSync(asset.file));
    }
    if(route==='work'&&req.method==='GET')return json(res,200,{jobs:visits.externalWork(u.id)});
    const match=/^(work|visit)\/([a-f0-9-]{36})\/(requester|target|room|result|photo\/[01]|story|bundle|received)$/.exec(route);
    if(!match)throw issue('没有这个操作。',404);
    const [,group,id,part]=match;
    if(group==='work'&&req.method==='GET'){
      const b=visits.externalAsset(u.id,id,part);
      if(!b)throw issue('没有这张参考图。',404);
      res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});return res.end(b);
    }
    if(group==='work'&&part==='result'&&req.method==='POST')return json(res,200,visits.submitExternal(u.id,id,await jsonBody(req,5700000)));
    if(group==='visit'&&part==='bundle'&&req.method==='GET')return json(res,200,visits.deliveryBundle(u.id,id));
    if(group==='visit'&&part==='received'&&req.method==='POST')return json(res,200,visits.receiveDelivery(u.id,id));
    const record=visits.read(id);
    if(!record||!visits.roleOf(record,u.id)||record.storyDate>chinaDay(now())||record.status!=='ready')throw issue('串门故事还没准备好。',404);
    if(group==='visit'&&part==='story'&&(req.method==='GET'||req.method==='POST'))return json(res,200,visits.view(record,u.id,url.searchParams.get('language')));
    if(group==='visit'&&part.startsWith('photo/')&&req.method==='GET'){
      const bytes=visits.photo(id,Number(part.at(-1)),u.id);
      if(!bytes)throw issue('没有这张照片。',404);
      res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(bytes);
    }
    throw issue('没有这个操作。',404);
  }
  return {handle,profile};
}

function createHallClient({directory,localProfile,language,now=Date.now}){
  const url=new URL(process.env.PET_HALL_URL||'https://pet.myworlds.cn');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw Error('线上家必须使用 HTTPS。');
  const file=privateFile(directory);
  let link=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  let publishing,working,checkingHall,lastCheck=0,hallCheckedAt=0;
  let visitSyncError='',nextVisitSync=0;
  let identityJob,identityState='needs_password';
  const speechJobs=new Map(),copies=new Map();
  const linked=()=>!!link&&link.origin===url.origin&&link.expires>Date.now();
  async function read(res){
    if(res.ok)return res;
    const b=await res.json().catch(()=>({}));
    throw issue(b.error||'线上家暂时没有接上。',res.status,b.code);
  }
  async function availability(){
    const status=await fetch(new URL('/api/local-hall/status',url),{signal:AbortSignal.timeout(4000)});
    return status.ok?await status.json().catch(()=>({})):{};
  }
  async function fetchLocal(route,{method='GET',body,signal,timeout=12000}={}){
    if(!linked())throw issue('请先连接线上账号。',401,'voice_setup');
    const deadline=AbortSignal.timeout(timeout);
    const prefix=route==='voice'&&link.channel==='voice'?'/api/local-voice/':'/api/local-hall/';
    const response=await fetch(new URL(prefix+route,url),{method,headers:{
      Authorization:'Bearer '+link.token,...(body?{'Content-Type':'application/json'}:{})
    },body:body?JSON.stringify(body):undefined,signal:signal?AbortSignal.any([signal,deadline]):deadline});
    if(response.status===401){link={...link,expires:0};write(file,link);identityState='needs_password';}
    return read(response);
  }
  async function connect({name,password,register}){
    const services=await availability().catch(()=>({}));
    if(services.localHall!==1&&services.platformVoice!==1)
      throw issue('正式站暂未开放本地版的平台声音。可以先用免费声音。',503);
    const headers={'Content-Type':'application/json'};
    const auth=await read(await fetch(new URL('/api/auth/'+(register?'register':'login'),url),{method:'POST',headers,
      body:JSON.stringify({name,password}),signal:AbortSignal.timeout(12000)}));
    const cookie=/pet_session=([^;]+)/.exec(auth.headers.get('set-cookie')||'')?.[0];
    if(!cookie)throw issue('没有收到线上通行证。',502);
    const device=await read(await fetch(new URL('/api/local-hall/device',url),{method:'POST',headers:{...headers,Cookie:cookie},body:'{}',signal:AbortSignal.timeout(12000)}));
    link={...await device.json(),origin:url.origin,hall:false,hallEnabled:services.localHall===1};
    fs.mkdirSync(directory,{recursive:true});write(file,link);
    return info();
  }
  function ensureIdentity({name,password,register=false}){
    if(linked())return Promise.resolve(info());
    if(identityJob)return identityJob.then(info);
    identityState='syncing';
    identityJob=(async()=>{
      const signal=AbortSignal.timeout(10000);
      const supported=await fetch(new URL('/api/local-voice/status',url),{signal});
      if(!supported.ok||(await supported.json()).platformVoice!==1)
        throw issue('线上账号暂时连不上。你仍可以在本机使用。',503,'voice_sync_unavailable');
      const requestAuth=action=>fetch(new URL('/api/auth/'+action,url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,password}),signal});
      const first=register&&!link?.accountId?'register':'login';
      let auth=await requestAuth(first);
      if(first==='register'&&auth.status===409)auth=await requestAuth('login');
      if(first==='login'&&auth.status===401&&!link?.accountId){
        auth=await requestAuth('register');
        if(auth.status===409)auth=await requestAuth('login');
      }
      if(auth.status===401||auth.status===409)throw issue('线上已有同名账号或密码已变更。请核对账号，当前小家和存档会保留。',409,'voice_sync_conflict');
      await read(auth);
      const {user}=await auth.json();
      if(link?.accountId&&user.id!==link.accountId)throw issue('线上身份不匹配，请核对原来的账号。',409,'voice_sync_conflict');
      const cookie=/pet_session=([^;]+)/.exec(auth.headers.get('set-cookie')||'')?.[0];
      if(!cookie)throw issue('线上账号没有返回授权。',502);
      const headers={'Content-Type':'application/json',Cookie:cookie};
      try{
        const response=await read(await fetch(new URL('/api/local-voice/device',url),{method:'POST',headers,body:'{}',signal}));
        const device=await response.json();
        link={...device,origin:url.origin,channel:'voice',hall:false,hallEnabled:false};
        write(file,link);
      }finally{
        fetch(new URL('/api/auth/logout',url),{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(3000)}).catch(()=>{});
      }
    })().catch(error=>{identityState=error.code==='voice_sync_conflict'?'conflict':'unreachable';throw error;})
      .finally(()=>{identityJob=null;});
    return identityJob.then(info);
  }
  const workPath=id=>path.join(directory,'hall-work',id,'status.json');
  function workState(id){
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))return null;
    const file=workPath(id);
    try{return {id,...JSON.parse(fs.readFileSync(file,'utf8')),updatedAt:fs.statSync(file).mtimeMs};}catch{return null;}
  }
  function visitProgress(){
    const work=path.join(directory,'hall-work');
    if(!fs.existsSync(work))return null;
    const latest=fs.readdirSync(work).map(workState).filter(Boolean).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
    if(!latest)return null;
    return {id:latest.id,stage:latest.stage||'',ready:!!latest.ready,failed:!!latest.failed,storyDate:latest.storyDate||'',otherPet:latest.otherPet||'',deliveryPending:!latest.ready||!latest.storyDate||latest.storyDate>chinaDay(now())};
  }
  function info(){
    return {linked:linked(),identity:linked()?'ready':identityJob?'syncing':identityState,inHall:linked()&&link.hall,hallEnabled:linked()&&link.hallEnabled!==false,visitNeedsRetry:!!visitProgress()?.failed,visitSyncError};
  }
  function refreshInfo(){
    if(checkingHall)return checkingHall;
    if(!linked()||Date.now()-hallCheckedAt<15000)return Promise.resolve(info());
    hallCheckedAt=Date.now();
    const current=link;
    checkingHall=availability().catch(()=>null).then(services=>{
      if(link===current&&services?.localHall!==undefined&&(services.localHall===1)!==link.hallEnabled){link.hallEnabled=services.localHall===1;write(file,link);}
      return info();
    }).finally(()=>{checkingHall=null;});
    return checkingHall;
  }
  async function prepareVisit(){
    const state=await refreshInfo();
    if(!state.hallEnabled||Date.now()<nextVisitSync)return state;
    try{
      await sync(!state.inHall);
      visitSyncError='';
    }catch(error){
      nextVisitSync=Date.now()+15000;
      visitSyncError=error.status===400||error.status===413?error.message:'宠物资料暂时没同步，稍后会重试。';
    }
    return info();
  }
  function sync(join=false){
    if(!linked()||(!join&&!link.hall))return Promise.resolve(null);
    if(publishing)return publishing;
    const snapshot=localProfile(),key=digest(JSON.stringify(snapshot));
    if(!join&&link.lastPublished===key)return Promise.resolve(null);
    const current=link;
    publishing=(async()=>{
      await fetchLocal('profile',{method:'POST',body:snapshot});
      if(link===current){link.hall=true;link.lastPublished=key;write(file,link);}
      return info();
    })().finally(()=>{publishing=null;});
    return publishing;
  }
  function mode(){return encodeURIComponent(language());}
  const platform=async()=> (await fetchLocal('voice')).json();
  async function speak(text,{voice:id,purpose,signal}={}){
    if(!linked())throw issue('请重新连接线上声音。',401,'voice_setup');
    const key=digest(JSON.stringify([link.accountId,id,text])),audio=path.join(directory,'hall-audio',key+'.mp3');
    if(fs.existsSync(audio))return fs.readFileSync(audio);
    if(speechJobs.has(key))return speechJobs.get(key);
    const job=(async()=>{
      const res=await fetchLocal('voice',{method:'POST',body:{text,voice:id,purpose},timeout:35000,signal});
      const bytes=Buffer.from(await res.arrayBuffer());
      if(res.headers.get('X-Pet-Voice-Source')==='own-key')bytes.usedOwnKey=true;
      saveBytes(audio,bytes);return bytes;
    })().finally(()=>speechJobs.delete(key));
    speechJobs.set(key,job);return job;
  }
  async function visitView(){return (await fetchLocal('visit?language='+mode())).json();}
  async function visitArchive(){
    const f=path.join(directory,'hall-visits','archive-'+mode()+'.json');
    try{
      if(!info().inHall)throw Error();
      const v=await visitView(),previous=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[];
      const items=new Map(previous.map(item=>[item.id,item]));
      for(const item of v.archive||[])items.set(item.id,item);
      const updated=[...items.values()];write(f,updated);return updated;
    }catch{return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[];}
  }
  function collectVisit(id){
    if(copies.has(id))return copies.get(id);
    const dir=path.join(directory,'hall-visits',id),marker=path.join(dir,'received.json');
    if(fs.existsSync(marker)&&JSON.parse(fs.readFileSync(marker,'utf8')).acknowledged)return Promise.resolve();
    const job=(async()=>{
      if(!fs.existsSync(marker)){
        const bundle=await (await fetchLocal('visit/'+id+'/bundle',{timeout:24000})).json();
        if(!bundle.stories?.original?.story||!Array.isArray(bundle.photos)||bundle.photos.length!==2)throw Error('串门作品没有收齐。');
        for(const mode of ['original','zh','mixed','en'])if(bundle.stories[mode]?.story)write(path.join(dir,'story-'+mode+'.json'),bundle.stories[mode]);
        for(const [index,value] of bundle.photos.entries())saveBytes(path.join(dir,'photo-'+index+'.jpg'),Buffer.from(value,'base64'));
        write(marker,{acknowledged:false});
      }
      await fetchLocal('visit/'+id+'/received',{method:'POST',body:{}});
      write(marker,{acknowledged:true});
    })().finally(()=>copies.delete(id));
    copies.set(id,job);return job;
  }
  async function storedVisit(id,part,edition){
    const isStory=part==='story';
    const type=isStory?'application/json; charset=utf-8':'image/jpeg';
    const selected=['zh','mixed','en','original'].includes(edition)?edition:mode();
    const key=isStory?'story-'+selected+'.json':part.replace('/','-')+'.jpg';
    const f=path.join(directory,'hall-visits',id,key);
    if(fs.existsSync(f)){
      if(isStory&&info().inHall)collectVisit(id).catch(()=>{});
      return {type,bytes:fs.readFileSync(f)};
    }
    if(!info().inHall)return null;
    const result=await fetchLocal('visit/'+id+'/'+part+'?language='+selected);
    const bytes=Buffer.from(await result.arrayBuffer());
    if(!isStory||JSON.parse(bytes).story){saveBytes(f,bytes);if(isStory)collectVisit(id).catch(()=>{});}
    return {type,bytes};
  }
  async function send(b){
    await sync();
    const result=await (await fetchLocal('visit/send',{method:'POST',body:{targetId:b.targetId}})).json();
    if(!workState(result.sent.id))write(workPath(result.sent.id),{stage:'等到约好的那天',storyDate:result.sent.storyDate,otherPet:result.sent.otherPet});
    pump(true).catch(()=>{});return {...await visitView(),sent:result.sent};
  }
  function retryVisit(id){
    const item=id===undefined?visitProgress():workState(id);
    if(!item?.failed)throw issue('没有需要重试的这次串门。',409);
    (working||Promise.resolve()).catch(()=>{}).then(()=>pump(true,item.id)).catch(()=>{});
  }
  function pump(force=false,retryId=null){
    if(working)return working;
    if(!linked()||!link.hall||(!force&&Date.now()-lastCheck<60000))return Promise.resolve(null);
    lastCheck=Date.now();
    working=(async()=>{
      const {jobs}=await (await fetchLocal('work')).json();
      for(const job of jobs){
        if(job.storyDate>chinaDay(now()))continue;
        const dir=path.join(directory,'hall-work',job.id);fs.mkdirSync(dir,{recursive:true});
        const resume=retryId===job.id;
        if(workState(job.id)?.failed&&!resume)continue;
        const update=(stage,flags={})=>write(workPath(job.id),{storyDate:job.storyDate,otherPet:job.target,stage,...flags});
        let stage='收集宠物形象';
        try{
          update(stage);
          for(const part of ['requester','target',...(job.room?['room']:[])]){
            const target=path.join(dir,part+'.png');
            if(!fs.existsSync(target)){const r=await fetchLocal('work/'+job.id+'/'+part);saveBytes(target,Buffer.from(await r.arrayBuffer()));}
          }
          const storyFile=path.join(dir,'story.json');
          let story=fs.existsSync(storyFile)?JSON.parse(fs.readFileSync(storyFile,'utf8')):null;
          if(!story){
            stage='写故事';update(stage);
            const storyEvent=job.storyEvent||reserveStoryEvent(directory,{key:'visit:'+job.id,date:job.storyDate,roles:['home',job.target]});
            const themeHistory=job.themeHistory||((await visitArchive()).slice(0,8).reverse().map(item=>({date:item.storyDate,text:item.title})).filter(item=>item.text));
            const draft=await planVisitDraft({
              host:{petName:job.target,formFile:path.join(dir,'target.png')},
              guest:{petName:job.requester,formFile:path.join(dir,'requester.png')},
              place:job.place,themeHistory,storyEvent,planner:voice.planVisitStory,describe:voice.describePhoto
            });
            story=draft.story;
            write(storyFile,story);
          }
          const trip={place:job.place,guestName:job.requester,hostName:job.target,guestCustom:job.requesterCustom,hostCustom:job.targetCustom,story};
          const room=require('./home-service').roomsFor({petProfile:{}}).find(room=>room.id===job.roomId);
          const roomFile=job.room?path.join(dir,'room.png'):room?path.join(ROOT,'public',room.image.slice(1)):null;
          const photos=[];
          for(let index=0;index<2;index++){
            stage='画第 '+(index+1)+' 张图';update(stage);
            const b=await generateTripPhoto({formFile:path.join(dir,'target.png'),guestFile:path.join(dir,'requester.png'),roomFile:roomFile&&fs.existsSync(roomFile)?roomFile:null,trip,index,dir:path.join(dir,'photo-'+index),allowResubmit:resume});
            photos.push(b.toString('base64'));
          }
          const editions={};
          stage='整理故事版本';update(stage);
          await Promise.all(['mixed','en'].map(async lang=>{
            const f=path.join(dir,'edition-'+lang+'.json');
            try{
              editions[lang]=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):await voice.narrateVisitStory(story,lang);
              if(!fs.existsSync(f))write(f,editions[lang]);
            }catch{}
          }));
          stage='提交故事';update(stage);
          await fetchLocal('work/'+job.id+'/result',{method:'POST',body:{story,photos,editions,mode:'zh'},timeout:30000});
          update('已准备好',{ready:true});
        }catch(error){update(stage,{failed:true,message:error.message||'串门故事还没有做好。'});}
      }
    })().finally(()=>{working=null;});
    return working;
  }
  return {info,refreshInfo,prepareVisit,connect,ensureIdentity,linked,sync,platform,speak,visitView,visitArchive,storedVisit,send,fetchLocal,pump,visitProgress,retryVisit,mode};
}
module.exports={enabled,voiceEnabled,createHall,createHallClient,jsonBody};
