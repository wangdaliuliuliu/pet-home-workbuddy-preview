'use strict';
const crypto=require('node:crypto');
const day=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
function createReadingTopics({state,save,prepare,chat,pet,remember,report,now=Date.now}) {
  state.readingTopics ||= {};
  let pending=Promise.resolve();
  const todayStories=()=>state.stories.filter(s=>s.transcript&&Number.isFinite(s.createdAt)&&day(s.createdAt)===day(now())&&(s.kind!=='reading'||s.transcriptionStatus==='ready')).slice(0,3);
  function context(message,history=[]) {
    const available=todayStories().map(story=>({story,record:state.readingTopics[story.id]})).filter(item=>item.record?.summary);
    const index=available.map(({story,record})=>({id:story.id,summary:record.summary.slice(0,100)}));
    const explicit=/今天.*(?:读|书|故事)|刚才.*(?:读|故事)|那(?:本书|个故事)|\b(?:read|book|reading|story)\b/i.test(message);
    const followUp=history.at(-1)?.readingStoryId&&/^(?:它|他|她|那|为啥|为什么|后来|可是|我觉得|不对|yes|no|why|what|how|it|he|she)/i.test(message.trim());
    const matches=[];
    for(const {story,record} of available){
      const detail=record.details.find(item=>item.keywords.some(word=>message.toLowerCase().includes(word.toLowerCase())));
      if(detail||explicit||followUp&&history.at(-1).readingStoryId===story.id){
        const chosen=detail||record.details[record.selected||0]||record.details[0];
        if(chosen){const offset=story.transcript.indexOf(chosen.quote);matches.push({storyId:story.id,detail:chosen.description,excerpt:story.transcript.slice(Math.max(0,offset-120),Math.max(0,offset-120)+650)});}
      }
    }
    return {index,excerpts:matches.slice(0,2)};
  }
  function schedule(story) {
    if(!story?.transcript||day(story.createdAt)!==day(now())||state.readingTopics[story.id])return pending;
    const record={status:'preparing',day:day(now())};state.readingTopics[story.id]=record;save();
    pending=pending.then(async()=>{
      try{
        const result=await prepare(story.transcript);
        record.summary=String(result.summary||'').slice(0,180);
        record.details=(Array.isArray(result.details)?result.details:[]).filter(item=>typeof item.quote==='string'&&item.quote.length>=4&&story.transcript.includes(item.quote)&&typeof item.description==='string').slice(0,3).map(item=>({quote:item.quote.slice(0,160),description:item.description.slice(0,180),keywords:(Array.isArray(item.keywords)?item.keywords:[]).filter(word=>typeof word==='string'&&word.length>=2&&word.length<=24).slice(0,8)}));
        record.status='ready';save();
        if(record.summary)remember(story.id,record.summary);
        if(!record.details.length||record.day!==day(now())||state.readingTopicDay===record.day)return;
        state.readingTopicDay=record.day;
        const recent=(state.readingTopicAngles||[]).slice(-5);
        const angles=['对角色的一个选择有点不同意见','被一个具体办法逗乐，顺着想一步','对一个小细节产生具体的疑惑','替其中一个角色有一点牵挂','想到一种想和孩子一起试想的变化'];
        const angle=angles.find(item=>!recent.slice(-3).includes(item))||angles[0];
        record.selected=recent.length%record.details.length;
        const detail=record.details[record.selected];
        const previous=state.chatArchive.at(-1)?.id;
        save();
        const response=await chat('分享你听完这段阅读后冒出的一个念头。',state.chatMessages||[],{...pet(),readingSituation:{summary:record.summary,detail,angle,recentOpenings:state.chatArchive.filter(m=>m.proactive).slice(-5).map(m=>m.content)}},state.memories.filter(m=>m.type==='preference').slice(-8));
        if(response.degraded){record.topicStatus='failed';save();return;}
        if(previous!==state.chatArchive.at(-1)?.id){record.topicStatus='conversation_changed';save();return;}
        const message={id:crypto.randomUUID(),role:'assistant',content:response.reply,createdAt:now(),actionId:'reading-topic-'+story.id,proactive:true,readingStoryId:story.id};
        state.chatArchive.push(message);state.chatMessages=[...(state.chatMessages||[]),message].slice(-24);
        state.readingTopicAngles=[...recent,angle];record.topicStatus='sent';save();
      }catch(error){record.status='failed';record.errorCode=error.reason||'reading_preparation_failed';save();report?.(error);}
    });
    return pending;
  }
  function ensureLatest(){const story=todayStories()[0];if(story)schedule(story);}
  return {schedule,ensureLatest,context,settled:()=>pending};
}
module.exports={createReadingTopics};
