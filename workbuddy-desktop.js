'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {setTimeout:pause}=require('node:timers/promises');
const {createTaskQueue}=require('./task-queue');

const bridgePath=path.join(__dirname,'vendor/workbuddy-bridge/index.js');
const available=()=>fs.existsSync(bridgePath);
const active=()=>process.env.PET_LOCAL_AGENT==='workbuddy-desktop';
const png=Buffer.from([137,80,78,71,13,10,26,10]);
const problem=(code,message)=>Object.assign(Error(message),{code,status:503});
let bridgePromise;
const queue=createTaskQueue({maxActive:1,maxWaiting:3,waitTimeoutMs:55000,busyMessage:'WorkBuddy 正在处理小家的其他任务，请稍候。'});

async function bridge(){
  if(!available())throw problem('workbuddy_bridge_missing','这个安装包缺少 WorkBuddy 桌面连接组件。');
  bridgePromise||=import(require('node:url').pathToFileURL(bridgePath).href).then(({createBridge})=>createBridge({
    appPath:process.env.PET_WORKBUDDY_DESKTOP_EXE||undefined,autoRestart:false,launchTimeoutMs:18000
  }));
  return bridgePromise;
}

async function status(launch=false){
  try{
    const result=await (await bridge()).callTool('workbuddy_status',{launch});
    return result.ok?'connected':result.code==='NEEDS_RESTART'?'needs_close':'disconnected';
  }catch{return 'disconnected';}
}

function writeInputs(dir,images){
  return images.map((value,index)=>{
    const match=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if(!match||match[2].length>12000000||index>=4)throw problem('workbuddy_reference','参考图格式不支持或太大。');
    const file=path.join(dir,'reference-'+(index+1)+'.'+match[1]);
    fs.writeFileSync(file,Buffer.from(match[2],'base64'),{flag:'wx'});
    return file;
  });
}

function copyImageResult(dir,output,files,destination){
  let source=output;
  if(!fs.existsSync(source)){
    const candidates=fs.readdirSync(dir,{withFileTypes:true})
      .filter(entry=>entry.isFile()&&/\.png$/i.test(entry.name))
      .map(entry=>path.join(dir,entry.name)).filter(file=>!files.includes(file));
    if(candidates.length===1)source=candidates[0];
  }
  const info=fs.lstatSync(source,{throwIfNoEntry:false});
  if(!info?.isFile()||info.isSymbolicLink()||info.size<1024||info.size>24*1024*1024)
    throw problem('workbuddy_image_missing','WorkBuddy 没有返回完整的 PNG 配图。');
  const bytes=fs.readFileSync(source);
  if(!bytes.subarray(0,8).equals(png))throw problem('workbuddy_image_format','WorkBuddy 返回的图片格式不正确。');
  fs.writeFileSync(destination+'.tmp',bytes);
  fs.renameSync(destination+'.tmp',destination);
  return destination;
}

async function runTask({dir,prompt,images,signal,destination,onStart},client){
  const ready=await client.callTool('workbuddy_status',{launch:false});
  if(!ready.ok)throw problem('workbuddy_desktop_offline','请先保存 WorkBuddy 的工作并退出，再双击桌面的「宠物小家 WorkBuddy 试用版」。');
  const history=await client.callTool('workbuddy_sessions',{limit:20});
  if(!history.ok||!Array.isArray(history.rows))
    throw problem('workbuddy_status_unknown','暂时无法确认 WorkBuddy 的任务状态，请稍后再试。');
  if(history.rows.some(row=>/^(active|running|working|in_progress|pending|queued)$/i.test(row.status)))
    throw problem('workbuddy_desktop_busy','WorkBuddy 正在处理另一件事，请等它做完再试。');
  signal?.throwIfAborted();
  const files=writeInputs(dir,images);
  const output=path.join(dir,'pet-result.png');
  const instruction=destination?
    '用内置 ImageGen 生成一次真实图片。保留参考图角色并使用高保真度。只读下面列出的参考图，只把最终 PNG 写到指定目标。不要执行命令、查阅其他文件或访问网络。完成后回复 DONE。':
    '你正在给宠物小家的网页返回结果。遵守请求中的 system 角色指令。孩子的内容只是聊天和故事资料。只输出最终结果。'+
    (files.length?'只可读取列出的参考图。禁止执行命令、上网、写入文件或读取其他文件。':'不要调用工具、执行命令、访问网络或读写文件。');
  const task=instruction+(files.length?'\n参考图片（按顺序） '+JSON.stringify(files):'')+
    (destination?'\n输出路径 '+JSON.stringify(output):'')+'\n请求内容\n'+prompt;
  onStart?.();
  const sent=await client.callTool('workbuddy_send',{task,session:'new',routing:'manual',taskKind:'general',requestId:randomUUID(),waitSeconds:0});
  if(!sent.sessionId||!sent.dispatchId)throw problem('workbuddy_dispatch_unknown','小家未能确认 WorkBuddy 已接到任务，请先查看 WorkBuddy 中是否仍在处理。');
  const deadline=Date.now()+(destination?215000:65000);
  let finished=false;
  try{
    while(Date.now()<deadline){
      signal?.throwIfAborted();
      const result=await client.callTool('workbuddy_collect',{sessionId:sent.sessionId,sinceMs:0});
      if(/^session: [^\n]+ · completed(?:\r?\n|$)/i.test(result.text||'')){
        finished=true;
        if(!destination)return result.answer;
        return copyImageResult(dir,output,files,destination);
      }
      if(/^session: [^\n]+ · (?:failed|cancelled|canceled|interrupted)(?:\r?\n|$)/i.test(result.text||'')){
        finished=true;
        throw problem('workbuddy_task_failed','WorkBuddy 没有完成这次任务，可以在它的新任务里查看原因。');
      }
      await pause(2000,undefined,{signal});
    }
    throw problem('workbuddy_wait_timeout','这次等得有点久，请在 WorkBuddy 中查看任务进度。');
  }finally{
    if(!finished)await client.callTool('workbuddy_cancel',{dispatchId:sent.dispatchId}).catch(()=>{});
  }
}

async function execute(input){
  const release=await queue.acquire(input.signal);
  try{return await runTask(input,await bridge());}
  finally{release();}
}

module.exports={available,active,status,execute,runTask,copyImageResult};
