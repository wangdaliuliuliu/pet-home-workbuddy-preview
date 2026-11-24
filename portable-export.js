'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {fail}=require('./account-service');
const CODE=['account-service.js','animation-service.js','audio-service.js','chat-history.js','chat-diagnostics.js','reading-topics.js','child-copy.js','child-name.js','evolution-service.js','home-service.js','job-music-service.js','job-nano-music-service.js','job-role-service.js','job-studio-server.js','media-store.js','memory-service.js','online-home.js','local-hall.js','shared-platform-voice.js','ops-today.js','pet-creation-service.js','pet-runtime.js','photo-service.js','reading-service.js','recording-response.js','server.js','story-rewards.js','task-queue.js','travel-name-migration.js','story-events.js','travel-story.js','trip-service.js','visit-service.js','voice-service.js','companion-language.js','companion-voice.js','local-speech.js','local-agent.js','workbuddy-agent.js','workbuddy-desktop.js','workbuddy-install-check.js','local-asr.js','work-completion.js','work-discovery.js','work-harvest.js','work-service.js','work-example.js','work-oss.js','trial-media-queue.js','portable-export.js','portable-start.js','portable-config.js','generic-pet-motion.js','pet-travel-policy.js','AGENTS.md'];
const SCRIPTS=['prepare-portable-tools.js','install-local-voice.js','install-local-asr.js','cutout-pet.py','image_gen.py','image-requirements.txt','inspect-animation-pack.py','inspect-evolution.py','evolution_canvas.py','evolution_alpha.py','normalize-photo.py','pack-animation.py','check-animation-storage.js','check-evolution.js','portable-zip.py','generic-pet-bind.py'];
const DIRS=['media','evolutions','animations','trip-audio','visit-audio','companion-audio','job-studio','pet-creation'];
function clean(value,source){
 if(Array.isArray(value))return value.map(v=>clean(v,source));
 if(value&&typeof value==='object'){const out={};for(const[k,v]of Object.entries(value)){if(/^(password|apiKey|api_key|authorization|accessToken|credentials|cookie|sessions|token)$/i.test(k))continue;out[k]=clean(v,source);}return out;}
 if(typeof value==='string'&&(value.startsWith(source+path.sep)||value.startsWith(source+'/')))return '__PET_DATA__/'+path.relative(source,value).split(path.sep).join('/');
 if(typeof value==='string'&&/^(pet-creation|evolutions|animations|media)[\\/]/.test(value))return value.replace(/\\/g,'/');
 return value;
}
function tree(root,relative,output,base){const dir=path.join(root,relative);if(!fs.existsSync(dir))return;if(fs.lstatSync(dir).isSymbolicLink())throw fail('文件还没准备好，请找老师帮忙。',409);for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const rel=path.join(relative,ent.name),file=path.join(root,rel),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw fail('文件还没准备好，请找老师帮忙。',409);if(ent.name.startsWith('.')||ent.name==='work'||ent.name==='photo-work'||ent.name==='trip-work'||/\.tmp$/.test(ent.name)||relative.startsWith('animations')&&/^(atlas|raw|source|candidate)/i.test(ent.name))continue;if(ent.isDirectory())tree(root,rel,output,base);else if(ent.isFile())output.push({source:file,name:base+'/'+rel.split(path.sep).join('/'),size:stat.size});}}
function runZip(python,manifest,target){return new Promise((resolve,reject)=>{const child=spawn(python,[path.join(__dirname,'scripts/portable-zip.py'),manifest,target],{windowsHide:true,stdio:'ignore'});const timer=setTimeout(()=>child.kill('SIGKILL'),180000);child.once('error',()=>{clearTimeout(timer);reject(fail('打包工具还没准备好，请找老师帮忙。',503))});child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(fail('这次没打包好，再试一次吧。',503))});});}
function createExporter({dataDir,visits,root=__dirname,python=process.env.PET_IMAGE_PYTHON||(process.platform==='win32'?path.join(__dirname,'.tools/imagegen/Scripts/python.exe'):'python3'),maxBytes=512*1024*1024,cacheMs=300000}={}){
 const base=path.join(dataDir,'portable-exports');fs.mkdirSync(base,{recursive:true,mode:0o700});const jobs=new Map(),retired=new Set();let active=null;
 // No old private download remains after restart or beyond the short reuse window.
 for(const name of fs.readdirSync(base))if(/^[a-f0-9-]+$/.test(name)){const p=path.join(base,name);if(!fs.lstatSync(p).isSymbolicLink())fs.rmSync(p,{recursive:true,force:true});}
 async function start(user,userDir,state,catalog,drafts={},visibleVisits={}){
  const snapshot=clean(JSON.parse(JSON.stringify(state)),userDir);
  delete snapshot.voiceBalance;
  delete snapshot.voiceCredits;
  delete snapshot.voiceRelayHash;
  delete snapshot.companionWallet;
  delete snapshot.companionDailyVoice;
  if(snapshot.companionVoice?.source!=='local')snapshot.companionVoice={source:'local',id:'local-soft'};
  // Older pets kept their speaking voice in server configuration, not in pet.json.
  if(!snapshot.voiceProfile)snapshot.voiceProfile={version:'export-default-voice',voice:process.env.PET_TTS_VOICE||'longpaopao_v3.6',rate:.9,description:'原来的说话声音',instruction:'自然、温柔地说中文，吐字清楚，语速稍慢。'};
  const availableVisits=new Map([...(visibleVisits.archive||[]),...(visibleVisits.previewVisits||[])].map(item=>[item.id,item]));
  const stamp=crypto.createHash('sha256').update(JSON.stringify({snapshot,drafts,visitIds:[...availableVisits.keys()]})).digest('hex'),old=jobs.get(user.id);
  if(old?.status==='working')return old;
  if(old?.status==='ready'&&old.stamp===stamp&&Date.now()-old.createdAt<cacheMs&&fs.existsSync(old.file))return old;
  if(old&&Date.now()-old.createdAt<15000)throw fail('刚刚打过包，等一会儿再重新打包吧。',429);
  if(active)throw fail('有个小伙伴正在打包，等一会儿再点吧。',429);
  const id=crypto.randomUUID(),dir=path.join(base,id);fs.mkdirSync(dir,{mode:0o700});const job={id,stamp,status:'working',createdAt:Date.now(),file:path.join(dir,'pet-project.zip')};jobs.set(user.id,job);active=job;
  job.done=(async()=>{try{
   const files=[];for(const name of CODE)if(fs.existsSync(path.join(root,name)))files.push({source:path.join(root,name),name});
   for(const name of SCRIPTS)if(fs.existsSync(path.join(root,'scripts',name)))files.push({source:path.join(root,'scripts',name),name:'scripts/'+name});
   tree(root,'public',files,'');for(const f of files)f.name=f.name.replace(/^\//,'');
   const target='data/users/'+user.id;for(const name of DIRS)tree(userDir,name,files,target);
   for(const s of snapshot.stories||[]){const name=s.id+'.audio',file=path.join(userDir,name);if(/^[a-f0-9-]+\.audio$/.test(name)&&fs.existsSync(file)){if(fs.lstatSync(file).isSymbolicLink())throw Error('unsafe recording');files.push({source:file,name:target+'/'+name,size:fs.statSync(file).size})}}
   for(const item of availableVisits.values()){
    if(item.status!=='ready'||!/^[a-f0-9-]{36}$/.test(item.id))continue;
    const record=visits?.read(item.id);
    if(!record||!visits.roleOf(record,user.id))continue;
    const participant=p=>({userId:p.userId===user.id?user.id:'',petName:p.petName});
    const saved={id:record.id,day:record.day,storyDate:record.storyDate,status:'ready',place:record.place,preview:record.preview===true,
      requester:participant(record.requester),target:participant(record.target),story:record.story,
      photos:record.photos.map((photo,index)=>({index,caption:photo.caption||''}))};
    const privateFile=path.join(dir,item.id+'.visit');
    fs.writeFileSync(privateFile,JSON.stringify(saved));
    files.push({source:privateFile,name:'data/visits/records/'+item.id+'.json'});
    for(const relative of [
     ...saved.photos.map(({index})=>'visits/media/'+item.id+'/'+index+'.jpg'),
     ...['zh','mixed','en'].map(mode=>'visits/narrations/'+item.id+'/'+mode+'.json')
    ]){
     const source=path.join(dataDir,relative);
     if(fs.existsSync(source)&&fs.lstatSync(source).isFile())files.push({source,name:'data/'+relative});
    }
   }
   const cloudJSON=new Map(),oss=require('./work-oss'),cloud=oss.createStore();let cloudBytes=files.reduce((s,f)=>s+(f.size??fs.statSync(f.source).size),0);
   async function download(entry,name){if(files.some(f=>f.name===name))return;if(!cloud.enabled)throw fail('先连接作品存储，再带走宠物。',503);cloudBytes+=entry.size||0;if(cloudBytes>maxBytes)throw fail('作品有点多，请找老师帮忙。',413);const b=await cloud.get(entry.key);if(crypto.createHash('sha256').update(b).digest('hex')!==entry.sha256)throw Error('OSS checksum mismatch');const temp=path.join(dir,crypto.randomUUID()+'.asset');fs.writeFileSync(temp,b);files.push({source:temp,name,size:b.length});}
   for(const f of files.slice()){if(!f.name.startsWith(target+'/job-studio/')||!f.name.endsWith('/result.json'))continue;const r=JSON.parse(fs.readFileSync(f.source));if(!r.oss)continue;for(const [kind,entry] of Object.entries(r.oss)){if(!['image','speech','music'].includes(kind)||!entry.key.startsWith(oss.ownerPrefix(userDir)))throw Error('unsafe OSS object');const name=f.name.replace(/result\.json$/,kind==='image'?'image.png':kind+'.mp3');await download(entry,name);}delete r.oss;cloudJSON.set(f.name,r);}
   for(const w of (catalog||[]).filter(w=>w.authorId===user.id||snapshot.work?.schedule?.some(s=>s.work?.id===w.id))){for(const url of [...(w.example?.images||[]),...Object.values(w.example?.media||{})]){const m=url.match(/^\/api\/work-examples\/([a-f0-9-]{36}\/(?:image\.png|speech\.mp3|music\.mp3|input[0-5]\.(?:png|jpg|webp)))$/);if(!m)continue;const name='data/work-examples/'+m[1],src=path.join(dataDir,'work-examples',m[1]);if(fs.existsSync(src+'.oss.json')){const entry=JSON.parse(fs.readFileSync(src+'.oss.json'));if(entry.key!=='work-examples/'+m[1])throw Error('unsafe example object');await download(entry,name);}else if(fs.existsSync(src)&&!fs.lstatSync(src).isSymbolicLink())files.push({source:src,name,size:fs.statSync(src).size});}}
   const total=files.reduce((s,f)=>s+(f.size??fs.statSync(f.source).size),0);if(total>maxBytes)throw fail('故事有点多，这次请找老师帮你带走。',413);const space=fs.statfsSync(base);if(Number(space.bavail)*Number(space.bsize)<total+64*1024*1024)throw fail('打包的位置不够了，请找老师帮忙。',507);job.sourceBytes=total;
   // Pending paid tasks are explicitly stopped in the copy, never in the live pet.
   for(const issue of Object.values(snapshot.work?.issues||{}))if(issue.status!=='ready'){issue.status='failed';for(const n of Object.values(issue.nodes||{}))if(n.status!=='ready'){n.status='failed';n.failures=3;}}
   for(const group of ['trips','animationPacks','readingJobs'])for(const entry of Object.values(snapshot[group]||{}))if(['generating','processing','pending','running'].includes(entry.status)){entry.status='failed';entry.error='这一步还没做完，原来收好的内容都在。';}
   if(snapshot.evolution?.status==='generating'){snapshot.evolution.status='failed';snapshot.evolution.error='新形象还没准备好，原来的模样还在。';}
   const account={id:user.id,login:user.login,childName:user.childName,petName:user.petName,legacy:false,needsPetSetup:user.needsPetSetup===true,showHarvestBox:!!user.legacy||user.showHarvestBox!==false,portable:true};
   const published=(catalog||[]).filter(w=>w.authorId===user.id||snapshot.work?.schedule?.some(s=>s.work?.id===w.id));
   const overrides={};const add=(name,value)=>{const temp=path.join(dir,crypto.randomUUID()+'.json');fs.writeFileSync(temp,typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});overrides[name]=temp;};
   add(target+'/pet.json',snapshot);add('data/portable-owner.json',account);add('data/work-catalog.json',{jobs:clean(published,userDir)});add('data/browser-drafts.json',{...clean(drafts,userDir),exportId:id});
   const defaults={};for(const kind of ['CHAT','ASR','TTS','VISION','IMAGE'])for(const suffix of ['MODEL','PROVIDER','BASE_URL']){const key='PET_'+kind+'_'+suffix,value=process.env[key];if(!value)continue;if(suffix==='BASE_URL'){let u;try{u=new URL(value)}catch{continue}if(!['api.deepseek.com','dashscope.aliyuncs.com','api.openai.com'].includes(u.hostname)||u.search||u.username||u.password)continue;}defaults[key]=value;}for(const kind of ['ASR','TTS'])if(defaults['PET_'+kind+'_PROVIDER']==='bailian'&&!defaults['PET_'+kind+'_BASE_URL'])defaults['PET_'+kind+'_BASE_URL']='https://dashscope.aliyuncs.com/api/v1';add('data/portable-ai-defaults.json',defaults);
   for(const f of files)if(f.name.startsWith(target+'/')&&f.name.endsWith('.json')){try{add(f.name,clean(JSON.parse(fs.readFileSync(f.source,'utf8')),userDir));}catch{throw fail('有份记录还没收好，等一会儿再试。',409);}}
   for(const [name,value] of cloudJSON)add(name,clean(value,userDir));
   // The child's copy only stores files on its own computer/server; no cloud account or SDK.
   add('work-oss.js',`'use strict';
const crypto=require('node:crypto'),path=require('node:path');
const mime=n=>({'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.mp3':'audio/mpeg'}[path.extname(n)]||'application/octet-stream');
const createStore=()=>({enabled:false,mime});
module.exports={createStore,forPet:createStore,mime,ownerPrefix:dir=>'work-assets/'+crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0,24)+'/'};
`);
   add('package.json',{name:'my-pet-project',version:'1.0.0',private:true,scripts:{start:'node portable-start.js','start:codex':'node portable-start.js --codex','install:local-voice':'node scripts/install-local-voice.js','check:evolution':'node scripts/check-evolution.js'}});
   add('.gitignore','data/\n.env\nnode_modules/\n.tools/\n*.log\n');
   add('打开我的宠物.cmd','@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n echo 请大人先安装 Node.js 22 或更新版本：https://nodejs.org/\r\n pause\r\n exit /b 1\r\n)\r\nnode portable-start.js\r\npause\r\n');
   add('打开我的宠物.command','#!/bin/sh\ncd "$(dirname "$0")"\nnode portable-start.js\n');
   add('先看这里.txt','这是你自己的宠物项目。\n1. 把ZIP解压到一个新文件夹，请大人安装 Node.js 22 或更新版本。\n2. 使用 Codex 时，请先在这台电脑登录 Codex，然后让它在宠物文件夹运行 npm run start:codex。打开启动后给出的网址。聊天和故事使用你的 Codex，录音转文字在电脑上完成，朗读声音到“陪伴语言”里选。\n3. 也可以双击“打开我的宠物.cmd”（Windows）或在终端运行 npm start。这个启动方式可以在 /setup 配置自己的 AI 服务。已有故事和图片可以继续看。\n4. 图片、声音、宠物和存档都在 data 文件夹，不用配置 OSS。以后就修改这份项目。\n5. 首次打开会从开源社区安装图片、骨骼、录音及免费语音工具。联网安装完成后，本机工具可离线使用；Codex 写作和出图需要联网。\n6. 请先关闭项目，再复制data备份。不要公开data或.env，不要把项目的完整ZIP放到公开网站。\n7. 本机打开默认只认识你这一只宠物；自己部署服务器时设 PET_PORTABLE_NETWORK=1 并在本机设置自己的登录密码，再启用HTTPS。\n');
   add('portable-manifest.json',{version:1,createdAt:new Date().toISOString(),ownerId:user.id,petName:user.petName,sourceBytes:total,scope:'current-account-only',credentialsIncluded:false});
   const manifest={files:files.filter(f=>!overrides[f.name]).map(({source,name})=>({source,name})).concat(Object.entries(overrides).map(([name,source])=>({source,name})))};
   const input=path.join(dir,'manifest.json');fs.writeFileSync(input,JSON.stringify(manifest),{mode:0o600});await runZip(python,input,job.file);job.bytes=fs.statSync(job.file).size;job.durationMs=Date.now()-job.createdAt;job.status='ready';
   // Only the archive is retained; temp manifests can contain private server paths.
   for(const name of fs.readdirSync(dir))if(name!=='pet-project.zip')fs.rmSync(path.join(dir,name),{force:true});
   if(old&&old!==job){retired.add(old);sweep();}
  }catch(e){job.status='failed';job.error=e.status?e.message:'这次没打包好，再试一次吧。';fs.rmSync(dir,{recursive:true,force:true});}finally{active=null;}})();return job;
 }
 function status(user){const j=jobs.get(user.id);return j?{status:j.status,bytes:j.bytes,durationMs:j.durationMs,error:j.error,createdAt:j.createdAt}: {status:'none'};}
 function download(user){const j=jobs.get(user.id);if(!j||j.status!=='ready'||Date.now()-j.createdAt>cacheMs||!fs.existsSync(j.file))throw fail('先点一下“带走我的宠物”吧。',409);return j;}
 function sweep(){for(const j of new Set([...jobs.values(),...retired]))if(j.status!=='working'&&!j.downloads&&(retired.has(j)||Date.now()-j.createdAt>cacheMs)){try{fs.rmSync(path.join(base,j.id),{recursive:true,force:true});retired.delete(j);for(const[id,current]of jobs)if(current===j)jobs.delete(id)}catch{}}}
 const timer=setInterval(sweep,60000);timer.unref();
 return{start,status,download,sweep,close:()=>clearInterval(timer)};
}
module.exports={createExporter,clean,CODE,SCRIPTS};
