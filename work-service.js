'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {write,fail}=require('./account-service');
const date=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
const T=require('./public/work-template');
const {createHarvester}=require('./work-harvest');
const condition='前一天完成任务，第二天收到一整份工作收获';
function validate(raw){
 if(!raw||raw.schemaVersion!==3)throw fail('请发布新版的长期工作玩法。');
 const job={schemaVersion:3};
 if([4,6].includes(raw.designVersion))job.designVersion=raw.designVersion;
 if(['story','invent'].includes(raw.sourceMode))job.sourceMode=raw.sourceMode;
 for(const [key,max]of Object.entries({title:80,career:40,careerName:60,harvest:500,subject:2000,rule:4000,playInstruction:400})){if(typeof raw[key]!=='string'||!raw[key].trim()||raw[key].length>max)throw fail('请完整填写工作名称、收获和玩法，且不要超过字数限制。');job[key]=raw[key].trim();}
 for(const [key,max]of Object.entries({task:500,description:1000,agreement:2000,buttonLabel:80,roleId:100,talent:30})){if(raw[key]!==undefined){if(typeof raw[key]!=='string'||raw[key].length>max)throw fail('工作介绍太长或格式不正确。');job[key]=raw[key];}}
 if(raw.inputSpec){try{job.inputSpec=T.input(raw.inputSpec);}catch{throw fail('任务输入模块不正确。');}}
 if(raw.production){job.production={};for(const key of ['contentSource','contentTheme','transform','dailyVariation','workForm']){if(typeof raw.production[key]!=='string'||raw.production[key].length>2000)throw fail('工作内容尚未完整。');job.production[key]=raw.production[key];}}
 if(raw.variation){if(typeof raw.variation.rule!=='string'||raw.variation.rule.length>3000)throw fail('每日变化说明不正确。');job.variation={strategy:raw.variation.strategy==='source'?'source':'rotation',rule:raw.variation.rule};}
 if(!['guess','find','enjoy'].includes(raw.play))throw fail('请选择收获的参与方式。');job.play=raw.play;if(typeof raw.singingVoice==='string')job.singingVoice=raw.singingVoice.slice(0,500);job.musicDuration=[30,60].includes(Number(raw.musicDuration))?Number(raw.musicDuration):30;if(['story','imagine'].includes(raw.sourceMode))job.sourceMode=raw.sourceMode;
 if(!Array.isArray(raw.formats)||!raw.formats.length||raw.formats.some(f=>!['text','image','speech','music'].includes(f)))throw fail('请选择有效的收获形式。');job.formats=[...new Set(raw.formats)];job.outputSpec=T.output({...job,outputSpec:raw.outputSpec});return job;
}
function samples(){return [
 ['paper','reporter','小物件头条报','卖报员','一份荒诞小报','不起眼的小物件','把一件小事当成大新闻','find','找出报道里最奇怪的一处，再打开答案。','text'],
 ['letter','postman','云端来信处','邮递员','一封神秘来信','远方的一件小物品','每封信只透露三条写信人的线索','guess','先猜猜谁写的信，再揭晓。','text'],
 ['planet','explorer','反着来探险队','探险家','一页探险手记','小东西里面的世界','每次发现一条奇怪的当地规矩','enjoy','读完这次奇遇，把喜欢的发现收好。','text'],
 ].map(([id,career,title,careerName,harvest,subject,rule,play,playInstruction,format])=>({id:'sample-'+id,authorId:'office',authorName:'事务所示范',sample:true,version:1,publishedAt:0,job:{schemaVersion:3,career,title,careerName,harvest,subject,rule,play,playInstruction,formats:[format]}}));}
