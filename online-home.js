'use strict';
// 便携版的「线上家」桥：孩子在这台电脑上养宠物，串门这件事连到线上。
// 只代理串门相关的接口（名单、发起、图片、故事、讲述），其余一律落回本地逻辑。
// 未配置时 linked() 为 false，行为与没有这个文件时完全一致。
const fs=require('node:fs'),path=require('node:path');
const DAY_MS=86400000;
function createOnlineHome({dataDir,now=()=>Date.now(),log=()=>{}}={}){
  const file=path.join(dataDir,'online-home.json');
  let cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  const save=()=>{if(cfg)fs.writeFileSync(file,JSON.stringify(cfg,null,2),{mode:0o600});};
  function linked(){return Boolean(cfg&&cfg.url&&cfg.token&&(!cfg.expires||cfg.expires>now()));}
  function info(){return linked()?{linked:true,url:cfg.url,login:cfg.login,childName:cfg.childName,linkedAt:cfg.linkedAt,expires:cfg.expires}:{linked:false};}
  // 代理层拿不到 server 的账号模块，attach 时注入，用于读取本地宠物名做上报摘要。
  let childNameOf=()=>'';
  function attach(nameOf){childNameOf=nameOf;}
  async function call(method,pathname,body){
    const headers={'Authorization':'Bearer '+cfg.token};
    if(body!==undefined){headers['Content-Type']='application/json';}
    const res=await fetch(cfg.url.replace(/\/$/,'')+pathname,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    return res;
  }
  // 绑定：用线上账号登录一次，换一个 90 天的设备 token 存在本机。
  async function link({login,password,url}){
    const base=String(url||cfg&&cfg.url||'').trim().replace(/\/$/,'');
    if(!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(base))throw Object.assign(Error('线上家地址请用完整的 https 网址。'),{status:400});
    const loginRes=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login,password}),signal:AbortSignal.timeout(15000)});
    if(!loginRes.ok)throw Object.assign(Error('名字或密码不对，再看看吧。'),{status:401});
    const cookie=/(?:^|;\s*)pet_session=([^;]+)/.exec(loginRes.headers.get('set-cookie')||'')?.[1];
    if(!cookie)throw Object.assign(Error('线上家没有接受这次登录。'),{status:401});
    const devRes=await fetch(base+'/api/auth/device',{method:'POST',headers:{'Content-Type':'application/json','Cookie':'pet_session='+cookie},body:'{}',signal:AbortSignal.timeout(15000)});
    if(!devRes.ok)throw Object.assign(Error('拿不到这台电脑的通行证。'),{status:502});
    const data=await devRes.json();
    const me=await fetch(base+'/api/auth/me',{headers:{'Authorization':'Bearer '+data.token},signal:AbortSignal.timeout(15000)}).then(r=>r.json()).catch(()=>({}));
    cfg={url:base,token:data.token,login:String(login).trim(),childName:me.user?.childName||'',linkedAt:now(),expires:data.expires||now()+90*DAY_MS,pending:cfg&&cfg.pending||[]};
    save();
    await flushPending();
    return info();
  }
  function unlink(){cfg=null;if(fs.existsSync(file))fs.unlinkSync(file);}
  // 读书上报：本地保存故事后调用。失败不阻塞，存进 pending 待补报。
  async function reportReading(story){
    if(!linked())return {queued:true};
    const title=String(story?.transcript||story?.title||'').trim().slice(0,60);
    try{
      const res=await call('POST','/api/visit/reading-done',{title});
      if(res.ok)return {ok:true};
      throw Error('HTTP '+res.status);
    }catch(err){
      const today=new Date(now()+8*3600e3).toISOString().slice(0,10);
      if(!cfg.pending.some(p=>p.day===today))cfg.pending.push({day:today,title:title||undefined});
      save();log('reading-done 延后：'+err.message);
      return {queued:true};
    }
  }
  async function flushPending(){
    if(!linked()||!cfg.pending.length)return;
    const today=new Date(now()+8*3600e3).toISOString().slice(0,10);
    const rest=[];
    for(const p of cfg.pending){
      try{const res=await call('POST','/api/visit/reading-done',{title:p.title});if(!res.ok)rest.push(p);}
      catch{rest.push(p);}
    }
    cfg.pending=rest;save();
  }
  // 拉线上串门面板（供故事本合并与启动补报用）。
  async function visitView(){
    if(!linked())return null;
    try{const res=await call('GET','/api/visit');if(!res.ok)return null;return await res.json();}catch{return null;}
  }
  // 故事本合并：线上串门条目（含 preview）原样给，去重交给调用方。
  async function visitArchive(){
    const v=await visitView();
    if(!v)return [];
    const items=[...(v.previewVisits||[]),...(v.archive||[])];
    return items.map(item=>({...item,online:true}));
  }
  // HTTP 代理：拦截串门相关路径。命中返回 true（已应答）。
  async function handle(req,res,url){
    const p=url.pathname;
    if(p==='/api/online-home')return json(res,200,{...info(),pending:cfg?cfg.pending.length:0});
    if(/^\/api\/visit(\/|$)/.test(p)&&linked()){
      const method=req.method==='HEAD'?'GET':req.method;
      let body;
      if(req.method!=='GET'&&req.method!=='HEAD'){
        const chunks=[];let size=0;
        for await(const c of req){size+=c.length;if(size>4*1024*1024){res.writeHead(413);res.end();return true;}chunks.push(c);}
        body=Buffer.concat(chunks);
      }
      try{
        const upstream=await fetch(cfg.url.replace(/\/$/,'')+p+url.search,{method,headers:{'Authorization':'Bearer '+cfg.token,...(body?{'Content-Type':'application/json'}:{})},body,signal:AbortSignal.timeout(120000)});
        const buf=Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json; charset=utf-8','Cache-Control':'no-store'});
        res.end(req.method==='HEAD'?undefined:buf);
      }catch(err){
        json(res,502,{error:'现在连不上线上家，等网络好了再试串门吧。'});
      }
      return true;
    }
    return false;
  }
  function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
  function isLocal(req,res){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host||'');}
  // 绑定/解绑接口（给设置页用，仅本机）。
  async function control(req,res,url){
    if(url.pathname!=='/api/online-home/link'&&url.pathname!=='/api/online-home/unlink')return false;
    if(!isLocal(req,res)){res.writeHead(403,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'只能在这台电脑上设置。'}));return true;}
    if(url.pathname==='/api/online-home/unlink'&&req.method==='POST'){unlink();json(res,200,{linked:false});return true;}
    if(url.pathname==='/api/online-home/link'&&req.method==='POST'){
      const chunks=[];let size=0;
      for await(const c of req){size+=c.length;if(size>8000){res.writeHead(413);res.end();return true;}chunks.push(c);}
      try{
        const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
        const result=await link({login:body.login,password:body.password,url:body.url});
        json(res,200,result);return true;
      }catch(err){json(res,err.status||400,{error:err.message});return true;}
    }
    return false;
  }
  return {handle,control,link,unlink,reportReading,visitView,visitArchive,flushPending,info,linked,attach};
}
module.exports={createOnlineHome};
