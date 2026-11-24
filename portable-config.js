'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const SERVICES=[['CHAT','聊天、写故事'],['ASR','听你说话'],['TTS','宠物说话'],['VISION','看图片'],['IMAGE','画新图片'],['NANOGPT','唱歌']];
const FIELDS=SERVICES.flatMap(([k])=>k==='NANOGPT'?['NANOGPT_API_KEY']:['PET_'+k+'_API_KEY','PET_'+k+'_BASE_URL','PET_'+k+'_MODEL',...(['ASR','TTS'].includes(k)?['PET_'+k+'_PROVIDER']:[])]);
function createPortableConfig({root,dataDir,owner,network=false}){
 const file=path.join(dataDir,'local-ai-settings.json'),envFile=path.join(root,'.env'),defaultFile=path.join(dataDir,'portable-ai-defaults.json');let settings=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{values:fs.existsSync(defaultFile)?JSON.parse(fs.readFileSync(defaultFile,'utf8')):{},ready:false};let accounts,getRuntime,token='';
 function apply(){for(const k of FIELDS)delete process.env[k];Object.assign(process.env,settings.values);process.env.STUDIO_ALLOW_PAID=settings.ready&&settings.allowPaid?'1':'0';process.env.PET_DISABLE_TRIPS=settings.autoTravel&&settings.allowPaid?'0':'1';}
 apply();
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 function local(req){return !network&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host||'');}
 function before(req){if(!network){if(!local(req))throw Object.assign(Error('请在自己的电脑上打开这个项目。'),{status:403});req.headers.cookie='pet_session='+token;}}
 async function handle(req,res,url){
  if(url.pathname==='/setup'&&!network){res.writeHead(302,{Location:'/portable-setup.html'});res.end();return true;}
  if(url.pathname.startsWith('/api/portable/')){
   if(!local(req)){json(res,403,{error:'请在自己的电脑上设置。'});return true;}
   if(req.method==='GET'&&url.pathname==='/api/portable/settings'){json(res,200,{ready:settings.ready,allowPaid:!!settings.allowPaid,autoTravel:!!settings.autoTravel,petName:owner.petName,services:SERVICES,values:Object.fromEntries(FIELDS.map(k=>[k,k.endsWith('API_KEY')?Boolean(settings.values[k]):settings.values[k]||'']))});return true;}
   if(req.method==='GET'&&url.pathname==='/api/portable/drafts'){const p=path.join(dataDir,'browser-drafts.json');json(res,200,fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{});return true;}
   if(req.method==='GET'&&url.pathname==='/api/portable/tools'){
    const check=(command,args)=>new Promise(resolve=>{const p=spawn(command,args,{windowsHide:true,stdio:'ignore'});const t=setTimeout(()=>p.kill(),10000);p.once('error',()=>{clearTimeout(t);resolve(false)});p.once('close',c=>{clearTimeout(t);resolve(c===0)})});
    const python=process.env.PET_IMAGE_PYTHON;const [image,ffmpeg]=await Promise.all([check(python,['-c','from PIL import Image; import openai']),check(process.env.PET_IMAGE_FFMPEG||'ffmpeg',['-version'])]);json(res,200,{node:Number(process.versions.node.split('.')[0])>=22,image,ffmpeg});return true;
   }
   if(req.method==='POST'&&url.pathname==='/api/portable/settings'){
    let n=0,chunks=[];for await(const c of req){n+=c.length;if(n>24000)throw Object.assign(Error('内容太多了。'),{status:413});chunks.push(c)}const b=JSON.parse(Buffer.concat(chunks).toString()),values={...settings.values};
    for(const k of FIELDS)if(typeof b.values?.[k]==='string'){const v=b.values[k].trim();if(v.length>1500||/[\r\n\0]/.test(v))throw Object.assign(Error('有一项没填对，再看看吧。'),{status:400});if(k.endsWith('API_KEY')&&!v)continue;if(k.endsWith('BASE_URL')&&v){let u;try{u=new URL(v)}catch{}if(!u||u.username||u.password||u.search||!(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Object.assign(Error('服务地址请用完整的 https 地址。'),{status:400});}if(v)values[k]=v;else delete values[k];}
    for(const[k,label]of SERVICES)if(k!=='NANOGPT'&&values['PET_'+k+'_API_KEY']&&(!values['PET_'+k+'_BASE_URL']||!values['PET_'+k+'_MODEL']))throw Object.assign(Error('请给“'+label+'”填好服务地址和模型名称。'),{status:400});
    settings={values,ready:true,allowPaid:b.allowPaid===true,autoTravel:b.autoTravel===true,networkPasswordSet:settings.networkPasswordSet};
    if(b.password){const {passwordHash}=require('./account-service');const dbFile=path.join(dataDir,'accounts.json'),db=JSON.parse(fs.readFileSync(dbFile,'utf8'));const u=db.users.find(u=>u.id===owner.id);u.password=await passwordHash(b.password);const live=accounts.users().find(x=>x.id===owner.id);live.password=u.password;db.sessions={};fs.writeFileSync(dbFile,JSON.stringify(db,null,2),{mode:0o600});settings.networkPasswordSet=true;}
    fs.writeFileSync(file,JSON.stringify(settings,null,2),{mode:0o600});fs.writeFileSync(envFile,'# 只留在自己的电脑上，不要分享\n'+Object.entries(values).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600});apply();if(getRuntime){const live=getRuntime(accounts.users().find(u=>u.id===owner.id));if(live.state.petProfile){live.state.travelEnabled=settings.autoTravel;live.save();}}json(res,200,{ok:true});return true;
   }
   json(res,404,{error:'没有找到这个按钮。'});return true;
  }
  if(!settings.ready&&!network&&!require('./local-agent').enabled()&&req.method==='GET'&&['/','/index.html','/studio','/job-studio.html','/office'].includes(url.pathname)){res.writeHead(302,{Location:'/setup'});res.end();return true;}
  return false;
 }
 return{before,handle,attach:(a,runtime)=>{accounts=a;getRuntime=runtime;const u=accounts.users().find(u=>u.id===owner.id);if(!u)throw Error('没有找到你自己的宠物存档。');token=accounts.session(u);},networkReady:()=>!!settings.networkPasswordSet};
}
module.exports={createPortableConfig,FIELDS};
