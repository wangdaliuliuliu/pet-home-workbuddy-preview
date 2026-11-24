(() => {
  const get = id => document.getElementById(id);
  const mode = get('companion-mode'), notice = get('companion-status'), dialog = get('companion-settings');
  const panel = get('companion-voice-panel'), source = get('companion-voice-source'), preset = get('companion-voice-preset');
  const key = get('companion-voice-key'), audio = get('companion-preview-audio'), save = get('companion-save');
  const removeKey=document.createElement('input');
  removeKey.type='checkbox';
  const removeLabel=document.createElement('label');
  removeLabel.append(removeKey,'保存时移除自己的 Key');
  const keyLabel=get('companion-key-label');
  const spare=document.createElement('details');
  const spareTitle=document.createElement('summary');spareTitle.textContent='备用百炼 Key（选填）';
  keyLabel.before(spare);spare.append(spareTitle,keyLabel,removeLabel);
  spare.hidden=true;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'pet-signout';
  open.textContent = '陪伴语言';
  const nav=document.querySelector('.pet-account-nav');
  if(nav)fetch('/api/capabilities').then(r=>r.json()).then(caps=>{if(caps.voiceSettings)nav.prepend(open);}).catch(()=>{});
  const selectedSource=()=>source.value;
  const connect=document.createElement('button');connect.type='button';connect.className='outline-button';connect.textContent='查看账号同步';
  get('companion-platform-balance').after(connect);
  connect.onclick=()=>{dialog.close();window.petOnlineHomeUI?.open();};
  let cloudVoiceId,localVoiceId;
  let currentMode, voices, currentVoice, resume;
  get('companion-close').onclick = () => dialog.close();
  dialog.addEventListener('close',()=>{audio.pause();audio.hidden=true;key.value='';removeKey.checked=false;resume=null;});

  async function request(route, body) {
    const response = await fetch(route, {...(body === undefined ? {} : {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
    }),signal:AbortSignal.timeout?.(body===undefined?6500:18000)});
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw Object.assign(Error(error.error || '刚才没完成，请再试一次。'),{status:response.status});
    }
    return response.json();
  }

  function renderPresets() {
    const local = source.value==='local';
    const available = local ? voices.localVoices : voices.cloudVoices;
    if(local) preset.replaceChildren(new Option('选择免费声音',''),...available.map(item=>new Option(item.name,item.id)));
    else preset.replaceChildren(new Option(cloudVoiceId&&!available.some(item=>item.id===cloudVoiceId)?'沿用已保存的音色':'选择音色',''),...[['美式英语女声','female','en-US'],['美式英语男声','male','en-US'],['中文女声','female','zh-CN'],['中文男声','male','zh-CN']].filter(([,gender,language])=>available.some(item=>item.gender===gender&&item.language===language)).map(([label,gender,language])=>{
      const group=document.createElement('optgroup');group.label=label;
      group.append(...available.filter(item=>item.gender===gender&&item.language===language).map(item=>new Option(item.name,item.id)));
      return group;
    }));
    const previous=local?localVoiceId:cloudVoiceId;
    if(available.some(item=>item.id===previous))preset.value=previous;
    get('companion-voice-preview').disabled=!preset.value;
    get('companion-voice-detail').textContent=local?(available.length?'电脑免费朗读。':'免费声音还没通过试读，请大人重新运行安装。'):'试听播放固定样音，不扣额度。';
    renderAccount();
    if(!local&&voices.bilingualCompatibility)get('companion-voice-detail').append(' 美式音色遇到中文时暂由同类中文音色朗读。');
    audio.pause();audio.hidden=true;
  }

  function renderAccount(){
    const account=selectedSource();
    spare.hidden=account!=='platform';
    keyLabel.hidden=account==='local';
    if(account==='custom')spare.hidden=false;
    spareTitle.textContent=account==='custom'?'填写百炼 Key':'备用百炼 Key（选填）';
    if(account==='custom')spare.open=true;
    connect.hidden=!(voices.localAllowed&&account==='platform'&&!voices.platformAvailable&&window.petOnlineHomeUI);
    removeLabel.hidden=!voices.customConfigured||account==='custom';
    key.placeholder=voices.customConfigured?'留空沿用已验证的 Key':account==='platform'?'仅在平台额度用完后使用':'保存时会实际验证';
    const balance=voices.platform;
    get('companion-platform-balance').textContent=account==='platform'
      ? balance.plan==='unlimited'?'当前账号的语音额度不限量。':balance.plan==='daily'?`今天还剩 ${(balance.points/100).toFixed(4)} 元语音额度，本机和网页共享。用完后自动使用已保存的备用 Key。`:'音色可以先保存。账号同步后会自动使用平台额度。'
      : account==='custom'?'这项由你自己的百炼账号提供。保存新 Key 时会合成一句话验证。':'';
  }

  source.onchange=()=>{key.value='';renderPresets();};
  preset.onchange=()=>{if(source.value==='local')localVoiceId=preset.value;else cloudVoiceId=preset.value;get('companion-voice-preview').disabled=!preset.value;audio.pause();audio.hidden=true;};
  get('companion-voice-preview').onclick=()=>{
    const item=(source.value==='local'?voices.localVoices:voices.cloudVoices).find(candidate=>candidate.id===preset.value);
    if(!item)return;
    audio.src=item.preview;audio.hidden=false;
    audio.play().catch(()=>{notice.textContent='点一下播放器，就能试听。';});
  };

  async function show(reason='',retry) {
    resume=retry;
    spare.open=false;
    if(!dialog.open)dialog.showModal();
    save.disabled=true;
    panel.hidden=true;
    notice.textContent=reason||'正在读取陪伴设置…';
    try {
      const settings=await request('/api/companion');
      currentMode=settings.mode;mode.value=currentMode;
      try { voices=await request('/api/companion/voice'); }
      catch(error){ if(error.status!==404)throw error; voices=null; }
      if(voices){
        currentVoice=voices.selected;
        const cloud=voices.localAllowed&&!voices.sharedPlatform?'custom':'platform';
        source.replaceChildren(new Option('云端声音',cloud));
        if(voices.localAllowed)source.prepend(new Option('免费声音','local'));
        source.value=currentVoice.source==='local'?'local':cloud;
        cloudVoiceId=currentVoice.source==='local'?null:currentVoice.id;
        localVoiceId=currentVoice.source==='local'?currentVoice.id:null;
        renderPresets();panel.hidden=false;
      }
      notice.textContent=reason||(!voices&&settings.voiceBalance!==null?'语音额度剩余 '+settings.voiceBalance:'');
      save.disabled=false;
    } catch(error) { notice.textContent=error.message; }
  }

  open.onclick=()=>show();
  window.petCompanionUI={open:()=>show(),async checkVoice(retry){
    const settings=await request('/api/companion/voice').catch(()=>null);
    if(!settings?.selected.needsSelection)return true;
    show('先在陪伴语言里选一个声音。',retry);return false;
  },openForVoice(error,retry){
    if(!['voice_setup','voice_points'].includes(error.code))return false;
    if(!dialog.open)show(error.message,retry);
    return true;
  }};
  save.onclick=async()=>{
    save.disabled=true;
    notice.textContent='正在保存…';
    try {
      const account=selectedSource();
      const id=preset.value||(account===currentVoice?.source?currentVoice.id:null);
      const initialId=currentVoice?.id;
      if(voices&&(currentVoice.needsSelection||account!==currentVoice.source||id&&id!==initialId||account!=='local'&&key.value||removeKey.checked)){
        currentVoice=await request('/api/companion/voice',{source:account,id,apiKey:key.value,removeKey:removeKey.checked});
        if(removeKey.checked)voices.customConfigured=false;
        else if(key.value.trim())voices.customConfigured=true;
        renderAccount();
      }
      key.value='';removeKey.checked=false;
      if(currentMode!==mode.value){
        const settings=await request('/api/companion/settings',{mode:mode.value});
        currentMode=settings.mode;
        window.dispatchEvent(new CustomEvent('pet-companion-language',{detail:settings.mode}));
      }
      notice.textContent='陪伴设置已保存。';
      const retry=resume;
      if(retry){resume=null;dialog.close();retry();}
    } catch(error){notice.textContent=error.message;}
    finally {save.disabled=false;}
  };
})();
