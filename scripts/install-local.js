'use strict';
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {spawn,spawnSync,execFileSync}=require('node:child_process');
const {dataDir,selection}=require('./setup-local');
const {requestCheck}=require('../workbuddy-install-check');

function available(port){
  return new Promise(resolve=>{
    const probe=net.createServer();
    probe.once('error',()=>resolve(null));
    probe.listen(port,'127.0.0.1',()=>{const assigned=probe.address().port;probe.close(()=>resolve(assigned));});
  });
}

async function install(){
  const agent=process.argv[2];
  if(!['workbuddy','workbuddy-desktop','codex','offline'].includes(agent))throw Error('安装时请选择 workbuddy、workbuddy-desktop、codex 或 offline。');
  const root=path.resolve(__dirname,'..');
  const identity=crypto.createHash('sha256').update(dataDir()).digest('hex');
  const matches=home=>home?.app==='pet-local-home'&&home.instance===identity&&home.agent===agent;
  const probe=(port)=>fetch('http://127.0.0.1:'+port+'/api/local-launch',{signal:AbortSignal.timeout(1000)}).then(async res=>res.ok?await res.json():null).catch(()=>null);
  let port=Number(process.env.PORT||selection().port||3215);
  const existing=await probe(port);
  if(existing?.instance===identity&&!matches(existing))throw Error('同一份存档已在另一个 Agent 下运行。请先关闭那个小家，再切换 Agent。');
  if(!matches(existing)&&!(await available(port)))port=await available(0);
  if(!port)throw Error('无法为宠物小家分配可用的本机端口。');
  const env={...process.env,PORT:String(port)};
  const setup=spawnSync(process.execPath,[path.join(__dirname,'setup-local.js'),'--'+agent],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  if(setup.error)throw setup.error;
  if(setup.status!==0){process.exitCode=setup.status||1;return;}
  const checkId=agent==='workbuddy'?requestCheck(dataDir()):null;

  const openMode=existing&&matches(existing)?[]:['--setup-register'];
  const runtimeEnv={...env,PET_LOCAL_PREPARE:'0'};
  if(checkId)delete runtimeEnv.PET_WORKBUDDY_PRODUCT_CONFIG;
  const child=spawn(process.execPath,[path.join(__dirname,'start-local.js'),'--open',...openMode],{
    cwd:root,env:runtimeEnv,detached:true,windowsHide:true,stdio:'ignore'
  });
  let failed=false;
  child.on('error',()=>{failed=true;});
  child.unref();
  let launched=false;
  for(let retry=0;retry<40&&!failed;retry++){
    if(matches(await probe(port))){launched=true;break;}
    await new Promise(resolve=>setTimeout(resolve,400));
  }
  if(!launched)throw Error('小家没有在本机启动。请让安装 Agent 检查端口和安装状态。');
  if(process.platform==='win32'){
    const script=`$ErrorActionPreference='Stop'
      $root=$env:PET_SHORTCUT_ROOT
      $name=-join (0x5ba0,0x7269,0x5c0f,0x5bb6 | ForEach-Object {[char]$_})
      if($env:PET_SHORTCUT_AGENT -eq 'workbuddy-desktop'){$name+=' WorkBuddy '+(-join (0x8bd5,0x7528,0x7248 | ForEach-Object {[char]$_}))}
      $desktop=[Environment]::GetFolderPath('DesktopDirectory')
      $shell=New-Object -ComObject WScript.Shell
      $link=$shell.CreateShortcut((Join-Path $desktop ($name+'.lnk')))
      if($link.TargetPath -and $link.WorkingDirectory -ne $root){
        $link=$shell.CreateShortcut((Join-Path $desktop ($name+' '+$env:PET_SHORTCUT_PORT+'.lnk')))
      }
      $link.TargetPath=$env:PET_SHORTCUT_NODE
      $link.Arguments='"'+(Join-Path $root 'scripts/start-local.js')+'" --open --port='+$env:PET_SHORTCUT_PORT
      if($env:PET_SHORTCUT_AGENT -eq 'workbuddy-desktop'){$link.Arguments+=' --connect-workbuddy'}
      $link.WorkingDirectory=$root
      $link.IconLocation=(Join-Path $root 'public/assets/pet-home.ico')+',0'
      $link.WindowStyle=7
      $link.Save()`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
      cwd:root,windowsHide:true,stdio:'inherit',timeout:12000,
      env:{...process.env,PET_SHORTCUT_ROOT:root,PET_SHORTCUT_NODE:process.execPath,PET_SHORTCUT_PORT:String(port),PET_SHORTCUT_AGENT:agent}
    });
  }
  if(checkId){
    const deadline=Date.now()+28000;
    let state='unavailable';
    while(Date.now()<deadline){
      const live=await probe(port);
      if(!matches(live)||!live.workbuddy)break;
      if(live.workbuddy.id===checkId&&live.workbuddy.state!=='checking'){state=live.workbuddy.state;break;}
      await new Promise(resolve=>setTimeout(resolve,400));
    }
    if(state==='ready'){console.log('小家已打开，运行中的 WorkBuddy 已通过文字检查。画图仍需单独实测。');return;}
    console.log(state==='authorization_required'?'小家已打开。运行中的 WorkBuddy 尚未授权，生成能力暂不可用。':'小家已打开，暂时无法确认运行中的 WorkBuddy 生成能力。');
    process.exitCode=state==='authorization_required'?3:4;
  }else if(agent==='workbuddy-desktop')console.log('宠物小家和桌面图标已准备好。保存手头的 WorkBuddy 工作并正常退出后，双击桌面的「宠物小家 WorkBuddy 试用版」连接。');
  else console.log('宠物小家已打开。');
}

install().catch(error=>{console.error(error.message);process.exitCode=1;});
