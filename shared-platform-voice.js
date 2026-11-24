'use strict';

const prefix='/api/local-voice/';
const enabled=()=>process.env.PET_LOCAL_PLATFORM_VOICE_ENABLED==='1';
const fail=(message,status,code)=>Object.assign(Error(message),{status,code});

async function handle({req,res,route,accounts,body,runtime,json,now,voice}){
  if(!enabled())throw fail('本地平台语音暂未开放。',404);
  if(route==='status'&&req.method==='GET')return json(res,200,{platformVoice:1});
  if(route==='device'&&req.method==='POST'){
    const user=accounts.current({headers:{cookie:req.headers.cookie}});
    if(!user)throw fail('请先登录你的小家。',401);
    return json(res,200,{token:accounts.deviceToken(user,90,'local-voice'),accountId:user.id,expires:now()+90*86400000});
  }
  const user=accounts.current({headers:{authorization:req.headers.authorization}},'local-voice');
  if(!user)throw fail('请重新登录，恢复平台语音。',401,'voice_setup');
  if(route!=='voice'||!['GET','POST'].includes(req.method))throw fail('没有找到这个操作。',404);
  const companion=runtime(user).companionVoice;
  if(!companion)throw fail('这个账号的新版平台语音暂未开放。',503,'voice_setup');
  if(req.method==='GET')return json(res,200,companion.platform());
  const input=await body(req);
  if(!voice.BILINGUAL_VOICES.some(item=>item.id===input.voice))throw fail('请选择列表里的平台音色。',400,'voice_setup');
  const controller=new AbortController();
  const cancel=()=>{if(!res.writableEnded)controller.abort();};
  res.once('close',cancel);
  try{
    const audio=await companion.speak(input.text,{platformVoice:input.voice,purpose:input.purpose==='story'?'story':'chat',signal:controller.signal});
    res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'private, no-store',...(audio.usedOwnKey?{'X-Pet-Voice-Source':'own-key'}:{})});
    return res.end(audio);
  }finally{res.removeListener('close',cancel);}
}

module.exports={prefix,enabled,handle};