function createCatalog(dataDir,{authorName=()=>null}={}){
 const file=path.join(dataDir,'work-catalog.json'),db=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{jobs:[]};
 function list(){return [...db.jobs,...samples()].map(j=>({...j,authorName:authorName(j.authorId)||j.authorName,condition}));}
 function publish(user,raw,id,example=null){const job=validate(raw),sourceDraftId=typeof raw.id==='string'&&raw.id.length<=100?raw.id:null,old=id?db.jobs.find(j=>j.id===id):sourceDraftId?db.jobs.find(j=>j.authorId===user.id&&j.sourceDraftId===sourceDraftId):null;if(id&&!old)throw fail('工作不存在。',404);if(old&&old.authorId!==user.id)throw fail('只能修改自己设计的工作。',403);if(!old&&db.jobs.filter(j=>j.authorId===user.id).length>=50)throw fail('先整理已有的工作，再发布新点子。',409);const record={id:old?.id||crypto.randomUUID(),sourceDraftId:sourceDraftId||old?.sourceDraftId||null,authorId:user.id,authorName:user.childName,version:(old?.version||0)+1,publishedAt:old?.publishedAt??Date.now(),updatedAt:Date.now(),job,...(example?{example}:{})};db.jobs=[record,...db.jobs.filter(j=>j.id!==record.id)];write(file,db);return record;}
 return {list,get:id=>list().find(j=>j.id===id),publish};
}
function createWork({state,save,catalog,studio,now=()=>Date.now(),dataDirForPhotos,onHarvest=()=>{}}){
 state.work||={schedule:[],issues:{}};
 for(const issue of Object.values(state.work.issues)){if(issue.status==='generating'){issue.status='failed';issue.error='上次准备中断，已保留完成的内容；可手动继续。';issue.code='INTERRUPTED';}}
 let running=null;
 function selected(day=date(now())){return [...state.work.schedule].filter(s=>s.effectiveDate<=day).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate))[0]?.work||null;}
 function eligible(){return state.stories.some(s=>date(s.createdAt)===date(now()-86400000));}
 function publicIssue(i){if(!i)return null;return i.status==='ready'?i:{id:i.id,date:i.date,sourceDate:i.sourceDate,work:i.work,status:i.status,stage:i.stage,error:i.error,code:i.code,notification:i.status==='failed'?`${i.sourceDate||i.date||''}的工作生成失败，请联系管理员。`:null};}
 function view(){const today=date(now()),tomorrow=date(now()+86400000),active=selected(),next=selected(tomorrow),issue=Object.values(state.work.issues).find(i=>i.date===today)||state.work.issues[today];return {date:today,condition,active,next,changesTomorrow:!!state.work.schedule.find(s=>s.effectiveDate===tomorrow),eligible:eligible(),todayRead:state.stories.some(s=>date(s.createdAt)===today),issue:publicIssue(issue),history:Object.values(state.work.issues).sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,30).map(publicIssue),serviceEnabled:studio.caps().paidEnabled};}
 function install(id){const work=id?catalog.get(id):null;if(id&&!work)throw fail('这份工作已经不在事务所了。',404);const effectiveDate=date(now());state.work.schedule=state.work.schedule.filter(s=>s.effectiveDate<effectiveDate);state.work.schedule.push({effectiveDate,work:work?JSON.parse(JSON.stringify(work)):null});save();return view();}
 async function start(retry=false){
  if(running)return running;
  const day=date(now()),work=selected(),old=state.work.issues[day];
  const completed=state.work.completions?.[day+':'+work?.id];
  if(!work||!eligible()||(work.job.inputSpec&&!completed)||old?.status==='ready'||(old&&!retry))return view();
  // Missing provider configuration never becomes an automatic paid retry loop.
  if(!studio.caps().paidEnabled)return view();
  const issue=old||{date:day,work,media:{},status:'pending',createdAt:now()};state.work.issues[day]=issue;issue.status='generating';delete issue.error;save();
  running=(async()=>{try{
   issue.stage='text';save();
   if(!issue.result&&completed?.photoId&&!completed.visualDescription){issue.stage='image-input';save();const photo=state.photos.find(p=>p.id===completed.photoId);if(!photo||path.basename(photo.file)!==photo.file)throw fail('作品照片没有找到。',404);completed.visualDescription=await studio.inspectImage('data:'+photo.type+';base64,'+fs.readFileSync(path.join(dataDirForPhotos||'',photo.file)).toString('base64'));save();}
   if(!issue.result){const source=issue.work.job.inputSpec?(completed?.visualDescription||completed?.input||''):issue.work.job.sourceMode==='story'?state.stories.filter(s=>date(s.createdAt)===date(now()-86400000)&&s.transcript).map(s=>s.transcript).join('\n').slice(0,3000):'';issue.result=await studio.preview({job:issue.work.job,input:source,retry});save();}
   for(const kind of issue.work.job.formats.filter(f=>f!=='text')){if(issue.media[kind])continue;issue.stage=kind;save();const asset=await studio.render({id:issue.result.id,kind,retry});issue.media[kind]=asset.url;save();}
   issue.status='ready';issue.completedAt=now();issue.stage='complete';
  }catch(error){issue.status='failed';issue.error=error.message;issue.code=error.code||'WORK_FAILED';}finally{save();running=null;}return view();})();return running;
 }
 const harvester=createHarvester({state,save,studio,now,onReady:onHarvest,selected,dataDirForPhotos});
 return {view,install,start,runNext:harvester.runNext,harvests:harvester.list,markRead:harvester.markRead};
}
module.exports={createCatalog,createWork,validate,date};
