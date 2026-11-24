'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const events = [
  ['deliver', 'repair', '用纸船送一颗种子', '纸船被小涡流卡住', '用细绳把船拉正'],
  ['hang', 'invent', '挂好一串铃铛', '铃响的次序全反了', '用错拍编出一段新节奏'],
  ['navigate', 'complete', '顺着脚印找路', '脚印在岔口掉转方向', '换到另一侧找到正确出口'],
  ['stack', 'adapt', '把不同大小的盒子叠起来', '最轻的盒子被风掀翻', '摊成一排矮矮的格子'],
  ['sort', 'invent', '把捡到的纽扣分类', '有一颗正反两面颜色不同', '让它变成两堆之间的记号'],
  ['measure', 'complete', '量出一段合适的缎带', '原来的刻度被折痕挡住', '换个起点量出需要的长度'],
  ['shelter', 'repair', '给一盆小芽搭雨棚', '棚顶把水引回了盆里', '抬高一边让水从侧面流走'],
  ['balance', 'adapt', '把圆果子稳稳放进托盘', '盘子一歪，果子都往一边滚', '用软垫隔出一颗一个的小窝'],
  ['mark', 'invent', '给拐弯处做个路标', '路标翻面后指向相反方向', '做成两面都看得懂的图案'],
  ['unwind', 'complete', '把缠成团的线绕回线轴', '线尾钻进了最里层', '先放松外圈再抽出线尾'],
  ['cool', 'adapt', '把刚烤好的点心晾凉', '底下的热气把纸垫蒸软了', '架高托盘让风从底下穿过'],
  ['bridge', 'repair', '给纸做的小车铺一段桥', '车轮卡在两片纸板的接缝', '搭一片薄纸盖住接缝'],
  ['sow', 'complete', '把种子排成一小行', '一阵风把轻的种子吹到边上', '用折纸槽慢慢把它们撒回去'],
  ['pack', 'adapt', '把东西装进一只小篮子', '最后一件太长，篮盖合不上', '改用提手把长东西固定在外侧'],
  ['listen', 'discover', '循着轻轻的滴答声找来源', '站在正面反而听不清', '从侧面听出是两片叶子在碰'],
  ['stamp', 'invent', '用几种叶片印图案', '中间那枚印倒了', '添一个相反的印组成一对翅膀'],
  ['open', 'repair', '打开一个夹住的小盒盖', '越使劲，盒边卡得越紧', '压平歪掉的盒角后轻轻滑开'],
  ['deliver-message', 'discover', '沿着折痕展开一张留言', '两半字怎么也接不上', '把右半张转过来读出藏着的提示'],
  ['float', 'complete', '让装碎叶的小托盘浮起来', '一角先吃进了水', '把碎叶分到四角让托盘浮平'],
  ['arrange-sound', 'adapt', '让几根空管发出不同声音', '最短的管子突然不响', '用它来敲拍子，给其他声音留空'],
].map(([id, ending, action, surprise, resolution]) => ({id, ending, action, surprise, resolution}));

function reserveStoryEvent(dataDir, { key, date, roles }) {
  const dir = path.join(dataDir, 'story-events');
  fs.mkdirSync(dir, {recursive:true});
  const records = fs.readdirSync(dir).filter(name=>name.endsWith('.json'))
    .map(name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')));
  const reserved = records.find(record=>record.key===key);
  if(reserved)return reserved.event;
  const recent = roles.map(role=>records.filter(r=>r.date<=date&&r.roles.includes(role))
    .sort((a,b)=>b.date.localeCompare(a.date)||b.at-a.at).slice(0,5));
  const score = event=>recent.reduce((sum,history)=>sum+
    (history.some(r=>r.event.id===event.id)?10:0)+(history[0]?.event.ending===event.ending?1:0),0);
  const offset=Math.floor(Date.parse(date)/86400000)%events.length;
  const candidates=[...events.slice(offset),...events.slice(0,offset)].sort((a,b)=>score(a)-score(b));
  for(const [index,event] of [...candidates,candidates[0]].entries()){
    // Overflow preserves the role's rotation when a full day uses all distinct events.
    const suffix=index===candidates.length ? '-'+encodeURIComponent(key) : '';
    const slot=path.join(dir,date+'-'+event.id+suffix+'.json');
    const temp=path.join(dir,randomUUID()+'.tmp');
    try{
      fs.writeFileSync(temp,JSON.stringify({key,date,roles,event,at:Date.now()}),{flag:'wx'});
      // Publishing a complete file with an exclusive link prevents two workers claiming one event.
      fs.linkSync(temp,slot);
      return event;
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      const other=JSON.parse(fs.readFileSync(slot,'utf8'));
      if(other.key===key)return other.event;
    }
    finally{fs.rmSync(temp,{force:true});}
  }
}

function eventPrompt(event){
  return event ? `按这件事写完整故事：${event.action}；意外：${event.surprise}；收场：${event.resolution}。按角色的身体和场地调整细节，保留核心行动、意外和收场。` : '';
}
module.exports={reserveStoryEvent,eventPrompt};
