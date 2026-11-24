'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const MODEL='ACE-Step-v1.5-XL-Turbo',BASE='https://nano-gpt.com';
function fail(message,code='NANO_MUSIC_ERROR'){return Object.assign(new Error(message),{code,status:502})}
function createNanoMusic({env=process.env,fetchImpl=globalThis.fetch,keyLoader,pollMs=2500,timeoutMs=180000}={}){
 const secret=path.join(os.homedir(),'.codex','private','nanogpt-song-key.dpapi');
 function configured(){return Boolean(env.NANOGPT_API_KEY||keyLoader||(env.PET_PORTABLE!=='1'&&process.platform==='win32'&&fs.existsSync(secret)))}
 function key(){if(keyLoader)return keyLoader();if(env.NANOGPT_API_KEY)return env.NANOGPT_API_KEY;if(env.PET_PORTABLE==='1')throw fail('请先填写自己的歌曲密钥。','MUSIC_NOT_CONFIGURED');if(!configured())throw fail('歌曲服务还未配置。','MUSIC_NOT_CONFIGURED');try{return execFileSync(env.NANOGPT_POWERSHELL||'pwsh.exe',['-NoProfile','-NonInteractive','-Command',"$p=Join-Path $env:USERPROFILE '.codex/private/nanogpt-song-key.dpapi'; [System.Net.NetworkCredential]::new('',(Get-Content -LiteralPath $p|ConvertTo-SecureString)).Password"],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']}).trim()}catch{throw fail('本机歌曲凭据无法读取。','MUSIC_KEY_UNAVAILABLE')}}
 async function generateMusic({lyrics,prompt,duration=30,voiceDescription='',signal,runId,onSubmitted=()=>{},onCompleted=()=>{}}={}){
 if(typeof lyrics!=='string'||!lyrics.trim()||lyrics.length>3500)throw fail('先准备完整歌词。','LYRICS_REQUIRED');if(![30,60].includes(Number(duration)))throw fail('歌曲时长请选择30秒或60秒。','INVALID_DURATION');
 const auth=key();const headers={Authorization:'Bearer '+auth,'Content-Type':'application/json'};
 async function json(url,options={}){try{const r=await fetchImpl(url,{...options,headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});if(!r.ok)throw Error();return await r.json()}catch{throw fail('歌曲服务暂未返回结果，已保留任务状态。')}}
 if(!runId){const job=await json(BASE+'/api/v1/audio/speech',{method:'POST',body:JSON.stringify({model:MODEL,input:[prompt||'Playful Mandarin song, clear solo vocals, short intro, complete ending.',voiceDescription?'Vocal direction: '+voiceDescription:''].filter(Boolean).join('\n'),lyrics,duration:Number(duration),response_format:'mp3'})});if(typeof job.runId!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(job.runId))throw fail('歌曲任务号未确认，请老师核对账单后处理。','MUSIC_SUBMISSION_UNCONFIRMED');runId=job.runId;await onSubmitted({runId,model:MODEL,duration:Number(duration),estimatedCost:job.cost??null});}
 if(!/^[a-zA-Z0-9-]{8,100}$/.test(runId))throw fail('歌曲任务号无效。');
 const until=Date.now()+timeoutMs;while(Date.now()<until){if(signal?.aborted)throw fail('歌曲步骤已超时，保留原任务号。','WORK_NODE_TIMEOUT');const status=await json(BASE+'/api/tts/status?'+new URLSearchParams({runId,model:MODEL}));if(status.status==='completed'){
 let url;try{url=new URL(status.audioUrl)}catch{throw fail('歌曲下载地址缺失。')};if(url.protocol!=='https:'||url.hostname!=='am.runware.ai'||url.username||url.password)throw fail('歌曲下载地址未获支持，请保留任务号。','MUSIC_AUDIO_HOST');
 let audio;
 const downloadFailures=[];
 for(let attempt=1;attempt<=2;attempt++){
  let transient=false, httpStatus, contentType, bytes, phase='fetch';
  try{
   const timeout=AbortSignal.timeout(60000);
   const response=await fetchImpl(url.href,{redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
   httpStatus=response.status;contentType=(response.headers.get('content-type')||'').split(';')[0];phase='headers';
   transient=[408,429,500,502,503,504].includes(response.status);
   if(!response.ok||!/audio|octet-stream/.test(response.headers.get('content-type')||''))throw new Error('Invalid audio response');
   phase='body';audio=Buffer.from(await response.arrayBuffer());bytes=audio.length;phase='validate_mp3';
   if(audio.length<100||audio.length>20*1024*1024||!(audio.subarray(0,3).toString()==='ID3'||(audio[0]===255&&(audio[1]&224)===224)))throw new Error('Invalid MP3');
   break;
  }catch(error){
   const cause=error.cause?.code;
   transient ||= /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|BODY_TIMEOUT))$/.test(cause||'')||error.name==='TimeoutError';
   const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_./-]{1,80}$/.test(value)?value:undefined;
   downloadFailures.push({attempt,phase,httpStatus,contentType:safe(contentType),bytes,causeType:safe(error.name),networkCode:safe(cause)});
   if(attempt===2||!transient||signal?.aborted)throw Object.assign(fail('歌曲音频没有完整取回，可继续获取原任务。','MUSIC_DOWNLOAD_FAILED'),{downloadAttempt:attempt,networkCode:safe(cause),diagnostic:{stage:'music_download',code:'MUSIC_DOWNLOAD_FAILED',attempts:downloadFailures}});
  }
  await new Promise(resolve=>setTimeout(resolve,350));
 }
 const meta={runId,model:MODEL,cost:status.cost??null,billingReconciled:status.billingReconciled===true,duration:Number(duration)};await onCompleted(meta);return {audioBuffer:audio,mimeType:'audio/mpeg',...meta,generated:true};}
 if(status.terminal||['failed','error','cancelled'].includes(status.status))throw fail('这首歌未生成成功，没有自动重新付费。','MUSIC_TASK_FAILED');await new Promise(r=>setTimeout(r,pollMs));}
 throw fail('歌曲仍在准备，可继续获取原任务，不会重新下单。','MUSIC_PENDING');
 }
 return {configured,generateMusic,capabilities:()=>({musicEnabled:configured(),provider:'nanogpt',model:MODEL,notice:configured()?'NanoGPT ACE-Step 歌曲已配置；音色由文字描述引导，不保证固定声纹。':'NanoGPT 歌曲待配置。'})};
}
module.exports={createNanoMusic};
