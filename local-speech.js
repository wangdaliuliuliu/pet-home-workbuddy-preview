'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const root = path.resolve(__dirname, '.tools/pet-voice');
const engineVersion = '2.0.1';
const modelDirectory = 'kokoro-int8-multi-lang-v1_1';
const voices = [{id:'local-soft',speaker:3,name:'免费女声'}, {id:'local-warm',speaker:58,name:'免费男生'}];

function installation() {
  try {
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
    if (ready.version !== engineVersion || !Array.isArray(ready.voices) ||
        !fs.existsSync(path.join(root,'node_modules','sherpa-onnx-node','package.json')) ||
        !fs.existsSync(path.join(root,'model',modelDirectory,'model.int8.onnx'))) return null;
    return ready;
  } catch { return null; }
}

function worker() {
  process.once('disconnect',()=>process.exit());
  const sherpa = require(path.join(root,'node_modules','sherpa-onnx-node'));
  const tts = new sherpa.OfflineTts({
    model:{kokoro:{
      model:'model.int8.onnx', voices:'voices.bin', tokens:'tokens.txt',
      lexicon:'lexicon-us-en.txt,lexicon-zh.txt'
    },numThreads:2,provider:'cpu'},
    ruleFsts:'date-zh.fst,number-zh.fst,phone-zh.fst'
  });
  process.on('message',({id,speaker,output,text})=>{
    try {
      const config = new sherpa.GenerationConfig({sid:speaker,speed:1,silenceScale:0.35});
      const audio = tts.generate({text,generationConfig:config});
      if (!audio.samples.length) throw Error('本机语音没有生成音频。');
      sherpa.writeWave(output,audio);
      process.send({id});
    } catch(error) { process.send({id,error:error.message}); }
  });
  process.send({ready:true});
}

let processWorker, sequence=0;
function getWorker() {
  if (processWorker?.child.connected) return processWorker;
  const child = fork(__filename,['--worker'],{
    cwd:path.join(root,'model',modelDirectory),execArgv:[],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true
  });
  const jobs = new Map();
  let readyResolve, readyReject, idle;
  const ready = new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const engine = {child,ready,jobs,ref(){
    clearTimeout(idle);
    child.ref();child.channel?.ref();
  }};
  const startup = setTimeout(()=>child.kill(),15000);
  const release = () => {
    if (jobs.size) return;
    clearTimeout(idle);
    child.unref(); child.channel?.unref();
    idle = setTimeout(()=>child.kill(),180000);
    idle.unref();
  };
  child.on('message',message=>{
    if (message.ready) {clearTimeout(startup);readyResolve();return;}
    const job=jobs.get(message.id);
    if (!job) return;
    jobs.delete(message.id);
    if (message.error) job.reject(Error(message.error));
    else job.resolve();
    release();
  });
  const stopped = () => {
    clearTimeout(startup);clearTimeout(idle);
    const error=Error('本机声音进程没有准备好。');
    readyReject(error);
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
    if (processWorker===engine) processWorker=null;
  };
  child.once('exit',stopped);child.once('error',stopped);
  ready.then(release,()=>{});
  processWorker=engine;
  return engine;
}

const warm = () => getWorker().ready;

async function synthesize(text, id, signal) {
  const voice = voices.find(item => item.id === id);
  if (!voice) throw Error('没有找到这款本机声音。');
  const engine=getWorker();
  await engine.ready;
  signal?.throwIfAborted();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-speech-'));
  const output = path.join(temp, 'voice.wav');
  try {
    const jobId=++sequence;
    engine.ref();
    const deadline=setTimeout(()=>engine.child.kill(),25000);
    try {
      await new Promise((resolve,reject)=>{
        engine.jobs.set(jobId,{resolve,reject});
        engine.child.send({id:jobId,speaker:voice.speaker,output,text},error=>{
          if (!error) return;
          engine.jobs.delete(jobId);engine.child.kill();reject(error);
        });
      });
    } finally { clearTimeout(deadline); }
    signal?.throwIfAborted();
    const audio = fs.readFileSync(output);
    if (audio.length < 44 || audio.toString('ascii',0,4) !== 'RIFF' || audio.toString('ascii',8,12) !== 'WAVE') {
      throw Error('本机声音没有生成可播放的音频。');
    }
    return audio;
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}

if (require.main===module) worker();
module.exports = {root, engineVersion, modelDirectory, voices, installation, warm, synthesize};
