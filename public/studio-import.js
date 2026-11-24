// Carry one explicitly chosen local draft through login, never credentials or a published identity.
(async()=>{'use strict';
const key='pet-pending-work-import';
try{if(location.hash.startsWith('#work-draft=')){const raw=decodeURIComponent(location.hash.slice(12));if(raw.length>20000)throw Error();const job=JSON.parse(raw);if(job.schemaVersion!==3||!job.inputSpec||typeof job.title!=='string')throw Error();delete job.publishedId;sessionStorage.setItem(key,JSON.stringify(job));history.replaceState(null,'',location.pathname+location.search);}}catch{sessionStorage.removeItem(key);history.replaceState(null,'',location.pathname+location.search);}
if(!sessionStorage.getItem(key))return;
if(['/account','/account.html'].includes(location.pathname)){try{const current=(await(await fetch('/api/auth/me')).json()).user;if(current)location.replace('/studio');}catch{}return;}
if(!['/studio','/job-studio.html'].includes(location.pathname))return;
let user;try{const r=await fetch('/api/auth/me');user=(await r.json()).user;}catch{return;}if(!user)return;
const job=JSON.parse(sessionStorage.getItem(key)),panel=document.createElement('section');panel.setAttribute('role','region');panel.setAttribute('aria-label','接收本机工作草稿');panel.style.cssText='padding:22px;margin:15px;border:2px solid #b6c2a5;border-radius:18px;background:#fff9df;color:#425343;font:16px/1.8 Microsoft YaHei';
const title=document.createElement('strong');title.textContent='带过来的工作：'+job.title;const text=document.createElement('p');text.textContent='这是你刚才想的工作吗？收进“'+user.childName+'”的作品里，好吗？';
const accept=document.createElement('button');accept.textContent='收进我的作品';accept.style.cssText='padding:12px 18px;border:0;border-radius:12px;background:#5b775b;color:white;font:700 16px Microsoft YaHei';const cancel=document.createElement('button');cancel.textContent='先不收';cancel.style.cssText='margin-left:14px;padding:10px;border:0;background:none;color:#65735b;font:16px Microsoft YaHei';
panel.append(title,text,accept,cancel);document.querySelector('header').after(panel);
accept.onclick=async()=>{accept.disabled=true;try{const current=(await(await fetch('/api/auth/me')).json()).user;if(current?.id!==user.id)throw Error('账号变了，请重新登录。');const book='pet-job-library-v3-'+user.id,list=JSON.parse(localStorage.getItem(book)||'[]');job.id=crypto.randomUUID();delete job.publishedId;list.unshift({...job,savedAt:Date.now()});localStorage.setItem(book,JSON.stringify(list));sessionStorage.removeItem(key);location.reload();}catch(e){text.textContent=e.message||'点子没收好，再试一次吧。';accept.disabled=false;}};cancel.onclick=()=>{sessionStorage.removeItem(key);panel.remove();};
})();
