(function(root){
 'use strict';
 function check(value){
  const text=String(value||'').trim();
  const hint='说一件每天能做的事吧，比如“陪奶奶散步”。';
  if(text.length<2||/^(你好|您好|哈哈|谢谢|再见|不知道|随便|没有|嗯+|啊+)[呀啊呢！!。\s]*$/.test(text))return hint;
  const action=/(读|阅读|看书|背|写|练|学|复习|预习|运动|锻炼|跳|跑|走|散步|睡|起床|早起|刷牙|洗|收拾|整理|打扫|做|完成|吃|喝|浇|喂|画|唱|弹|听|讲|说|记录|记账|存钱|打卡|提醒|监督|坚持|帮助|陪伴)/;
  if(!action.test(text)||/^(我|爸爸|妈妈|爷爷|奶奶)?(喜欢|爱|想要|要|想)(一个|一只|一首|一幅|个|只|首|幅)/.test(text))return hint;
  if(/^(喜欢|我喜欢|我爱|我很|今天很|好可爱)/.test(text)&&!/(每天|坚持|陪|提醒|监督|要去|想去)/.test(text))return hint;
  return '';
 }
 const api={check};if(typeof module!=='undefined')module.exports=api;else root.TaskCheck=api;
})(globalThis);
