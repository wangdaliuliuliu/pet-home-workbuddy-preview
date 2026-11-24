(function(root){
'use strict';
const Ideas=typeof module!=='undefined'?require('./job-studio-ideas'):root.StudioIdeas;
const sources=[{id:'story',name:'昨天讲的故事',desc:'从故事里找一个人或一件事。'},{id:'imagine',name:'让宠物自己找',desc:'每天自己想一件新鲜事。'}];
function sourceSubject(mode){return mode==='imagine'?'宠物每天自己想的新鲜事':'昨天讲的故事里的一个细节；没有故事就自己想'}
function chooseSource(j,mode){return {...j,sourceMode:mode,subject:sourceSubject(mode)}}
function chooseIdea(j,id){const idea=Ideas.ideas(j.career).find(x=>x.id===id);return {...j,designVersion:4,ideaId:id,ideaName:idea.name,switchId:'',rule:'',play:idea.play,playInstruction:idea.play==='guess'?'我先猜，再打开答案。':'看看这一回怎么出糗，怎么越闹越大。'}}
function getIdea(j){return j.ideaId==='custom'?{id:'custom',name:'我的点子',ask:'还想加点什么？',rule:j.customIdea||'',switches:[{id:'bigger',label:'越来越夸张',rule:'事情每次越变越夸张。',example:'从一个小麻烦，变成全城都知道的大麻烦。'},{id:'surprise',label:'结尾有惊喜',rule:'结尾出现一个好笑又意外的变化。',example:'以为来了大怪兽，原来是小猫穿着大靴子。'}]}:Ideas.ideas(j.career).find(x=>x.id===j.ideaId)}
function setCustomIdea(j,text){return {...j,ideaId:'custom',ideaName:'我的点子',customIdea:text.trim(),switchId:'',rule:text.trim(),play:'enjoy',playInstruction:'看或听这份有趣的作品。'}}
function chooseSwitch(j,id){const idea=getIdea(j),sw=idea.switches.find(x=>x.id===id);return {...j,switchId:id,rule:idea.rule+sw.rule}}

const rows=[
['reporter','卖报员','一份报纸','小小报摊','不起眼的小物件|总被误会的角色|宠物路上遇到的家伙','只透露线索，不说主角名字|把一件小事当成大新闻|同一件事，让双方各说一遍','text,image','▤',0],
['singer','唱作人','一首歌','口袋录音棚','不会说话的东西|今天心情古怪的角色|宠物自己','用歌声说出一个秘密|让两个主角唱反调|把一句话越唱越夸张','text,music','♫',1],
['explorer','探险家','一页探险手记','远方事务所','平时进不去的地方|小东西里面的世界|看起来普通的角落','每次发现一条奇怪的当地规矩|带回一件不知道用途的东西|去一个所有事都反过来的地方','text,image','⌖',2],
['detective','侦探','一份案件档案','秘密调查局','离奇失踪的小东西|说话有破绽的角色|宠物收到的神秘包裹','先留下三条线索，再揭晓真相|让最不起眼的东西成为关键证据|让两个嫌疑人各讲一套说法','text,image','⌕',2],
['inventor','发明家','一张发明卡','奇想修理铺','生活里的小麻烦|两件不相干的物品|总被丢在角落的东西','每个发明有一个厉害本领和一个搞笑毛病|把两种用途装在同一件东西上|发明总能解决问题，却带来小意外','text,image','⚙',0],
['chef','小厨师','一张幻想菜单','奇妙厨房','一种心情|两种奇怪的味道|一个想不到的客人','每道菜吃下去会发生一种变化|菜的模样和吃起来的感觉完全不同|客人越挑剔，端出来的菜越奇怪','text,image','♨',1],
['postman','邮递员','一封来信','风的邮局','远方的陌生朋友|一件小物品|未来的宠物','每封信只透露三条写信人的线索|来信总带着一个奇怪请求|同一封信里有两个人在抢着说话','text,image','✉',0],
['cartoonist','漫画家','一页漫画故事','铅笔小屋','宠物和一个新朋友|没人注意的小配角|一对性格相反的搭档','最后一幕总把前面的意思翻过来|从最小的角色眼里看大事情|一句话总被误会成另一件事','text,image','✎',1],
['designer','设计师','一张装备设计图','奇装工坊','要做一件难事的角色|很普通的日常用品|一位奇怪的顾客','装备有一个超能力，也有一个小麻烦|把两种完全不同的东西拼在一起|外表很普通，里面藏着秘密机关','text,image','✂',0],
['host','电台主播','一期声音节目','晚风电台','不太会聊天的客人|一件会说话的小物品|意见相反的两个角色','把一件小事讲得像重大比赛|让两个嘉宾为小事吵出好笑的道理|用三段描述让听众认出神秘嘉宾','text,speech','◉',1],
['collector','收藏家','一张收藏卡','口袋博物馆','看着没用的小物件|旅途中带回的纪念品|别人没发现的宝贝','每件收藏品都有一个意外的用途|正面看很普通，背面藏着秘密|把两件东西放一起才看出秘密','text,image','◇',2],
['director','小导演','一幕图文小剧场','迷你剧场','性格相反的两个角色|宠物和一个神秘客人|平时不会说话的东西','每次演到一半就交换身份|台词说一回事，动作做另一回事|结尾让最不起眼的角色出场救场','text,image','▰',1]
];
const careers=rows.map(([id,name,harvest,shop,s,r,f,icon,art])=>({id,name,harvest,shop,subjects:s.split('|'),rules:r.split('|'),formats:f.split(','),icon,art}));
const plays=[{id:'guess',name:'先猜，再揭晓',desc:'留下线索，答案先藏好。',instruction:'先读线索，想一想答案；猜好了，再点开看看为什么。',icon:'？'}, {id:'find',name:'找出奇怪之处',desc:'藏一个小异常，让我找出来。',instruction:'我先找出哪里不对劲，再打开答案看看。',icon:'⌕'}, {id:'enjoy',name:'看完，听完，收起来',desc:'有趣的变化就在作品里面。',instruction:'看完或听完这一期，把喜欢的作品收起来。',icon:'☆'}];
function fresh(){return {schemaVersion:3,designVersion:4,sourceMode:'story',ideaId:'',ideaName:'',switchId:'',id:globalThis.crypto.randomUUID(),career:'',careerName:'',harvest:'',subject:sourceSubject('story'),rule:'',play:'',playInstruction:'',formats:['text','image'],title:'',step:0,mode:'team'}}
function career(j){return careers.find(c=>c.id===j.career)||{id:'custom',name:j.careerName,harvest:j.harvest,shop:'我的新工坊',subjects:['宠物遇到的人','一件普通的东西','一个奇怪的地方'],rules:['每次都藏一个秘密','让普通东西多一种特别本领','每次都会出现一个意想不到的变化'],formats:['text','image'],icon:'✦',art:0}}
function chooseCareer(j,id){const c=careers.find(c=>c.id===id);return {...fresh(),id:j.id,mode:j.mode,sourceMode:j.sourceMode||'story',subject:sourceSubject(j.sourceMode||'story'),career:id,careerName:c?.name||'',harvest:c?.harvest||'',formats:c?[...c.formats]:['text','image']}}
function validate(j,step){if(!j.careerName?.trim()||!j.harvest?.trim())return '先选工作，再定每天带回什么。';if(step>=1&&(!j.ideaId||(j.ideaId==='custom'&&!j.customIdea?.trim())))return '先看一个小例子，挑一个想玩的点子。';if(step>=2&&!j.rule?.trim())return '挑一个捣蛋办法，或者写下自己的。';return ''}
function migrate(old){if(old?.schemaVersion===3)return {...fresh(),...old,designVersion:4,sourceMode:old.sourceMode||'story',subject:sourceSubject(old.sourceMode||'story'),step:old.designVersion===4?Math.min(2,Math.max(0,Number(old.step)||0)):0};const c=careers.find(c=>c.id===old?.career);return {...fresh(),id:old?.id||globalThis.crypto.randomUUID(),career:c?.id||'',careerName:c?.name||'',harvest:c?.harvest||'',formats:c?[...c.formats]:['text','image']}}
function brief(j){return `每天带回${j.harvest||'……'}：${j.ideaName||'还没选好玩的点'}。${j.rule||'下一步，给它加一个自己的主意。'}`}
const api={getIdea,setCustomIdea,sources,sourceSubject,chooseSource,chooseIdea,chooseSwitch,ideas:Ideas.ideas,careers,plays,fresh,career,chooseCareer,validate,migrate,brief};if(typeof module!=='undefined')module.exports=api;else root.StudioModel=api;
})(globalThis);
