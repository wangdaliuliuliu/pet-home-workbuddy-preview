// Bound expensive requests before reading/decoding their bodies.
function createTaskQueue({maxWaiting=1,waitTimeoutMs=8000,maxActive=1,busyMessage}={}) {
 let active=0;const waiting=[];
 const problem=(message,status)=>Object.assign(new Error(message),{status});
 function permit(){let released=false;return ()=>{if(released)return;released=true;active--;while(waiting.length){const next=waiting.shift();if(next.take()){active++;break;}}};}
 function acquire(signal){
  if(signal?.aborted)return Promise.reject(problem('请求已取消。',499));
  if(active<maxActive){active++;return Promise.resolve(permit());}
  if(waiting.length>=maxWaiting)return Promise.reject(problem(busyMessage||'正在处理上一段录音，请稍等几秒再试。',429));
  return new Promise((resolve,reject)=>{
   let done=false;
   const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
   const remove=()=>{const i=waiting.indexOf(entry);if(i>=0)waiting.splice(i,1);};
   const abort=()=>{if(done)return;done=true;clean();remove();reject(problem('请求已取消。',499));};
   const entry={take(){if(done)return false;done=true;clean();resolve(permit());return true;}};
   const timer=setTimeout(()=>{if(done)return;done=true;clean();remove();reject(problem(busyMessage||'上一段录音还在处理，请稍后再试，录音不用重录。',429));},waitTimeoutMs);
   signal?.addEventListener('abort',abort,{once:true});waiting.push(entry);
  });
 }
 return {acquire,view:()=>({active:active>0,waiting:waiting.length})};
}
module.exports={createTaskQueue};
