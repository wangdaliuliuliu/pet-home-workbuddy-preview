'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const speech = require('../local-speech');
const run = promisify(execFile);
const release = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const registry = 'https://registry.npmmirror.com';
const addonHash = '1PSACfQgPXAD7ExwCv1QW09EXTjcNlpZKBqDY+jxSdIzlyOSq0M13SILBoUQUfeJqiTTXnqp6Ha9jjMUQ6efXg==';
const runtimes = {
  'win32-x64':['win-x64','7vwdAw9PGEb0JLSpK7UFxAdp1vabBHK9Nhw2jFRBWSFgtslUPHIB0T6syJfRgiUGyCeNW9fJvcFAk2F2u7hBEw=='],
  'darwin-x64':['darwin-x64','SBnHa3LDOSI/5/rpBHGxKQDFq+yIdxowYY0InLzfojTUx+yGgqu7cYBrRxjzvHOiOKi0O4rmlFVZboyhIqpDgA=='],
  'darwin-arm64':['darwin-arm64','agXmbbwiVPUSMViMhWhYAt59iG21ui7x6HxQFU35XzHOfQe9x6Pg9V160Pzak/66x0ePMjixsLUtMaaUrLfCwQ=='],
  'linux-x64':['linux-x64','w5mRRrIvPvcNWac7rQ8AN/t/cwElPGoRpH+ceCRBV7XfjCIQ9Rcr3Ig/kXcJLNOxgK4bGmef+Y47lIWiesDODw==']
};

async function unpack(url, expected, directory, packageArchive = false) {
  const temp = fs.mkdtempSync(path.join(speech.root, 'install-'));
  try {
    const archive = path.join(temp, 'archive.tar.bz2');
    const response = await fetch(url, {signal:AbortSignal.timeout(300000)});
    if (!response.ok) throw Error(`本机声音下载返回 ${response.status}。`);
    const hash = crypto.createHash(packageArchive?'sha512':'sha256');
    await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_,next){hash.update(chunk);next(null,chunk);}}),fs.createWriteStream(archive));
    if (hash.digest(packageArchive?'base64':'hex') !== expected) throw Error('本机声音安装包校验失败。');
    const unpacked = path.join(temp,'unpacked');
    fs.mkdirSync(unpacked);
    const python=process.env.PET_IMAGE_PYTHON || (process.platform==='win32'?'python':'python3');
    await run(python,['-c','import sys, tarfile; archive=tarfile.open(sys.argv[1]); archive.extractall(sys.argv[2], filter="data"); archive.close()',archive,unpacked],{windowsHide:true,timeout:90000});
    const unpackedRoot=packageArchive ? path.join(unpacked,'package') : unpacked;
    fs.renameSync(unpackedRoot,directory);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}

function installAddon(suffix, digest) {
  const name = 'sherpa-onnx-'+suffix;
  const directory = path.join(speech.root,'node_modules',name);
  fs.mkdirSync(path.dirname(directory),{recursive:true});
  if (fs.existsSync(directory)) return;
  return unpack(`${registry}/${name}/-/${name}-${speech.engineVersion}.tgz`,digest,directory,true);
}

function lockInstallation(file) {
  try { return fs.openSync(file,'wx'); }
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    const pid=Number(fs.readFileSync(file,'utf8'));
    if(pid>0){
      try { process.kill(pid,0); }
      catch(probe){
        if(probe.code!=='ESRCH')throw probe;
        fs.unlinkSync(file);
        return fs.openSync(file,'wx');
      }
    }
    throw Error('另一处正在安装本机声音，请等它完成后重试。');
  }
}

async function install() {
  if (speech.installation()) return;
  const runtime = runtimes[`${process.platform}-${process.arch}`];
  if (!runtime) throw Error('这台电脑的系统还没有本机声音安装包。');
  fs.mkdirSync(speech.root,{recursive:true});
  const lock = path.join(speech.root,'install.lock');
  const fd = lockInstallation(lock);
  try {
    fs.writeFileSync(fd,String(process.pid));
    const model = path.join(speech.root,'model');
    console.log('正在准备本机朗读工具和中英音色…');
    await Promise.allSettled([
      installAddon('node',addonHash),
      installAddon(...runtime),
      fs.existsSync(model) ? null : unpack(`${release}/tts-models/${speech.modelDirectory}.tar.bz2`,'259c9c8bc906d6078e4e0570421885dabb68b539c2f970fcbb890a58eeaf3e9c',model)
    ]).then(results=>{for(const result of results)if(result.status==='rejected')throw result.reason;});
    await speech.warm();
    const verified = [];
    for (const voice of speech.voices) {
      const start = performance.now();
      const wav = await speech.synthesize('你好呀！Hello, friend.',voice.id);
      const durationMs = Math.round(performance.now()-start);
      fs.writeFileSync(path.join(speech.root,voice.id+'.wav'),wav);
      verified.push({id:voice.id,durationMs});
      console.log(`${voice.name}现场合成完成，耗时 ${durationMs} 毫秒。`);
    }
    if (verified.every(item=>item.durationMs>6000)) throw Error('试读时间超过六秒，本机声音暂不可用。');
    const ready = path.join(speech.root,'ready.json');
    fs.writeFileSync(ready+'.tmp',JSON.stringify({version:speech.engineVersion,voices:verified}));
    fs.renameSync(ready+'.tmp',ready);
  } finally { fs.closeSync(fd);fs.unlinkSync(lock); }
}

if (require.main === module) install().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports = {install, unpack};
