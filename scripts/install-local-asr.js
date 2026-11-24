'use strict';
const fs=require('node:fs');
const path=require('node:path');
const speech=require('../local-speech');
const asr=require('../local-asr');
const {unpack}=require('./install-local-voice');

async function install(){
  if(asr.ready())return;
  if(!fs.existsSync(path.join(speech.root,'node_modules','sherpa-onnx-node')))throw Error('请先准备本机语音引擎。');
  const destination=path.join(speech.root,'asr');
  if(fs.existsSync(destination))fs.renameSync(destination,destination+'.incomplete-'+Date.now());
  console.log('正在从 Sherpa-ONNX 下载中英录音识别模型…');
  await unpack('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'+asr.model+'.tar.bz2',
    '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e',destination);
  if(!asr.ready())throw Error('本机识别模型文件不完整。');
}

if(require.main===module)install().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={install};
