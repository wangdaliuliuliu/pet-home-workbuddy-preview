'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {write} = require('./account-service');
const voice = require('./voice-service');
const offline = require('./local-speech');

const unitsPerFen = 100000;
// 每个账号每天的平台语音额度（单位：分），可用 PET_DAILY_VOICE_FEN 调整。
// 计费口径：平台音色约每字 1000 units，即 1 分≈1000 字。
// 一篇串门故事分 2 段、每段约 900 字，原来 10 分会在一段之内用光，
// 导致第二段必然报「额度不足」——孩子听到的就是「故事没声音」。
const dailyVoiceFen = Number(process.env.PET_DAILY_VOICE_FEN) > 0 ? Number(process.env.PET_DAILY_VOICE_FEN) : 40;
const defaultVoice = 'longpaopao_v3.6';
const sources = ['platform','local','custom'];
const localMode = () => process.env.PET_LOCAL_INSTALL==='1' || process.env.PET_PORTABLE==='1' && process.env.PET_PORTABLE_NETWORK!=='1';
const enabled = () => process.env.PET_VOICE_SETTINGS_V2==='1';
const issue = (code,message,status=409) => Object.assign(new Error(message),{code,status});
function speechFailure(error) {
  if (typeof error.code==='string'&&error.code.startsWith('voice_')) return error;
  const status = error.providerStatus||error.status;
  if (status===401||status===403||error.reason==='provider_balance') return issue('voice_setup',error.message,409);
  if (status===429) return issue('voice_busy',error.message,429);
  return issue('voice_unavailable',error.message,error.status||503);
}
function customFailure(error,afterQuota=false){
  const prefix=afterQuota?'今天的平台语音额度不足。':'';
  const status=error.providerStatus||error.status;
  if(error.reason==='provider_balance')return issue('voice_setup',prefix+'自有百炼账号的额度已用完或余额不足，请大人检查百炼账户。');
  if(status===401||status===403||status===400)return issue('voice_setup',prefix+'自有百炼 Key 无法使用，请检查密钥和模型权限。');
  if(status===429)return issue('voice_busy',prefix+'自有百炼服务正在限流，请稍后重试。',429);
  return issue('voice_unavailable',prefix+'自有百炼服务暂时没连上，请稍后重试。',503);
}
const mediaType = bytes => bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WAVE' ? 'audio/wav' : 'audio/mpeg';
const exactCharacters = text => [...text].reduce((sum,character)=>sum+(/\p{Script=Han}/u.test(character)?2:1),0);

function storyClips(text) {
  const clips=[];
  let remaining=text.trim();
  while (remaining) {
    const limit=clips.length===0?36:64;
    let length=0,weight=0,boundary=0;
    for (const character of remaining) {
      weight+=exactCharacters(character);
      if (weight>limit) break;
      length+=character.length;
      if (/[。！？.!?；;，,\s]/u.test(character)&&weight>=limit/2) boundary=length;
    }
    const end=length<remaining.length&&boundary?boundary:length;
    clips.push(remaining.slice(0,end).trim());
    remaining=remaining.slice(end).trimStart();
  }
  return clips;
}

function platformCost(model, usage, text) {
  if (model === 'qwen-audio-3.1-tts-flash') {
    const {input_tokens,output_tokens} = usage || {};
    if (!Number.isSafeInteger(input_tokens)||!Number.isSafeInteger(output_tokens)||input_tokens<0||output_tokens<0||output_tokens===0) return null;
    return input_tokens*15+output_tokens*120;
  }
  if (model !== 'qwen-audio-3.0-tts-flash') return null;
  const count = Number.isSafeInteger(usage?.characters) && usage.characters>0 ? usage.characters : exactCharacters(text);
  return count*1000;
}

