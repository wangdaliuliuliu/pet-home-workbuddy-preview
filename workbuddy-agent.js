'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync,spawn}=require('node:child_process');
const environmentKeys=/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TMP|TEMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|LANG|LC_ALL)$/i;
const cliEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([name])=>environmentKeys.test(name)));

function findCli(){
  const explicit=process.env.PET_WORKBUDDY_CLI;
  if(explicit&&fs.existsSync(explicit))return path.resolve(explicit);
  if(process.platform!=='win32')return null;
  const running=(()=>{
    try{return execFileSync('powershell.exe',['-NoProfile','-Command',"(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1).Path"],{encoding:'utf8',windowsHide:true,timeout:3500}).trim();}
    catch{return '';}
  })();
  const roots=[running&&path.dirname(running),process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Programs','WorkBuddy'),process.env.ProgramFiles&&path.join(process.env.ProgramFiles,'WorkBuddy')];
  return roots.filter(Boolean).map(root=>path.join(root,'resources','app.asar.unpacked','cli','dist','codebuddy-lite-wb.mjs')).find(file=>fs.existsSync(file))||null;
}

async function execute({dir,prompt,images,signal,destination,onStart}){
  const cli=process.env.PET_WORKBUDDY_CLI;
  if(!cli)throw Error('没找到 WorkBuddy 的命令行。请打开 WorkBuddy 后重新启动小家。');
  const imageTool='ImageGen';
  const model=destination?(process.env.PET_WORKBUDDY_IMAGE_MODEL||'hy4flash'):
    images.length?(process.env.PET_WORKBUDDY_VISION_MODEL||'hy4flash'):(process.env.PET_WORKBUDDY_MODEL||'hy4-flash');
  const imageTools=[imageTool,'ToolSearch','DeferExecuteTool'];
  const permitted=destination?imageTools:['StructuredOutput'];
  const args=[cli,'--print','--model',model,'--input-format','stream-json','--output-format','stream-json','--verbose',
    '--no-session-persistence','--strict-mcp-config','--permission-mode','dontAsk','--max-turns',destination?'6':'1','--tools',permitted.join(','),
    '--allowedTools',...permitted,'--disallowedTools','Bash','PowerShell','Read','Write','Edit','Glob','Grep','Agent','WebFetch','WebSearch','Skill','VideoGen','LibraryUpload','SendMessage','AudioTranscribe',
    ...(destination?[]:imageTools)];
  const referencePaths=[];
  const content=[{type:'text',text:prompt}];
  for(const [index,image] of images.entries()){
    const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if(!match||match[2].length>12000000)throw Error('这张图片没法交给 WorkBuddy。');
    content.push({type:'image',source:{type:'base64',media_type:match[1],data:match[2]}});
    if(destination){
      if(index>=3)throw Error('WorkBuddy 图片工具最多接收三张参考图。');
      const file=path.join(dir,'reference-'+index+'.'+match[1].split('/')[1]);
      fs.writeFileSync(file,Buffer.from(match[2],'base64'));referencePaths.push(file);
    }
  }
  const imageOutput=path.join(dir,'picture');
  if(destination){
    fs.mkdirSync(imageOutput);
    const imageArguments={output_dir:imageOutput,...Object.fromEntries(referencePaths.map((file,index)=>['image'+(index+1),file]))};
    content[0].text+='\nImageGen is deferred. First use ToolSearch with tool_names ["ImageGen"]. Then use DeferExecuteTool for ImageGen exactly once. Include the required prompt and the following fixed tool parameters. Return the generated image: '+JSON.stringify(imageArguments);
  }
  const input=JSON.stringify({type:'user',message:{role:'user',content}})+'\n';
  const result=await new Promise((resolve,reject)=>{
    const childEnv=cliEnvironment();
    if(destination)childEnv.CODEBUDDY_IMAGE_GEN_ENABLED='1';
    const separatelyAuthorized=process.env.PET_WORKBUDDY_PRODUCT_CONFIG;
    if(separatelyAuthorized)childEnv.ACC_PRODUCT_CONFIG_PATH=separatelyAuthorized;
    const child=spawn(process.execPath,args,{cwd:dir,env:childEnv,signal,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stderr='',text='',toolUsed=false,result,activeModel='';
    const timer=setTimeout(()=>{child.kill();reject(Error('WorkBuddy 回答超时，稍后再试。'));},destination?200000:70000);
    const reader=require('node:readline').createInterface({input:child.stdout});
    reader.on('line',line=>{
      let message;
      try{message=JSON.parse(line);}catch{text=(text+line).slice(-4000);return;}
      if(message.type==='assistant'){
        activeModel=message.message?.model||activeModel;
        for(const block of message.message?.content||[]){
          if(block.type!=='tool_use')continue;
          const target=block.input?.tool_name||block.input?.toolName||block.input?.name;
          const allowed=permitted.includes(block.name)&&(block.name!=='DeferExecuteTool'||target===imageTool);
          if(!allowed){child.kill();reject(Error('WorkBuddy 尝试调用这项任务未授权的工具。'));return;}
          if(block.name===imageTool||block.name==='DeferExecuteTool')toolUsed=true;
        }
      }
      if(message.type==='result')result=message;
    });
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4000);});
    child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(Error('WorkBuddy 命令行没有启动。'));});
    child.on('close',code=>{
      clearTimeout(timer);
      const error=stderr+' '+text+' '+(result?.result||'')+' '+(result?.errors||[]).join(' ');
      if(/authentication required|use \/login|not logged|需要登录|unauthorized/i.test(error))return reject(Object.assign(Error('WorkBuddy 尚未授权给宠物小家。'),{code:'workbuddy_auth'}));
      if(code!==0||result?.is_error||!result)return reject(Error('WorkBuddy 没有完成这项请求。请检查当前账号是否支持所选模型。'));
      if(!destination&&!model.startsWith('custom-local:')&&activeModel&&activeModel!=='<synthetic>'&&activeModel.replaceAll('-','')!==model.replaceAll('-',''))return reject(Error('WorkBuddy 实际回答的模型与已选模型不一致。'));
      resolve({text:result.result,toolUsed});
    });
    child.on('spawn',()=>{try{onStart?.();child.stdin.end(input);}catch(error){child.kill();reject(error);}});
  });
  if(!destination)return result.text;
  const pictures=fs.readdirSync(imageOutput,{withFileTypes:true}).filter(file=>file.isFile()&&/\.png$/i.test(file.name));
  if(!result.toolUsed||pictures.length!==1||fs.lstatSync(imageOutput).isSymbolicLink())throw Error('WorkBuddy 本次没有返回完整的 PNG 图片。');
  const file=path.join(imageOutput,pictures[0].name);
  const size=fs.statSync(file).size;
  if(size<1024||size>24*1024*1024)throw Error('WorkBuddy 返回的图片大小异常。');
  const image=fs.readFileSync(file);
  if(!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('WorkBuddy 返回的图片格式异常。');
  fs.writeFileSync(destination+'.tmp',image);
  fs.renameSync(destination+'.tmp',destination);
  return destination;
}

module.exports={findCli,execute};
