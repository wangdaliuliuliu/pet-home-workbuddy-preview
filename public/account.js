(()=>{'use strict';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let mode='login',user;
async function api(url,data,method='POST'){const r=await fetch(url,data?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:undefined);const d=await r.json();if(!r.ok)throw Error(d.error||'这次没连上，再试一次吧。');return d;}
const requested=new URLSearchParams(location.search).get('next'),next=['/','/office','/office.html','/job-studio.html','/studio','/index.html','/create-pet','/create-pet.html'].includes(requested)?requested:'/';
function tab(value){mode=value;$('auth-form').elements.password.minLength=mode==='register'?8:1;$('login-tab').classList.toggle('selected',mode==='login');$('register-tab').classList.toggle('selected',mode==='register');$('name-hint').textContent=mode==='register'?'想一个好记的名字，也可以用小名。':'填你第一次来时用的名字。';$('auth-form').elements.name.maxLength=mode==='register'?16:32;$('auth-form').elements.password.autocomplete=mode==='register'?'new-password':'current-password';$('form-title').textContent=mode==='register'?'你叫什么名字？':'欢迎回来！';$('auth-submit').textContent=mode==='register'?'去创造我的宠物 →':'回到我的宠物身边 →';$('auth-error').textContent='';}
$('login-tab').onclick=()=>tab('login');$('register-tab').onclick=()=>tab('register');
$('auth-form').onsubmit=async e=>{e.preventDefault();$('auth-submit').disabled=true;try{const data=Object.fromEntries(new FormData(e.target));if(mode==='register')data.createPet=true;const result=await api('/api/auth/'+mode,data);location.href=result.user.needsPetSetup?'/create-pet':next;}catch(e){$('auth-error').textContent=e.message;$('auth-submit').disabled=false;}};
function profile(){document.title='我的名字';$('account-content').innerHTML=`<h2>我的名字</h2><p class="account-status">${esc(user.petName)}在等你</p><form id="profile-form"><label class="form-field">你的名字<input name="name" value="${esc(user.login)}" required maxlength="32" autocomplete="username"></label><p class="form-hint">改名后，下次用新名字登录。</p><label class="form-field">宠物的名字<input name="petName" value="${esc(user.petName)}" required maxlength="30"></label><details><summary>改密码</summary><label class="form-field">原来的密码<input name="currentPassword" type="password" autocomplete="current-password" maxlength="128"></label><label class="form-field">新密码<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128"></label></details><p id="profile-message" class="form-error" role="status"></p><button class="ink-button" id="save-profile">保存 ✓</button></form>${!user.legacy?'<details><summary>找回我原来的宠物</summary><p class="form-hint">请大人帮你填领取码。</p><form id="claim-form"><label class="form-field">领取码<input name="code" required autocomplete="off" maxlength="100"></label><button class="outline-button">接回原来的宠物</button><p id="claim-error" class="form-error" role="alert"></p></form></details>':''}<div class="desk-actions"><a class="text-link" href="/">回宠物的小家 →</a><button id="logout" class="outline-button">退出登录</button></div>`;
$('profile-form').onsubmit=async e=>{e.preventDefault();$('save-profile').disabled=true;try{const d=await api('/api/account',Object.fromEntries(new FormData(e.target)),'PATCH');user=d.user;profile();$('profile-message').textContent='保存好啦！';}catch(e){$('profile-message').textContent=e.message;$('save-profile').disabled=false;}};
$('logout').onclick=async()=>{try{await api('/api/auth/logout',{});location.reload();}catch(e){$('profile-message').textContent=e.message;}};
if($('claim-form'))$('claim-form').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/account/claim',Object.fromEntries(new FormData(e.target)));user=d.user;profile();}catch(e){$('claim-error').textContent=e.message;}};
}
const setup=new URLSearchParams(location.search).get('localSetup');
tab('login');
if(location.hostname==='127.0.0.1'&&['register','workbuddy'].includes(setup)){
  tab('register');
  const note=document.createElement('p');note.className='form-hint';note.setAttribute('role','status');note.hidden=true;
  $('account-content').prepend(note);
  const deadline=Date.now()+30000;
  async function showWorkBuddyCheck(){
    const result=await fetch('/api/local-launch',{signal:AbortSignal.timeout?.(1600)}).then(r=>r.json()).catch(()=>null);
    if(result?.agent==='workbuddy-desktop'&&note.isConnected){
      note.hidden=false;
      note.textContent='你可以先注册。使用陪聊和出图前，请保存正在做的事，退出 WorkBuddy，再双击桌面的「宠物小家 WorkBuddy 试用版」。';
      return;
    }
    if(result?.agent!=='workbuddy'||!note.isConnected)return;
    const state=result.workbuddy?.state;
    const messages={checking:'正在检查小家能不能使用 WorkBuddy。你可以先注册。',ready:'WorkBuddy 文字服务已通过检查。',authorization_required:'小家已经打开。WorkBuddy 还没授权，陪聊、写故事和画图暂不可用。',unavailable:'小家已经打开。暂时无法确认 WorkBuddy 的生成能力。'};
    note.hidden=false;note.textContent=messages[state]||messages.unavailable;
    if(['unchecked','checking'].includes(state)&&Date.now()<deadline)setTimeout(showWorkBuddyCheck,800);
  }
  showWorkBuddyCheck();
}
api('/api/auth/me').then(d=>{user=d.user;if(user)profile();}).catch(e=>{$('auth-error').textContent=e.message;});})();
