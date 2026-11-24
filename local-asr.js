'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const speech=require('./local-speech');
const model='sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const modelDir=path.join(speech.root,'asr',model);
const modulePath=path.join(speech.root,'node_modules','sherpa-onnx-node');
const ready=()=>fs.existsSync(path.join(modelDir,'model.int8.onnx'))&&fs.existsSync(path.join(modelDir,'tokens.txt'))&&fs.existsSync(modulePath);
const failure=(message,status)=>Object.assign(Error(message),{status});

async function transcribe(bytes,signal){
  if(!ready())throw failure('本机录音识别还在准备。',503);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pet-asr-'));
  try{
    const file=path.join(temp,'input.wav');fs.writeFileSync(file,bytes,{mode:0o600});
    let text;
    try{
      const result=await run(process.execPath,[__filename,file],{cwd:modelDir,signal,windowsHide:true,timeout:25000,maxBuffer:250000});
      text=JSON.parse(result.stdout).trim();
    }catch{throw failure('本机录音识别失败，请再试一次。',502);}
    if(!text)throw failure('录音里还没听到声音，靠近一点再讲几秒吧。',422);
    return text;
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}

function recognize(filename){
  const addon=require(modulePath);
  const wave=addon.readWave(filename);
  if(!wave?.samples?.length||wave.sampleRate!==16000)throw Error('Invalid PCM');
  const loudness=Math.sqrt(wave.samples.reduce((sum,value)=>sum+value*value,0)/wave.samples.length);
  if(loudness<0.002)return '';
  const asr=new addon.OfflineRecognizer({featConfig:{sampleRate:16000,featureDim:80},
    modelConfig:{senseVoice:{model:'model.int8.onnx',language:'auto',useInverseTextNormalization:1},
      tokens:'tokens.txt',numThreads:2,provider:'cpu'}});
  const stream=asr.createStream();
  stream.acceptWaveform({sampleRate:wave.sampleRate,samples:wave.samples});
  asr.decode(stream);
  return asr.getResult(stream).text||'';
}

if(require.main===module)process.stdout.write(JSON.stringify(recognize(process.argv[2])));
module.exports={model,ready,transcribe};
