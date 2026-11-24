(() => {
  const $ = id => document.getElementById(id);
  const t = value => (window.petText ? window.petText(value) : value);
  let data = null, myName = '', lastCredit = null, hintUntil = 0, selected = null;
  const hintText = () => t('故事收好啦，去约朋友串门 →');

  const dialog = document.createElement('dialog');
  dialog.className = 'game-dialog visit-dialog';
  dialog.innerHTML = `<header class="dialog-top"><span class="tiny-label">去串门</span><button type="button" class="close-button" aria-label="关闭串门">×</button></header>
    <div class="visit-panel" id="visit-panel">
      <h2 id="visit-title">明天去谁家玩？</h2>
      <p class="visit-quota" id="visit-quota"></p>
      <div class="visit-targets" id="visit-targets" role="radiogroup" aria-label="选一个朋友"></div>
      <p class="small-note" id="visit-hint"></p>
      <button type="button" class="visit-go" id="visit-go" disabled>选一个朋友</button>
    </div>
    <div class="visit-done" id="visit-done" hidden>
      <div class="visit-done-art"><img alt=""><span aria-hidden="true">🚪</span></div>
      <h2 id="visit-done-title">约好啦！</h2>
      <p class="visit-done-copy" id="visit-done-copy"></p>
      <button type="button" class="visit-go" id="visit-done-ok">好期待呀</button>
    </div>
    <div id="visit-preparation" hidden>
      <p class="small-note" role="status" id="visit-preparation-status"></p>
      <button type="button" class="secondary-button" id="visit-preparation-retry" hidden>继续准备</button>
    </div>`;
  document.body.append(dialog);
  dialog.querySelector('.close-button').onclick = () => dialog.close();
  $('visit-done-ok').onclick = () => dialog.close();

  const go = $('visit-go');
  const preparation=$('visit-preparation'),progressText=$('visit-preparation-status'),retryPreparation=$('visit-preparation-retry');
  let progressTimer,progressTurn=0,retryInFlight=false;
  function followPreparation(){
    clearTimeout(progressTimer);
    const turn=++progressTurn;
    async function poll(){
      try{
        const res=await fetch('/api/local-home/visit-progress',{signal:AbortSignal.timeout?.(4500)});
        if(!res.ok)return;
        const {progress}=await res.json();
        if(!dialog.open||turn!==progressTurn)return;
        preparation.hidden=!progress;
        if(!progress)return;
        const visit=progress.otherPet?'和'+progress.otherPet+'的串门':'最近一次串门';
        const day=progress.storyDate?progress.storyDate.replace(/^\d{4}-/,'').replace('-',' 月 ')+' 日':'';
        progressText.textContent=progress.failed?`${visit}还没准备好。${progress.stage?'停在「'+progress.stage+'」。':''}`:
          progress.ready?`${visit}已准备好。${progress.deliveryPending?(day?day+'在故事本查看。':'投递后可以在故事本查看。'):'到故事本查看。'}`:
          progress.stage==='等到约好的那天'?`${visit}已约好，${day||'约好的那天'}再准备故事。`:`${visit}正在${progress.stage||'准备'}。`;
        retryPreparation.hidden=!progress.failed;
        retryPreparation.onclick=async()=>{
          if(retryInFlight)return;
          retryInFlight=true;retryPreparation.disabled=true;
          try{
            const result=await fetch('/api/local-home/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:progress.id})});
            if(!result.ok)throw Error((await result.json()).error);
            progressText.textContent='正在继续准备串门故事。';
          }catch(error){progressText.textContent=error.message||'暂时没能继续，待会儿再试。';}
          finally{retryInFlight=false;retryPreparation.disabled=false;}
        };
        if(!progress.ready||progress.failed)progressTimer=setTimeout(poll,2500);
      }catch{}
    }
    poll();
  }
  dialog.addEventListener('close',()=>{++progressTurn;clearTimeout(progressTimer);});

  function selectTarget(card, target, cards) {
    selected = target;
    for (const item of cards) {
      const on = item === card;
      item.classList.toggle('selected', on);
      item.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    go.disabled = false;
    go.textContent = `明天去${target.petName}家玩`;
  }

  function openPanel() {
    if (!data) return;
    if(data.visitUnavailable){
      $('visit-done').hidden=true;$('visit-panel').hidden=false;
      $('visit-quota').textContent='';$('visit-title').textContent='串门';
      $('visit-hint').textContent=data.visitUnavailable;$('visit-targets').replaceChildren();
      go.disabled=false;go.textContent='知道啦';
      if(!dialog.open)dialog.showModal();
      return;
    }
    $('visit-done').hidden = true;
    $('visit-panel').hidden = false;
    selected = null;
    const credit = data.credit || 0;
    const canVisit = !!data.canVisit;
    const storyToday = !!data.storyToday;
    // 三种状态：能约、今天还没读完书（没有体力）、今天已经用掉了。
    const quota = $('visit-quota');
    quota.textContent = canVisit
      ? `今天还能串门 ${credit} 次`
      : !storyToday ? '今天还不能去串门'
        : '今天的串门机会已经用掉啦';
    quota.classList.toggle('empty', !canVisit);
    $('visit-title').textContent = canVisit
      ? '明天去谁家玩？'
      : !storyToday ? '先读完一本书吧'
        : '明天再一起去玩吧';
    $('visit-hint').textContent = canVisit
      ? ''
      : !storyToday ? '读完一本书并保存故事，串门机会就到账啦。'
        : '今天的串门机会用掉了，明天再来吧。';
    go.disabled = canVisit;
    go.textContent = canVisit ? '选一个朋友' : storyToday ? '知道啦' : '先去读一本书';

    const list = $('visit-targets');
    list.replaceChildren();
    if (!data.targets?.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-home';
      empty.textContent = '现在还没有别的小伙伴。等另一只小宠物也住进来，就能互相串门啦。';
      list.append(empty);
    }
    const cards = [];
    for (const target of data.targets || []) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'visit-target';
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', 'false');
      card.disabled = !canVisit;

      const face = document.createElement('span');
      face.className = 'visit-face';
      const img = document.createElement('img');
      img.src = target.avatar;
      img.alt = '';
      img.width = 44;
      img.height = 44;
      img.loading = 'lazy';
      img.decoding = 'async';
      face.append(img);

      const who = document.createElement('span');
      who.className = 'visit-who';
      const name = document.createElement('strong');
      name.textContent = target.petName;
      who.append(name);
      if(target.childName){
        const note=document.createElement('small');
        note.textContent=`${target.childName}家的`;
        who.append(note);
      }

      const check = document.createElement('span');
      check.className = 'visit-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';

      card.append(face, who, check);
      card.onclick = () => selectTarget(card, target, cards);
      list.append(card);
      cards.push(card);
    }
    if (!dialog.open) dialog.showModal();
    followPreparation();
  }

  go.onclick = async () => {
    if(data?.visitUnavailable){dialog.close();return;}
    if (!data?.canVisit) {
      dialog.close();
      if (!data?.storyToday) $('open-story')?.click();
      return;
    }
    if (!selected) return;
    const target = selected;
    go.disabled = true;
    go.textContent = '出门啦…';
    try {
      const response = await fetch('/api/visit/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }) });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || '这次没出门成功，再试一次吧。');
      data = { ...result };
      delete data.sent;
      call.classList.remove('has-credit');
      call.classList.add('spent');
      showDone(target);
      followPreparation();
      await window.refreshPet?.();
    } catch (error) {
      // 服务端说不能出门时，用最新状态重画面板，免得旧状态让人反复点。
      try {
        const latest = await fetch('/api/visit');
        if (latest.ok) update({ visit: await latest.json(), name: myName });
      } catch {}
      openPanel();
      $('visit-hint').textContent = error.message || '这次没出门成功。';
    }
  };

  function showDone(target) {
    const done = $('visit-done');
    const face = done.querySelector('img');
    face.src = target.avatar;
    face.alt = `${target.petName}的照片`;
    $('visit-panel').hidden = true;
    done.hidden = false;
    const me = myName || '它';
    $('visit-done-copy').textContent = `${me}已经和${target.petName}约好啦。明天它们会一起玩，明天早上，这篇故事会出现在故事本里。`;
  }

  const call = document.createElement('button');
  call.type = 'button';
  call.id = 'visit-call';
  call.className = 'secondary-button visit-call';
  call.hidden = true;
  call.setAttribute('aria-label', '去朋友家串门');
  call.innerHTML = '🚪 串门<span class="visit-plus" aria-hidden="true">+1</span>';
  function openAndRefresh() {
    const before = data?.targets?.map(item => item.id).join(',');
    const waiting = Boolean(data?.visitUnavailable);
    openPanel();
    refresh().then(() => {
      const after = data?.targets?.map(item => item.id).join(',');
      if (dialog.open && !$('visit-panel').hidden && !selected && !data?.visitUnavailable && (waiting || before !== after)) openPanel();
    });
  }
  call.onclick = openAndRefresh;
  const tools = document.querySelector('.home-tools');
  if (tools) tools.insertBefore(call, tools.querySelector('.home-clock') || null);
  else document.querySelector('.pet-presence')?.append(call);

  $('speech')?.addEventListener('click', () => { if (!call.hidden) openAndRefresh(); });


  function update(state) {
    let visit = state?.visit;
    if (!visit) return;
    if(data?.remoteVisit&&!visit.remoteVisit)visit={...data,storyToday:visit.storyToday};
    data = visit;
    if (state.name) myName = state.name;
    const credit = visit.credit || 0;
    const canVisit = !!visit.canVisit;
    // 用完了也要留着入口：孩子今天玩过，明天才知道还能再来。
    call.hidden = !visit.enabled || !visit.remoteVisit&&!(visit.targets || []).length;
    call.classList.toggle('has-credit', canVisit);
    call.classList.toggle('spent', !canVisit);
    if (lastCredit !== null && canVisit && credit > lastCredit) hintUntil = Date.now() + 8000;
    lastCredit = credit;
    const speech = $('speech');
    if (speech && canVisit && Date.now() < hintUntil) {
      speech.textContent = hintText();
      speech.classList.add('visit-hint');
    } else if (speech) {
      speech.classList.remove('visit-hint');
    }
  }
  async function refresh(){
    try{const response=await fetch('/api/visit',{signal:AbortSignal.timeout?.(6500)});if(response.ok)update({visit:await response.json(),name:myName});}catch{}
  }
  window.visitUI = { update, open: openAndRefresh, refresh };
  if (window.pet) update(window.pet);
  refresh();
})();
