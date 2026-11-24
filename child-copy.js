'use strict';
// Keep provider codes/diagnostics separate; children only need a clear next step.
function childError(message){
 const s=String(message||'');
 if(/密钥|配置|HTTPS|百炼|DeepSeek|API|鉴权/.test(s))return '这里还没准备好，请找老师帮忙。';
 if(/额度|余额/.test(s))return /服务|账户|余额/.test(s)?'这会儿用不了，请找老师帮忙。':'先完成任务，再来领奖吧。';
 if(/接口|请求格式|JSON|模块|文件格式/.test(s))return '这次没送好，再试一次吧。';
 if(/管理员/.test(s))return s.replace(/生成失败，请联系管理员。/g,'没做好，请找老师帮忙。');
 return s;
}
module.exports={childError};
