(() => {
  const nav=document.querySelector('.pet-account-nav');
  if(!nav)return;
  async function request(route,body){
    const r=await fetch('/api/local-home'+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
    const data=await r.json();
    if(!r.ok)throw Error(data.error||'线上服务暂时无法连接。');
    return data;
  }
  request('').then(initial=>{
    const button=document.createElement('button');button.type='button';button.className='pet-signout';button.textContent='账号与语音额度';
    const dialog=document.createElement('dialog');dialog.className='game-dialog';
    dialog.innerHTML='<h2>账号与语音额度</h2><p>注册和登录时会自动同步账号。网页和电脑小家共用语音额度。</p><button type="button" data-action="retry">继续准备串门故事</button> <button type="button" data-action="close">关闭</button><p role="status"></p>';
    document.body.append(dialog);nav.append(button);
    const notice=dialog.querySelector('[role=status]'),retry=dialog.querySelector('[data-action=retry]');
    let info=initial,busy=false;
    function refresh(){
      retry.hidden=!info.visitNeedsRetry;
      button.textContent='账号与语音额度';
      if(!busy)notice.textContent=info.linked?'已同步。本机和网页共用额度。':info.identity==='syncing'?'正在同步账号，可以先使用小家。':info.identity==='conflict'?'线上已有同名账号。当前存档已保留，可以先用免费声音。':info.identity==='unreachable'?'线上暂时连不上。可以先用本机免费声音。':'下次正常登录小家时会自动同步。';
    }
    async function act(fn){
      if(busy)return;
      busy=true;
      notice.textContent='正在连接…';
      try{await fn();refresh();}catch(error){notice.textContent=error.message;}finally{busy=false;}
    }
    async function updateStatus(){
      try{
        info=await request('');refresh();
        if(info.visitNeedsRetry)notice.textContent='有一次串门没有准备完整，已经画好的内容会保留。';
        if(dialog.open&&info.identity==='syncing')setTimeout(updateStatus,1000);
      }catch{}
    }
    function show(){refresh();if(!dialog.open)dialog.showModal();updateStatus();}
    button.onclick=()=>show();
    window.petOnlineHomeUI={open:()=>show()};
    dialog.querySelector('[data-action=close]').onclick=()=>dialog.close();
    retry.onclick=()=>act(async()=>{await request('/retry',{});notice.textContent='正在检查有没有待继续的串门故事。';});
    refresh();
  }).catch(()=>{});
})();
