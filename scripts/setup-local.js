'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const {findCli}=require('../workbuddy-agent');
const desktop=require('../workbuddy-desktop');

const dataDir=()=>path.resolve(process.env.PET_DATA_DIR||path.join(__dirname,'../data/local-install'));
function selection(){
  const args=process.argv.slice(2);
  if(args.includes('--workbuddy-desktop'))return {agent:'workbuddy-desktop',exe:desktopExecutable()};
  if(args.includes('--workbuddy'))return {agent:'workbuddy',cli:findCli()};
  if(args.includes('--codex'))return {agent:'codex'};
  if(args.includes('--offline'))return {agent:'offline'};
  try{return JSON.parse(fs.readFileSync(path.join(dataDir(),'local-ai-settings.json'),'utf8'));}
  catch{return {agent:'offline'};}
}

function desktopExecutable(){
  if(process.platform!=='win32'||!desktop.available())throw Error('请使用完整的 Windows WorkBuddy 试用包。');
  try{
    const running=require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-Command','[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1).Path'],{encoding:'utf8',windowsHide:true,timeout:5000}).trim();
    if(running&&fs.existsSync(running))return running;
  }catch{}
  for(const root of [process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Programs'),process.env.ProgramFiles]){
    const candidate=root&&path.join(root,'WorkBuddy','WorkBuddy.exe');
    if(candidate&&fs.existsSync(candidate))return candidate;
  }
  throw Error('没有找到 WorkBuddy。请先正常打开并登录，再让 WorkBuddy 重新安装小家。');
}

function findCodex(){
  if(process.env.PET_CODEX_BIN)return process.env.PET_CODEX_BIN;
  if(process.platform==='win32'&&process.env.LOCALAPPDATA){
    const root=path.join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin');
    if(fs.existsSync(root)){
      const candidates=fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory())
        .map(entry=>path.join(root,entry.name,'codex.exe')).filter(file=>fs.existsSync(file));
      candidates.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
      if(candidates.length)return candidates[0];
    }
  }
  return 'codex';
}
async function inspectCodex(){
  try{await run(findCodex(),['login','status'],{windowsHide:true,timeout:6500});return true;}
  catch{return false;}
}
async function prepare({asr=true,strict=true}={}){
  const errors=[];
  async function step(label,action){
    try{await action();}
    catch(error){errors.push(label);console.error(label+'暂未准备好。',error.message);}
  }
  await step('切图和录音工具',()=>require('./prepare-portable-tools').prepare());
  await step('免费声音',()=>require('./install-local-voice').install());
  if(asr)await step('中英录音识别',()=>require('./install-local-asr').install());
  if(strict&&errors.length)throw Error(errors.join('、')+'安装失败，可重新运行安装，已安装的工具会保留。');
}
if(require.main===module)(async()=>{
  if(Number(process.versions.node.split('.')[0])<22)throw Error('请安装 Node.js 22 或更新版本。');
  const selected=selection();
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(selected.agent==='workbuddy-desktop'&&major===22&&minor<13)
    throw Error('WorkBuddy 试用版需要 Node.js 22.13 或更新版本。');
  if(selected.agent==='workbuddy'&&!selected.cli)throw Error('请先打开 WorkBuddy，再运行 npm run setup:local -- --workbuddy。');
  await prepare();
  if(selected.agent==='codex'&&!await inspectCodex())throw Error('本机工具已准备好。请先在官方 Codex 完成一次登录，再启动宠物小家。');
  fs.mkdirSync(dataDir(),{recursive:true});
  const port=Number(process.env.PORT||0);
  if(port)selected.port=port;
  const file=path.join(dataDir(),'local-ai-settings.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify(selected),{mode:0o600});
  fs.renameSync(file+'.tmp',file);
  console.log('本机工具已准备好。');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={prepare,findCodex,inspectCodex,selection,dataDir};
