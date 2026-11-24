(() => {
  'use strict';
  const nav=document.createElement('nav');
  nav.className='pet-account-nav';nav.setAttribute('aria-label','账号与设置');
  nav.innerHTML='<button type="button" class="pet-signout" aria-label="退出当前账号">退出</button><span class="pet-signout-error" role="status" hidden></span>';
  (document.querySelector('.hud')||document.body).append(nav);
  const style=document.createElement('style');
  style.textContent='.pet-account-nav{display:flex;align-items:center;gap:12px;margin-left:auto;padding:9px 14px;border:1px solid #e2d6db;background:#fffaf5e8;border-radius:17px;font:13px Microsoft YaHei,sans-serif;color:#806c7b;box-shadow:0 2px 6px #754f6410;align-self:center;position:relative}.pet-account-nav a{color:inherit;text-decoration:none;white-space:nowrap}.pet-account-nav a:first-child{font-weight:bold}.pet-signout{appearance:none;border:0;border-left:1px solid #d9cbd2;border-radius:0;background:transparent;padding:2px 0 2px 10px;color:#96838d;font:inherit;cursor:pointer;min-height:28px;white-space:nowrap}.pet-signout:hover{color:#765468}.pet-signout:focus-visible{outline:2px solid #a57895;outline-offset:4px;border-radius:4px}.pet-signout:disabled{opacity:.6}.pet-signout-error{position:absolute;top:100%;right:0;padding:8px 12px;background:#fffaf2;border-radius:10px;min-width:180px;font-size:12px}@media(max-width:700px){.pet-account-nav{font-size:12px;gap:9px;padding:6px 10px;margin:8px 0 0 auto;z-index:3}.hud{flex-wrap:wrap}.pet-signout{min-height:32px}}';
  document.head.append(style);
  const signout=nav.querySelector('.pet-signout'),error=nav.querySelector('.pet-signout-error');
  signout.onclick=async()=>{
    signout.disabled=true;error.hidden=true;
    try {
      const response=await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw Error('logout failed');
      document.querySelectorAll('audio,video').forEach(media=>media.pause());
      location.replace('/account.html?next=%2Findex.html');
    } catch {error.textContent='还没退出成功，点“退出”再试一下。';error.hidden=false;signout.disabled=false;}
  };
  const token=/\{\{(petName|childName|childNickname)\}\}/g;
  const templates=new Map(),attributes=new WeakMap();let current;
  // Original stories, chat messages, captions and work results are content, not UI templates.
  const content='script,style,#stories,.stories,.chat-bubble,.trip-story,.travel-prose,.travel-reading,.travel-place,figcaption,.wt-result,.photo-viewer>p,.photo-reference,[data-identity-content],.player-plaque';
  function excluded(element){return !element||(!element.closest('[data-identity-ui]')&&!!element.closest(content));}
  function collect(){
    for(const node of templates.keys())if(!node.isConnected)templates.delete(node);
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
    while(node=walker.nextNode())if(!excluded(node.parentElement)&&!node.parentElement.closest('textarea,input')&&!templates.has(node)&&/\{\{(?:petName|childName|childNickname)\}\}/.test(node.nodeValue))templates.set(node,node.nodeValue);
  }
  function format(template){
    return template.replace(token,(_,key)=>key==='petName'?current.name:key==='childName'?current.owner:current.ownerNickname||current.owner);
  }
  window.petText=template=>current?format(template):template.replace(token,(_,key)=>key==='petName'?'宠物':'小朋友');
  window.applyPetIdentity=state=>{
    current={name:state.name||'宠物',owner:state.owner||'小朋友',ownerNickname:state.ownerNickname};collect();
    for(const [node,template]of templates){const value=format(template);if(node.nodeValue!==value)node.nodeValue=value;}
    for(const element of document.querySelectorAll('[aria-label],[alt],[title],[placeholder]')){
      if(excluded(element))continue;
      let saved=attributes.get(element);if(!saved){saved={};attributes.set(element,saved);}
      for(const attr of ['aria-label','alt','title','placeholder']){
        const value=element.getAttribute(attr);
        if(value&&/\{\{(?:petName|childName|childNickname)\}\}/.test(value))saved[attr]=value;
        if(saved[attr]!==undefined&&value!==format(saved[attr]))element.setAttribute(attr,format(saved[attr]));
      }
    }
    const title=current.name+'的童话小屋';if(document.title!==title)document.title=title;
    const header=document.querySelector('.player-plaque');
    if(header){
      header.setAttribute('aria-label','查看'+current.owner+'与'+current.name);
      const small=header.querySelector('small'),name=header.querySelector('strong').firstChild;
      if(small.textContent!==current.owner+'的小伙伴')small.textContent=current.owner+'的小伙伴';
      if(name.nodeValue!==current.name+' ')name.nodeValue=current.name+' ';
    }
  };
  new MutationObserver(()=>{if(current)window.applyPetIdentity(current)}).observe(document.body,{childList:true,subtree:true,characterData:true});
  const originalFetch=window.fetch;
  window.fetch=async(...args)=>{const response=await originalFetch(...args);if(response.status===401&&String(args[0]).startsWith('/api/'))location.href='/account.html?next=/';return response;};
})();
