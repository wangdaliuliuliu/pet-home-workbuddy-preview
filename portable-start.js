'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const root=__dirname,dataDir=path.join(root,'data');
const infoFile=path.join(dataDir,'portable-owner.json');
if(!fs.existsSync(infoFile)){console.error('请先解压完整的宠物项目，再打开。');process.exit(1);}
const owner=JSON.parse(fs.readFileSync(infoFile,'utf8'));
// A take-home project must never inherit the teacher's environment credentials.
for(const k of Object.keys(process.env))if(/^(PET_(CHAT|ASR|TTS|VISION|IMAGE|AI)_|OPENAI_|NANOGPT_|MINIMAX_|OSS_|PET_OSS_|STUDIO_ALLOW_PAID)/.test(k))delete process.env[k];
process.env.PET_PORTABLE='1';process.env.PET_DATA_DIR=dataDir;process.env.PET_DISABLE_TRIPS='1';process.env.PET_SECURE_COOKIE='0';process.env.PET_IMAGE_PYTHON=process.platform==='win32'?'python':'python3';
if(process.argv.includes('--codex'))process.env.PET_LOCAL_AGENT='codex';
const {createPortableConfig}=require('./portable-config');
(async()=>{
 const {createAccounts}=require('./account-service');let accounts=createAccounts(dataDir);
 if(!accounts.users().length){await accounts.register({login:'portable-'+crypto.randomBytes(6).toString('hex'),childName:owner.childName,petName:owner.petName,password:crypto.randomBytes(30).toString('hex')});const file=path.join(dataDir,'accounts.json'),db=JSON.parse(fs.readFileSync(file,'utf8'));Object.assign(db.users[0],owner,{legacy:false,showHarvestBox:owner.showHarvestBox!==false});fs.writeFileSync(file,JSON.stringify(db,null,2),{mode:0o600});}
 const ownDir=path.join(dataDir,'users',owner.id);
 // Rebase only explicitly marked paths; never change the original downloaded snapshot.
 function rebase(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name);if(ent.isSymbolicLink())throw Error('项目里有不认识的文件链接。');if(ent.isDirectory())rebase(p);else if(ent.name.endsWith('.json')){let s=fs.readFileSync(p,'utf8');if(s.includes('__PET_DATA__/')){const visit=v=>typeof v==='string'&&v.startsWith('__PET_DATA__/')?path.join(ownDir,v.slice(13)):Array.isArray(v)?v.map(visit):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x)])):v;fs.writeFileSync(p,JSON.stringify(visit(JSON.parse(s)),null,2));}}}}
 rebase(ownDir);
 const network=process.env.PET_PORTABLE_NETWORK==='1',portable=createPortableConfig({root,dataDir,owner,network});
 if(network&&!portable.networkReady())throw Error('请先在自己电脑上设置登录密码，再上线。');
 if(!network){
  process.env.PET_VOICE_SETTINGS_V2='1';
  const speech=require('./local-speech');
  if(process.env.PET_PORTABLE_PREPARE!=='0'){
   try{await require('./scripts/prepare-portable-tools').prepare();}
   catch(error){console.error('本机图片或音频工具还没装好，已保存的宠物和故事仍可查看。重新启动可重试。',error.code||'');}
   try{await require('./scripts/install-local-voice').install();}
   catch(error){console.error('免费声音暂未安装。重新启动可重试。',error.message);}
  }
  if(speech.installation())speech.warm().catch(error=>console.error(error.message));
  if(require('./local-agent').enabled()&&process.env.PET_PORTABLE_PREPARE!=='0'){
   try{await require('./scripts/install-local-asr').install();}
   catch(error){console.error('本机语音识别还没就绪。',error.message);}
  }
 }
 const {createServer}=require('./server');
 // 串门连线上家：存 data/online-home.json，未绑定时行为与原来完全一致。
 const onlineHome=require('./online-home').createOnlineHome({dataDir,log:console.error});
 const server=createServer({dataDir,portable,onlineHome});const port=Number(process.env.PORT||3210);
 onlineHome.flushPending().catch(()=>{});
 server.listen(port,network?'0.0.0.0':'127.0.0.1',()=>{const url='http://localhost:'+server.address().port;console.log('你的宠物在这里：'+url);console.log('关掉这个窗口，宠物网页就会停下来。');if(!network&&process.env.PET_PORTABLE_NO_OPEN!=='1'){const command=process.platform==='win32'?'cmd':process.platform==='darwin'?'open':'xdg-open',args=process.platform==='win32'?['/c','start','',url]:[url];const p=spawn(command,args,{windowsHide:true,stdio:'ignore'});p.on('error',()=>{});p.unref();}});
})().catch(e=>{console.error(e.message);process.exitCode=1});
