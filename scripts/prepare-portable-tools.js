'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const root=path.resolve(__dirname,'..');
const tools=path.join(root,'.tools');
const version='0.9.18';
const archives={
  'win32-x64':['x86_64-pc-windows-msvc.zip','28cbe5d30907a774bfe27a517a39b494ec6f7d3816bda8bbf6f9645490449182'],
  'darwin-x64':['x86_64-apple-darwin.tar.gz','f86836c637333c65bbc7902acc9c49888eef9fbd15dccbc1946b10e30b041073'],
  'darwin-arm64':['aarch64-apple-darwin.tar.gz','dc3bee4abbb3bac267a3985a23ea7617d19d41ff381dbaf560ba415ad65af68f'],
  'linux-x64':['x86_64-unknown-linux-gnu.tar.gz','c2def3db178ade63933fa15ffc96e882c196ce53e06173dcee05b36c5f6f68f5'],
  'linux-arm64':['aarch64-unknown-linux-gnu.tar.gz','f8e23ec786b18660ade6b033b6191b7e9c283c872eeb8c4531d56a873decf160']
};
const windows=process.platform==='win32';

async function installUv(){
  const binary=path.join(tools,'uv-'+version+(windows?'.exe':''));
  if(fs.existsSync(binary))return binary;
  const archive=archives[process.platform+'-'+process.arch];
  if(!archive)throw Error('请先安装 Python 3.12 或更新版本。');
  const filename='uv-'+archive[0];
  const response=await fetch(`https://github.com/astral-sh/uv/releases/download/${version}/${filename}`,{signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw Error('GitHub 的 Python 安装工具暂时下载不了。');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==archive[1])throw Error('Python 安装工具校验失败。');
  const temp=fs.mkdtempSync(path.join(tools,'uv-setup-'));
  try{
    const zip=path.join(temp,filename);
    fs.writeFileSync(zip,bytes);
    await run('tar',['-xf',zip,'-C',temp],{windowsHide:true,timeout:30000});
    const exe=windows?'uv.exe':'uv';
    const source=windows?path.join(temp,exe):path.join(temp,filename.replace(/\.tar\.gz$/,''),exe);
    fs.renameSync(source,binary);
    return binary;
  }finally{fs.rmSync(temp,{force:true,recursive:true});}
}

async function prepare(){
  fs.mkdirSync(tools,{recursive:true});
  const venv=path.join(tools,'portable-python');
  const python=path.join(venv,windows?'Scripts/python.exe':'bin/python');
  const env={...process.env,UV_PYTHON_INSTALL_DIR:path.join(tools,'python'),UV_CACHE_DIR:path.join(tools,'uv-cache')};
  if(!fs.existsSync(python)){
    const system=windows?'python':'python3';
    try{
      await run(system,['-c','import sys; assert sys.version_info >= (3,12)'],{windowsHide:true,timeout:6000});
      await run(system,['-m','venv',venv],{windowsHide:true,timeout:60000});
    }catch{
      const uv=await installUv();
      await run(uv,['venv','--seed','--python','3.12',venv],{env,windowsHide:true,timeout:180000});
    }
  }
  const probe='from PIL import Image; import openai, pillow_heif, requests, imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())';
  let result;
  const probeOptions={windowsHide:true,timeout:15000,env:{...process.env,PYTHONIOENCODING:'utf-8'}};
  try{result=await run(python,['-c',probe],probeOptions);}
  catch{
    console.log('正在从开源软件包仓库安装图片、动画和音频工具…');
    await run(python,['-m','pip','--isolated','install','--index-url','https://pypi.org/simple','-r',path.join(__dirname,'image-requirements.txt'),'imageio-ffmpeg==0.6.0'],{windowsHide:true,timeout:240000});
    result=await run(python,['-c',probe],probeOptions);
  }
  const ffmpeg=result.stdout.trim();
  await run(ffmpeg,['-version'],probeOptions);
  process.env.PET_IMAGE_PYTHON=python;
  process.env.PET_IMAGE_FFMPEG=ffmpeg;
}

module.exports={prepare};