function createCompanionVoice({state,save,dataDir,voicePlan,voiceCatalog,voiceDailyFen,liveQueue,storyQueue,platformRemote,now=Date.now}) {
  const privateFile = path.join(dataDir,'companion-voice-private.json');
  const cache = path.join(dataDir,'companion-audio');
  const active = new Map();
  let validatingKey=false;
  const bilingual = voiceCatalog==='bilingual-v1';
  const isNew = voicePlan==='daily-v3'||bilingual;
  const isMetered = voicePlan==='daily-v3'&&!localMode();
  const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
  let privateSettings={};
  try { privateSettings=JSON.parse(fs.readFileSync(privateFile,'utf8')); } catch {}

  function wallet() {
    if (!isMetered) return null;
    const day=dateFormat.format(now());
    if(state.companionDailyVoice?.day!==day){state.companionDailyVoice={day,units:(voiceDailyFen??dailyVoiceFen)*unitsPerFen,pending:{}};save();}
    return state.companionDailyVoice;
  }

  function selection() {
    if(state.companionVoice){
      if((!localMode()||platformRemote)&&state.companionVoice.source==='custom')return {...state.companionVoice,source:'platform'};
      return state.companionVoice;
    }
    if(isNew){
      if(localMode()&&platformRemote)return {source:'platform',id:voice.BILINGUAL_VOICES.find(item=>item.language==='zh-CN')?.id||voice.BILINGUAL_VOICES[0].id};
      return {source:localMode()?'local':'platform',id:null,needsSelection:true};
    }
    return (localMode() && !state.voiceProfile ? {source:'local',id:offline.voices[0].id} : {source:'platform',id:state.voiceProfile?.voice||(state.petProfile?.voiceDeferred?defaultVoice:null)});
  }

  function platform() {
    if (localMode()) return {plan:'unavailable',points:null};
    return isMetered ? {plan:'daily',points:wallet().units/unitsPerFen} : {plan:'unlimited',points:null};
  }

  async function view() {
    const selected = selection(), installed = localMode()?offline.installation():null;
    const remote=localMode()&&platformRemote?.linked()?await platformRemote.platform().catch(()=>null):null;
    return {selected,platform:remote||platform(),platformAvailable:localMode()?!!remote:voice.capabilities().speechConfigured,
      customConfigured:Boolean(privateSettings.key),localAllowed:localMode(),localAvailable:Boolean(installed),sharedPlatform:Boolean(platformRemote),
      localVoices:installed?offline.voices.filter(item=>installed.voices.some(report=>report.id===item.id&&report.durationMs<=6000)).map(({id,name})=>({id,name,preview:`/api/companion/voice/preview/${id}`})):[],
      bilingualCatalog:bilingual||localMode(),
      bilingualCompatibility:(bilingual||localMode())&&process.env.PET_BILINGUAL_US_VOICES==='0',
      cloudVoices:(bilingual||localMode()?voice.BILINGUAL_VOICES:voice.COMPANION_VOICES.filter(item=>item.language==='en-US')).map(({id,name,gender,language,preview})=>({id,name,gender,language,preview}))};
  }

  function platformProfile(id,bilingualVoice=false) {
    if (!id||state.voiceProfile?.voice===id) return state.voiceProfile;
    const preset=voice.COMPANION_VOICES.find(item=>item.id===id);
    if (!preset) throw issue('voice_setup','请选择一种可用童声。');
    return {voice:id,preset:id,version:`companion-${id}`,gender:preset.gender,description:preset.name,rate:1,...(bilingualVoice?{bilingual:true}:{})};
  }

  async function configure(input,signal) {
    if (!sources.includes(input.source)) throw issue('voice_setup','请选择声音来源。');
    if(platformRemote&&input.source==='custom')input={...input,source:'platform'};
    if (input.source==='local') {
      const installed=localMode()&&offline.installation();
      if (!installed?.voices.some(item=>item.id===input.id&&item.durationMs<=6000)) throw issue('voice_setup','这款本机声音还没通过试读。');
    } else {
      if (!input.id&&(isNew||input.source!=='platform')) throw issue('voice_setup','请先选一种音色。');
      if(bilingual&&!voice.BILINGUAL_VOICES.some(item=>item.id===input.id))throw issue('voice_setup','请选择列表里的双语音色。');
      const profile=platformProfile(input.id);
      if(input.source==='platform'&&localMode()&&!platformRemote)throw issue('voice_setup','这份便携版需要先更新，才能使用平台额度。');
      if(input.source==='platform'&&!localMode()&&!voice.capabilities().speechConfigured)throw issue('voice_setup','平台语音还没连接。');
      const entered=typeof input.apiKey==='string'?input.apiKey.trim():'';
      if(input.removeKey===true&&input.source==='custom')throw issue('voice_setup','请先改用免费声音，再移除 Key。');
      if(entered&&input.removeKey!==true){
        if(entered.length>500||/\s/.test(entered))throw issue('voice_setup','请检查百炼 API Key 的格式。');
        if(validatingKey)throw issue('voice_busy','正在验证 Key，请稍候再保存。',429);
        validatingKey=true;
        const samples=bilingual||localMode()&&voice.BILINGUAL_VOICES.some(item=>item.id===input.id)
          ? [['你好！ Hello!',platformProfile(effectiveId(input.id,'你好！',true),true)]]
          : profile?.voice===defaultVoice?[['你好。',profile]]:[['Hello.',profile],['你好。',platformProfile(defaultVoice)]];
        const deadline=AbortSignal.timeout(14000);
        try{
          for(const [text,selectedProfile] of samples)
            await voice.speak(text,{signal:signal?AbortSignal.any([deadline,signal]):deadline,voiceProfile:selectedProfile,service:customService(entered)});
        }catch(error){throw customFailure(error);}
        finally{validatingKey=false;}
        const next={...privateSettings,key:entered};write(privateFile,next);privateSettings=next;
      }
      if(input.source==='custom'&&!privateSettings.key)throw issue('voice_setup','请填写自己的百炼 API Key。');
    }
    if(input.removeKey===true&&privateSettings.key){
      const next={...privateSettings};delete next.key;write(privateFile,next);privateSettings=next;
    }
    state.companionVoice={source:input.source,id:input.id,...(input.source==='custom'&&localMode()&&voice.BILINGUAL_VOICES.some(item=>item.id===input.id)?{catalog:'bilingual-v1'}:{})};
    save();
    return state.companionVoice;
  }

  function customService(key) {
    return {key,provider:'bailian',model:'qwen-audio-3.0-tts-flash',base:'https://dashscope.aliyuncs.com/api/v1'};
  }

  function usesBilingual(selected){return bilingual||selected.catalog==='bilingual-v1';}

  function effectiveId(id,text,newCatalog){
    if(!/\p{Script=Han}/u.test(text)||!voice.COMPANION_VOICES.some(item=>item.id===id&&item.language==='en-US'))return id;
    if(!newCatalog)return defaultVoice;
    if(process.env.PET_BILINGUAL_US_VOICES!=='0')return id;
    return voice.BILINGUAL_VOICES.find(item=>item.id===id)?.gender==='male'?'longniuniu_v3.1':'longke_v3.1';
  }

  function expressionEnabled(selected){
    return selected.source!=='local'&&usesBilingual(selected)&&process.env.PET_TTS_EXPRESSIVE!=='0';
  }

  function identity(text='') {
    const selected=selection();
    if(selected.source!=='local'&&usesBilingual(selected)){
      const id=effectiveId(selected.id,text,true);
      return JSON.stringify(['bilingual-v1',selected.source,id,expressionEnabled(selected),voice.speechCacheIdentity(platformProfile(id))]);
    }
    if (selected.source==='platform'&&!localMode()) return voice.speechCacheIdentity(platformProfile(selected.id));
    return `${selected.source}:${selected.id||''}:${selected.source==='local'?offline.engineVersion:''}`;
  }

  async function localStoryClip(text,index,signal) {
    const clips=storyClips(text);
    if (!Number.isSafeInteger(index)||index<0||index>=clips.length) throw issue('voice_text','没有找到这段故事。',400);
    return {audio:await speak(clips[index],{purpose:'story',signal}),count:clips.length};
  }

  async function speak(text,{purpose='chat',signal,platformVoice,receiptAudit}={}) {
    if (typeof text!=='string'||!text.trim()||text.length>(purpose==='story'?1200:400)) throw issue('voice_text','这段文字太长了，请分段听。',400);
    if(platformVoice&&!voice.BILINGUAL_VOICES.some(item=>item.id===platformVoice))throw issue('voice_setup','请选择有效的平台音色。');
    const saved=platformVoice?{source:'platform',id:platformVoice,catalog:'bilingual-v1'}:selection();
    const selected={...saved,id:effectiveId(saved.id,text,usesBilingual(saved))};
    let afterPlatformQuota=false;
    let freeWhileSyncing=false;
    if(selected.needsSelection)throw issue('voice_setup','先在陪伴语言里选一个声音。');
    if(selected.source==='platform'&&localMode()){
      if(platformRemote?.linked()){
        try{return await platformRemote.speak(text,{purpose,signal,voice:saved.id});}
        catch(error){
          if(error.code!=='voice_points'||!privateSettings.key)throw error;
          selected.source='custom';
          afterPlatformQuota=true;
        }
      }else{
        const fallback=offline.installation()?.voices.find(item=>item.durationMs<=6000);
        if(!platformRemote||!fallback)throw issue('voice_unavailable','平台语音还在等账号同步，可以先看文字。',503);
        selected.source='local';selected.id=fallback.id;freeWhileSyncing=true;
      }
    }
    const profile=selected.source==='local'?null:platformProfile(selected.id,usesBilingual(saved));
    const variant=selected.source==='platform'?voice.speechCacheIdentity(profile):selected.source==='local'?offline.engineVersion:'';
    const expressive=expressionEnabled(saved);
    const key=crypto.createHash('sha256').update(JSON.stringify(usesBilingual(saved)?[selected,variant,text,'bilingual-v1',expressive]:[selected,variant,text])).digest('hex');
    const file=path.join(cache,key+'.audio');
    if (active.has(key)) return active.get(key);
    let account=selected.source==='platform'?wallet():null;
    const settle=(pending,units)=>{
      if (!pending) return;
      account.units=Math.max(0,account.units+pending.reserve-units);
      delete account.pending[key];save();
    };
    let pending=account?.pending[key];
    if (fs.existsSync(file)) {
      settle(pending,pending?.units ?? pending?.reserve);
      const audio=fs.readFileSync(file);
      if(afterPlatformQuota)audio.usedOwnKey=true;
      if(freeWhileSyncing)audio.usedFreeWhileSyncing=true;
      return audio;
    }
    const job=(async()=>{
      let release;
      try { release=await (purpose==='story'?storyQueue:liveQueue).acquire(signal); }
      catch(error){throw issue(error.status===429?'voice_busy':'voice_unavailable',error.status===429?'声音还在排队，稍后再试。':error.message,error.status||503);}
      try {
        if(account){account=wallet();pending=account.pending[key];}
        let audio;
        if (selected.source==='local') {
          if (!localMode()||!offline.installation()?.voices.some(item=>item.id===selected.id&&item.durationMs<=6000)) throw issue('voice_setup','本机声音还没准备好，请检查声音设置。');
          try { audio=await offline.synthesize(text,selected.id,signal);if(freeWhileSyncing)audio.usedFreeWhileSyncing=true; }
          catch { throw issue('voice_unavailable','本机声音暂时没念出来，文字已经保留。',503); }
        } else if (selected.source==='custom') {
          if (!privateSettings.key) throw issue('voice_setup','请大人连接自选语音 API。');
          audio=await speakWithOwnKey(text,profile,signal,afterPlatformQuota,expressive);
          if(afterPlatformQuota)audio.usedOwnKey=true;
        } else {
          if (!voice.capabilities().speechConfigured) throw issue('voice_setup','平台语音暂不可用，请先看文字，稍后再试。');
          const model=voice.COMPANION_VOICES.find(item=>item.id===(profile?.voice||process.env.PET_TTS_VOICE))?.model||process.env.PET_TTS_MODEL||'qwen-audio-3.0-tts-flash';
          if (pending) {
            if (!pending.url) throw issue('voice_unavailable','这一段声音的生成结果待确认，暂时无法重试。',503);
            audio=await voice.recoverSpeech(pending.url,signal);
          } else {
            let shortOfQuota=false;
            if (account) {
              const reserve=model==='qwen-audio-3.1-tts-flash'
                ? 1000+Math.max((text.match(/[\p{L}\p{N}]+/gu)||[]).length*1000,text.length*170)
                : platformCost(model,null,text);
              if (reserve===null) throw issue('voice_unavailable','平台音色的计费暂不可用。',503);
              shortOfQuota=account.units<reserve;
              if(!shortOfQuota){pending={reserve,at:now()};account.pending[key]=pending;account.units-=reserve;save();}
            }
            if(shortOfQuota){
              if(!privateSettings.key)throw issue('voice_points','今天的平台语音额度不足。北京时间零点刷新，你也可以请家长填写自己的百炼 Key。',429);
              audio=await speakWithOwnKey(text,profile,signal,true,expressive);
              audio.usedOwnKey=true;
            }else audio=await voice.speak(text,{signal,voiceProfile:profile,ignoreRelay:true,expressive,onReceipt:receipt=>{
              receiptAudit?.({model:receipt.model,usage:receipt.usage,units:platformCost(receipt.model,receipt.usage,text)});
              if (!pending) return;
              pending.url=receipt.url;
              pending.units=platformCost(receipt.model,receipt.usage,text);
              save();
            }});
          }
        }
        if (pending && pending.units==null) throw issue('voice_unavailable','这段声音的用量正在核对，请先看文字。',503);
        fs.mkdirSync(cache,{recursive:true});
        fs.writeFileSync(file+'.tmp',audio);fs.renameSync(file+'.tmp',file);
        settle(pending,pending?.units);
        return audio;
      } catch(error) {
        const status=error.providerStatus||error.status;
        if (pending&&!pending.url&&status>=400&&status<499) settle(pending,0);
        throw speechFailure(error);
      } finally { release(); }
    })().finally(()=>active.delete(key));
    active.set(key,job);
    return job;
  }
  async function speakWithOwnKey(text,profile,signal,afterQuota=false,expressive=false){
    try{return await voice.speak(text,{signal,voiceProfile:profile,service:customService(privateSettings.key),expressive});}
    catch(error){throw customFailure(error,afterQuota);}
  }

  function readiness(){
    const selected=selection();
    if(selected.needsSelection)return {notice:'声音还没选好，可以先聊天。'};
    if(localMode()&&selected.source==='platform'&&!platformRemote?.linked()){
      return {notice:offline.installation()?.voices.length?'账号同步前先用免费声音。':'账号正在等同步，可以先看文字。'};
    }
    return {notice:''};
  }

  return {view,configure,speak,identity,platform,localStoryClip,readiness,
    canSpeak(){
      const selected=selection();
      if(selected.needsSelection)return true;
      const source=selected.source;
      if(source==='local')return Boolean(offline.installation());
      if(source==='custom')return Boolean(privateSettings.key);
      return localMode()?!!platformRemote?.linked():voice.capabilities().speechConfigured;
    },
    usesLocal:()=>selection().source==='local'&&!selection().needsSelection};
}

module.exports = {createCompanionVoice,enabled,localMode,mediaType,issue};
