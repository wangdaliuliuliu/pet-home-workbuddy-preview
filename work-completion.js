'use strict';
const {fail}=require('./account-service'),rewards=require('./story-rewards');
const day=rewards.day,T=require('./public/work-template');
function createCompletions({state,save,work,now=()=>Date.now(),onComplete=()=>{}}){
 state.work.completions||={};
 function submit(body){
  const active=work.view().active;if(!active||body.workId!==active.id)throw fail('这份工作还没有上岗，请确认今天的工作。',409);
  const date=day(now()),key=date+':'+active.id,old=state.work.completions[key];
  if(old)return {completion:old,replayed:true,quota:rewards.daily(state,now())};
  const spec=T.input(active.job.inputSpec||{type:'check',label:'今天做完了吗？'}),inputs={},photos=[];let parts=[];
  const supplied=body.values&&typeof body.values==='object'&&!Array.isArray(body.values)?body.values:{};
  for(const [index,v]of spec.fields.entries()){
   const value=Object.hasOwn(supplied,v.id)?supplied[v.id]:index===0?(v.type==='image'?{photoId:body.photoId}:body.value):undefined;
   if((value===undefined||value===''||value===null)&&!v.required)continue;
   if(v.type==='text'){if(typeof value!=='string'||value.length>1800||value.replace(/[\s\p{P}]/gu,'').length<4||/^(.)\1{3,}$/u.test(value.trim())||/^[嗯啊哦哈\s\p{P}]+$/u.test(value))throw fail('再讲清楚一点今天完成了什么吧。');inputs[v.id]=value.trim();parts.push(v.label+'：'+value.trim());}
   else if(v.type==='number'){if(typeof value!=='number'||!Number.isInteger(value)||value<v.min||value>v.max)throw fail('次数不对，再看看上面的要求吧。');inputs[v.id]=value;parts.push(v.label+'：'+value);}
   else if(v.type==='image'){const photo=state.photos?.find(p=>p.id===value?.photoId);if(!photo||photo.kind==='trip'||!photo.uploadActionId||day(photo.createdAt)!==date)throw fail('先发一张今天的作品照片吧。');inputs[v.id]={photoId:photo.id};photos.push(photo.id);parts.push(v.label+'：已提交作品照片');}
   else {if(value!==true&&v.required)throw fail('做完以后，再点“我完成啦”。');inputs[v.id]=value===true;}
  }
  if(parts.join('\n').length>3000)throw fail('今天写得有点多，少写几句吧。');
  const completion={id:key,workId:active.id,createdAt:now(),date,input:parts.join('\n').slice(0,3000),inputs,photoIds:photos,...(photos.length?{photoId:photos[0]}:{}),work:JSON.parse(JSON.stringify(active))};
  rewards.grant(state,completion,'work:'+active.id);state.work.completions[key]=completion;onComplete(completion);save();return {completion,replayed:false,quota:rewards.daily(state,now())};
 }
 return {submit,today:()=>{const active=work.view().active;return active?state.work.completions[day(now())+':'+active.id]||null:null;}};
}
module.exports={createCompletions};
