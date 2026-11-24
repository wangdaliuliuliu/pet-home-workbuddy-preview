(function(root){
'use strict';
const T=typeof module!=='undefined'?require('./work-template'):root.WorkTemplate;
const talents=[{id:'sing',name:'唱歌',icon:'♫',format:'music',art:1},{id:'speak',name:'播报',icon:'◉',format:'speech',art:1},{id:'draw',name:'画画',icon:'✎',format:'image',art:0},{id:'story',name:'编故事',icon:'✦',format:'speech',art:2}];
function options(talent,task){
 const reading=/读书|阅读|故事|英语/.test(task),count=/跳绳|下|页|分钟/.test(task);
 const material=reading?'你讲的内容':count?'你报的数字':'你完成的这件事';
 const rows={sing:[['吹牛歌手',`把${material}唱成夸张的颁奖歌`, '每首歌夸大一处，夸得离谱但不冒充事实。','text,music'],['物件歌手',`让这件事里的小物件开口唱`, '让物件用自己的口气唱，副歌里争抢功劳。','text,music'],['反话歌手',`把${material}唱成一首反话歌`,'歌词里藏一句明显的反话，答案单独揭晓。','text,music']],speak:[['吹牛解说',`把${material}讲成争夺冠军的比赛`,'每期夸大一个动作，留给孩子找出解说员吹的牛。','text,speech'],['物件记者','采访和这件事有关的小物件','用单人转述呈现物件不同的意见，不能冒充多声线。','text,speech'],['秘密主播',`围绕${material}播出一段秘密广播`,'先给三条充分线索，让孩子猜本期神秘嘉宾。','text,speech']],draw:[['怪招画师',`为${material}画一件奇怪装备`,'装备有一个与任务相关的本领和一个好笑毛病。单张清晰设计插画。','text,image'],['反转画家',`把${material}编成图文小故事`,'先有误会，最后反转。用短文配一张关键场景图，不能承诺多页漫画。','text,image'],['藏宝画家',`把${material}画成藏秘密的画`,'正文先给找寻提示，图像安排清晰可见的目标，不能依赖精确图像计数。','text,image']],story:[['小事作家',`把${material}编成大冒险`,'主角把小事当大事，结尾由不起眼的小东西解决。','text,speech'],['物件作家','让相关的小物件讲自己的经历','从物件视角讲，和孩子对同一件事的理解不一样。','text,speech'],['反转作家',`根据${material}写一篇反转故事`,'开头让人误会，结尾用前面留下的细节解释真相。','text,speech']]};
 return (rows[talent]||[]).map(([name,description,rule,formats],i)=>({id:talent+'-'+i,name,description,rule,formats:formats.split(',')}));
}
function compile(d){
 const role=(d.generatedRoles||options(d.talent,d.task)).find(x=>x.id===d.roleId);if(!role)throw Error('先选一个岗位玩法。');
 const reading=/读书|阅读|故事|英语/.test(d.task),count=/跳绳|多少下/.test(d.task),input=reading?'text':/画画|绘画|手工|练字|写字|书法/.test(d.task)?'image':count?'number':'check';
 const name=(d.roleName||role.name).trim().slice(0,8),label=input==='text'?'讲讲今天读到的内容':input==='number'?'今天跳了多少下？':input==='image'?'拍一张今天的作品':'今天做完了吗？';
 const delivery=role.description;const submit=input==='text'?'讲一小段今天读到的内容':input==='number'?'填一下今天跳了多少下':input==='image'?'发一张今天的作品照片':'点一下“我完成啦”';
 const change=role.production?.dailyVariation||(reading?'每天用当天的新内容创作，保留一个具体细节。':'在固定玩法内每天更换对手、场景和小插曲，避开最近出现过的组合。数字输入必须影响结果。');
 return {schemaVersion:3,designVersion:6,id:d.id,career:'custom',careerName:name,title:name,description:role.description,talent:d.talent,harvest:delivery.slice(0,90),task:d.task,subject:role.production?role.production.contentTheme+'；内容来源：'+role.production.contentSource:(reading?'当天提交的阅读内容':'当天任务、完成次数或打卡记录'),production:role.production,rule:role.rule+' '+(role.production?'宠物的创作动作：'+role.production.transform+'；作品形式：'+role.production.workForm+'。':'')+' '+(d.fun||'')+' '+change,play:role.play||'enjoy',playInstruction:role.playInstruction||'打开当天的收获，看看宠物怎么完成工作。',sourceMode:'imagine',formats:role.formats,agreement:role.agreement||`${d.task}，做完后${submit}。宠物当你的${name}：${delivery}。${d.fun||role.rule.replace(/单张.*|不能.*|用短文.*/g,'').replace(/孩子/g,'你')}`,inputSpec:T.input(role.inputSpec||T.inferInput(d.task)),outputSpec:T.output({formats:role.formats,production:role.production,outputSpec:role.outputSpec}),variation:{strategy:reading?'source':'rotation',rule:change},buttonLabel:name,roleId:role.id};
}
const api={talents,options,compile};if(typeof module!=='undefined')module.exports=api;else root.JobBlueprint=api;
})(globalThis);
