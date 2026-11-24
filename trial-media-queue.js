'use strict';
function createMediaQueue({limit=2,maxWaiting=14}={}){const tasks=new Map(),queue=[];let active=0;
 function view(key){const t=tasks.get(key);return t?{status:t.status,...(t.status==='queued'?{position:queue.indexOf(t)+1}:{}),...(t.result?{result:t.result}:{}),...(t.error?{error:t.error,code:t.code}:{})}:null;}
 function drain(){while(active<limit&&queue.length){const t=queue.shift();active++;t.status='processing';Promise.resolve().then(t.action).then(r=>{t.status='ready';t.result=r},e=>{t.status='failed';t.error=e.status?e.message:'这部分还没做好，文字已经保留。';t.code=e.code||'GENERATION_FAILED'}).finally(()=>{active--;drain()});}}
 function start(key,action,retry=false){const old=tasks.get(key);if(old&&!(old.status==='failed'&&retry))return view(key);if(queue.length>=maxWaiting)throw Object.assign(Error('正在准备的作品有点多，稍后再点一下，输入还在。'),{status:429});const t={key,action,status:'queued'};tasks.set(key,t);queue.push(t);for(const[k,v]of tasks)if(tasks.size>160&&['ready','failed'].includes(v.status)&&k!==key)tasks.delete(k);drain();return view(key);}
 return {start,view};
}
module.exports={createMediaQueue};
