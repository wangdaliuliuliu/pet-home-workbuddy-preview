const LIMIT = 2;
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit' });
function day(now=Date.now()) { return dateFormat.format(new Date(now)); }
function migrate(state) {
  if(state.storyRewards?.version===1)return;
  const days={};
  // Existing inventory and earned credits are retained. Today's earlier stories already count towards the cap.
  for(const story of state.stories||[]) {
    if(!Number.isFinite(story.createdAt))continue;
    const date=day(story.createdAt);days[date]=Math.min(LIMIT,(days[date]||0)+1);
  }
  state.storyRewards={version:1,balance:Math.max(0,(Number(state.readings)||0)-(Number(state.rewardSpent)||0)),days};
}
function available(state) { return state.storyRewards?.version===1 ? state.storyRewards.balance : Math.max(0,state.readings-state.rewardSpent); }
function daily(state,now=Date.now()) {
  const date=day(now),earned=Math.min(LIMIT,state.storyRewards?.days?.[date]||0);
  return {date,limit:LIMIT,earned,remaining:LIMIT-earned,resetAt:new Date(Date.parse(date+'T00:00:00+08:00')+86400000).toISOString()};
}
function grant(state,story,activity='reading') {
  migrate(state);
  if(story.reward)return story.reward;
  const quota=daily(state,story.createdAt);let repeated=false;
  if(state.petProfile&&!state.petProfile.legacyRules){state.storyRewards.activities||={};const used=state.storyRewards.activities[quota.date]||={};
    for(const item of state.stories||[])if(item.reward?.granted&&day(item.createdAt)===quota.date)used.reading=true;
    for(const item of Object.values(state.work?.completions||{}))if(item.reward?.granted&&day(item.createdAt)===quota.date)used['work:'+item.workId]=true;
    repeated=!!used[activity];if(!repeated&&quota.remaining>0)used[activity]=true;
  }
  const granted=quota.remaining>0&&!repeated;
  if(granted){state.storyRewards.days[quota.date]=quota.earned+1;state.storyRewards.balance++;}
  story.reward={date:quota.date,granted,...(state.petProfile&&!state.petProfile.legacyRules?{activity,reason:repeated?'ACTIVITY_ALREADY_REWARDED':!granted?'DAILY_LIMIT':null}:{})};
  return story.reward;
}
function result(state,story,now=Date.now(),replayed=false) {
  const quota=daily(state,now),granted=!!story.reward?.granted;
  if(['food','ingredients'].includes(state.taskRewardMode))return {storyId:story.id,granted,replayed,message:replayed?'任务已经记好，奖励不会重复增加。':granted?'完成啦！可以选1个食材，去厨房看看吧。':story.reward?.reason==='ACTIVITY_ALREADY_REWARDED'?'今天这件事的食材奖励已拿过啦，任务仍然记好了。':'任务记好啦！今天两个食材奖励已经拿满，明天再来。',...quota};
  const message=replayed?'这个故事已经收好啦，奖励不会重复增加。':granted
    ? quota.remaining===0?'故事收好啦！获得一个食材额度，今天的 2 个奖励已经拿满啦。':'故事收好啦！获得一个食材额度，去挑喜欢的食材吧。'
    : '故事收好啦！每天讲故事最多获得 2 个食材奖励，今天已经拿满了。明天零点后再来吧！';
  return {storyId:story.id,granted,replayed,message,...quota};
}
function spend(state,count) { migrate(state);state.storyRewards.balance-=count; }
module.exports={LIMIT,day,migrate,available,daily,grant,result,spend};
