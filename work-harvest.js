'use strict';
const fs=require('node:fs'),path=require('node:path');
const day=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
const nextDay=d=>day(Date.parse(d+'T00:00:00+08:00')+86400000);
function createHarvester({state,save,studio,now=()=>Date.now(),selected,dataDirForPhotos,nodeTimeoutMs=240000,retryDelayMs=30000,onReady=()=>{}}){
 state.work.seen||={};let running=false;
 for(const [id,i] of Object.entries(state.work.issues)){i.id||=id;i.date||=id.slice(0,10);if(!i.sourceDate){const c=state.work.completions?.[i.date+':'+i.work?.id];i.sourceDate=i.work?.job?.inputSpec&&c?c.date:day(Date.parse(i.date+'T00:00:00+08:00')-86400000);}if(i.queueVersion===1){for(const n of Object.values(i.nodes||{}))if(n.status==='running'){n.failures=(n.failures||0)+1;n.status=n.failures>=3?'failed':'pending';}if(Object.values(i.nodes||{}).some(n=>n.status==='failed'))i.status='failed';else if(i.status!=='ready')i.status='pending';}}
 function ensure(){const today=day(now());let changed=false;
  for(const c of Object.values(state.work.completions||{})){if(!c.work||c.date>=today)continue;const date=nextDay(c.date),id=date+':'+c.workId;const prior=Object.values(state.work.issues).find(i=>i.sourceDate===c.date&&i.work?.id===c.workId);if(state.work.issues[id]||prior?.queueVersion===1||prior?.status==='ready')continue;
   const nodes={};for(const pid of c.photoIds||[c.photoId].filter(Boolean))nodes['photo-'+pid]={status:'pending',failures:0,photoId:pid};nodes.text={status:'pending',failures:0};for(const k of c.work.job.formats.filter(k=>k!=='text'))nodes[k]={status:'pending',failures:0};
   if(prior){for(const [k,n]of Object.entries(nodes)){if(k==='text'&&prior.result||k.startsWith('photo-')&&prior.result||prior.media?.[k])n.status='ready';if(k===prior.stage&&prior.status==='failed'&&n.status!=='ready')n.failures=1;}Object.assign(prior,{date,sourceDate:c.date,completionId:c.id,nodes,queueVersion:1,status:Object.values(nodes).every(n=>n.status==='ready')?'ready':'pending'});if(prior.status==='ready')prior.completedAt=now();changed=true;continue;}
   state.work.issues[id]={id,date,sourceDate:c.date,completionId:c.id,work:JSON.parse(JSON.stringify(c.work)),nodes,queueVersion:1,status:'pending',media:{},createdAt:now()};changed=true;
  }
  // Old published jobs without an input form retain yesterday-reading as their completion source.
  const yesterday=day(Number(now())-86400000),work=selected(day(now()));
  if(work&&!work.job.inputSpec&&state.stories.some(s=>day(s.createdAt)===yesterday)&&!Object.values(state.work.issues).some(i=>i.date===today&&i.work?.id===work.id)){
   const id=today+':'+work.id,nodes={text:{status:'pending',failures:0}};for(const k of work.job.formats.filter(k=>k!=='text'))nodes[k]={status:'pending',failures:0};state.work.issues[id]={id,date:today,sourceDate:yesterday,work:JSON.parse(JSON.stringify(work)),nodes,queueVersion:1,status:'pending',media:{},createdAt:now()};changed=true;
  }
  if(changed)save();
 }
 function list(){return Object.values(state.work.issues).sort((a,b)=>String(b.sourceDate||b.date).localeCompare(String(a.sourceDate||a.date))||b.createdAt-a.createdAt).map(i=>{const ready=i.status==='ready';return{id:i.id,date:i.date,sourceDate:i.sourceDate,work:i.work,status:i.status,stage:i.stage,createdAt:i.createdAt,completedAt:i.completedAt,unread:ready&&!state.work.seen[i.id],...(ready?{result:i.result,media:i.media}:{notification:i.status==='failed'?`${i.sourceDate}的作品没做好，请找老师帮忙。`:null}),nodes:i.nodes?Object.fromEntries(Object.entries(i.nodes).map(([k,n])=>[k,{status:n.status,failures:n.failures}])):undefined};});}
 function markRead(ids){for(const id of Array.isArray(ids)?ids:[]){if(state.work.issues[id]?.status==='ready')state.work.seen[id]=now();}save();return list();}
 async function bounded(action,timeoutMs=nodeTimeoutMs){const controller=new AbortController();let timer;try{return await Promise.race([action(controller.signal),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('这个步骤等待超时。'),{code:'WORK_NODE_TIMEOUT'}));},timeoutMs);})]);}finally{clearTimeout(timer)}}
 async function runNext(){if(running||!studio.caps().paidEnabled)return false;ensure();const issue=Object.values(state.work.issues).filter(i=>i.queueVersion===1&&i.status==='pending'&&Object.values(i.nodes).some(n=>n.status!=='ready')&&(()=>{const n=Object.values(i.nodes).find(n=>n.status!=='ready');return n?.status==='pending'&&(n.retryAt||0)<=now()})()).sort((a,b)=>(a.lastRunAt||0)-(b.lastRunAt||0)||a.createdAt-b.createdAt)[0];if(!issue)return false;
  const entry=Object.entries(issue.nodes).find(([,n])=>n.status==='pending');if(!entry){issue.status='ready';issue.completedAt=now();save();return true}const [kind,node]=entry;running=true;node.status='running';issue.status='generating';issue.stage=kind;issue.lastRunAt=now();save();
  try{const completion=state.work.completions?.[issue.completionId];
   if(kind.startsWith('photo-')){const photo=state.photos?.find(p=>p.id===node.photoId);if(!photo||path.basename(photo.file)!==photo.file)throw Error('作品照片没有找到。');const text=await bounded(signal=>studio.inspectImage('data:'+photo.type+';base64,'+fs.readFileSync(path.join(dataDirForPhotos||'',photo.file)).toString('base64'),{signal}));issue.imageDescriptions||={};issue.imageDescriptions[node.photoId]=text;}
   else if(kind==='text'){let source=completion?.input||'';if(!completion)source=state.stories.filter(s=>day(s.createdAt)===issue.sourceDate&&s.transcript).map(s=>s.transcript).join('\n');source=[source,...Object.values(issue.imageDescriptions||{})].filter(Boolean).join('\n').slice(0,3000);
    const recent=Object.values(state.work.issues).filter(i=>i.status==='ready'&&i.work?.id===issue.work.id).slice(-7).map(i=>i.result?.title).filter(Boolean);const job={...issue.work.job,rule:issue.work.job.rule+' 本期对应完成日期：'+issue.sourceDate+'。按既定主题和每日变化规则创作。最近标题：'+recent.join('、')+'。不要重复近期内容，不编造孩子未提供的真实行为。'};
    issue.result=await bounded(signal=>studio.preview({job,input:source,retry:node.failures>0},{signal}));}
   else{const asset=await bounded(signal=>studio.render({id:issue.result.id,kind,retry:node.failures>0,automatic:true},{signal}),kind==='image'?Math.max(nodeTimeoutMs,810000):nodeTimeoutMs);issue.media[kind]=asset.url;}
   node.status='ready';delete node.error;delete node.diagnostic;issue.status=Object.values(issue.nodes).every(n=>n.status==='ready')?'ready':'pending';if(issue.status==='ready'){issue.completedAt=now();issue.stage='complete';onReady(issue);}
  }catch(e){if(e.code!=='BUSY')node.failures++;const stopImage=kind==='image'&&e.code!=='BUSY'&&e.retryable!==true;node.retryAt=Number(now())+(kind==='image'&&e.retryable===true?[30,120][Math.min(node.failures-1,1)]*60000:retryDelayMs);node.error=e.code||'WORK_NODE_FAILED';if(e.diagnostic)node.diagnostic={at:new Date().toISOString(),...e.diagnostic};node.status=stopImage||node.failures>=3?'failed':'pending';issue.status=node.status==='failed'?'failed':'pending';issue.error=node.status==='failed'?`${issue.sourceDate}的作品没做好，请找老师帮忙。`:null;issue.code=node.error;}
  finally{running=false;save()}return true;
 }
 return{runNext,list,markRead,ensure};
}
function createHarvestQueue(getWorkers){let running=false,closed=false;return{async drain(){if(running||closed)return;running=true;try{const workers=getWorkers();for(let round=0;round<18&&!closed;round++){let progress=false;for(const w of workers){if(closed)break;try{progress=await w.runNext()||progress;}catch(e){console.error('Work queue account error:',e.code||'WORK_STATE_ERROR');}}if(!progress)break;}}finally{running=false}},close(){closed=true}};}
module.exports={createHarvester,createHarvestQueue,nextDay};
