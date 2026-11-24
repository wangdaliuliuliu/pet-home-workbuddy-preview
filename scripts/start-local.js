'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const crypto=require('node:crypto');
const {prepare,findCodex,inspectCodex,selection,dataDir}=require('./setup-local');

async function start() {
  process.env.PET_LOCAL_INSTALL = '1';
  process.env.PET_LOCAL_FIRST = '1';
  const selected=selection();
  process.env.PET_PORTABLE_NETWORK='0';
  delete process.env.PET_LOCAL_AGENT;
  if(selected.agent==='codex'&&await inspectCodex()){
    process.env.PET_CODEX_BIN=findCodex();
    process.env.PET_PORTABLE='1';
    process.env.PET_LOCAL_AGENT='codex';
  }else if(selected.agent==='codex')console.error('Codex 尚未登录。小家仍可打开，登录 Codex 后重新打开即可生成故事和图片。');
  if(selected.agent==='workbuddy'){
    process.env.PET_PORTABLE='1';
    process.env.PET_LOCAL_AGENT='workbuddy';
    if(typeof selected.cli==='string'&&path.isAbsolute(selected.cli)&&fs.existsSync(selected.cli))process.env.PET_WORKBUDDY_CLI=selected.cli;
  }
  if(selected.agent==='workbuddy-desktop'){
    process.env.PET_PORTABLE='1';
    process.env.PET_LOCAL_AGENT='workbuddy-desktop';
    process.env.PET_WORKBUDDY_DESKTOP_EXE=selected.exe||'';
    if(process.argv.includes('--connect-workbuddy'))await require('../workbuddy-desktop').status(true);
  }
  process.env.PET_VOICE_SETTINGS_V2 = '1';
  process.env.PET_DISABLE_TRIPS ||= '1';
  process.env.PET_DISABLE_VISIT_GEN ||= '1';
  process.env.PET_SKIP_ENV ||= '1';
  process.env.STUDIO_ALLOW_PAID = '0';
  if (!process.env.PET_IMAGE_PYTHON) {
    const bundled = process.platform==='win32'?'.tools/imagegen/Scripts/python.exe':'.venv/bin/python';
    const filename = path.join(__dirname,'..',bundled);
    process.env.PET_IMAGE_PYTHON = fs.existsSync(filename)?filename:process.platform==='win32'?'python':'python3';
  }
  process.env.PET_DATA_DIR=dataDir();
  const port=Number(process.argv.find(arg=>arg.startsWith('--port='))?.slice(7)||process.env.PORT||selected.port||3215);
  if(await existing(port)){openBrowser(port);return;}
  if(process.env.PET_LOCAL_PREPARE!=='0'){
    await prepare({asr:true,strict:false});
  }
  const speech=require('../local-speech');
  if(speech.installation())speech.warm().catch(error=>console.error(error.message));
  const {createServer} = require('../server');
  const server=createServer();
  server.once('error',async error=>{
    if(error.code!=='EADDRINUSE'){console.error(error.message);process.exitCode=1;return;}
    await server.close();
    await openExisting(port);
  });
  server.listen(port,'127.0.0.1',()=>{console.log('宠物小家 http://127.0.0.1:'+port);openBrowser(port);});
}
function openBrowser(port){
  if(!process.argv.includes('--open'))return;
  const setup=process.argv.includes('--setup-workbuddy')?'workbuddy':process.argv.includes('--setup-register')?'register':'';
  const url='http://127.0.0.1:'+port+(setup?'/account.html?localSetup='+setup:'');
  const command=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  const child=spawn(command,args,{windowsHide:true,stdio:'ignore',detached:true});
  child.on('error',()=>console.error('请在浏览器打开 '+url));child.unref();
}
async function openExisting(port){
  if(await existing(port))openBrowser(port);
  else{console.error('这个端口被其他程序占用了。');process.exitCode=1;}
}
async function existing(port){
  try{
    const result=await fetch('http://127.0.0.1:'+port+'/api/local-launch',{signal:AbortSignal.timeout(2000)});
    if(!result.ok)return false;
    const j=await result.json(),instance=crypto.createHash('sha256').update(path.resolve(process.env.PET_DATA_DIR)).digest('hex');
    return j.app==='pet-local-home'&&j.instance===instance&&j.agent===(process.env.PET_LOCAL_AGENT||'offline');
  }catch{return false;}
}
start().catch(error=>{console.error(error.message);process.exitCode=1;});
