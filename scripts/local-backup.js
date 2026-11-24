'use strict';
const path=require('node:path');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');

async function main(){
  const [operation, filename]=process.argv.slice(2);
  if(!['backup','restore'].includes(operation)||!filename)throw Error('请选择备份或还原，并给出 ZIP 文件路径。');
  const directory=path.resolve(process.env.PET_DATA_DIR||path.join(__dirname,'../data/local-install'));
  const port=Number(process.env.PORT||3215);
  const identity=crypto.createHash('sha256').update(directory).digest('hex');
  const running=await fetch('http://127.0.0.1:'+port+'/api/local-launch',{signal:AbortSignal.timeout(2000)})
    .then(r=>r.json()).catch(()=>null);
  if(running?.instance===identity)throw Error('请先关闭宠物小家窗口，再备份或还原。');
  const prepared=path.join(__dirname,'../.tools/portable-python',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const python=fs.existsSync(prepared)?prepared:process.platform==='win32'?'python':'python3';
  const args=operation==='backup'?[directory,path.resolve(filename)]:[path.resolve(filename),directory];
  execFileSync(python,[path.join(__dirname,'local-backup.py'),operation,...args],{stdio:'inherit',windowsHide:true,timeout:90000});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
