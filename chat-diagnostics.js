'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const scope=new AsyncLocalStorage();
const token=(value,max=100)=>typeof value==='string'&&new RegExp('^[A-Za-z0-9_.:-]{1,'+max+'}$').test(value)?value:undefined;
function requestId(){return crypto.randomUUID();}
function mark(stage,extra={}){const ctx=scope.getStore();if(ctx)Object.assign(ctx,{stage},extra);}
function details(error,context={}){
 const ctx={...scope.getStore(),...context};
 return {requestId:token(ctx.requestId),attempt:ctx.attempt,stage:token(error.stage)||token(ctx.stage)||'chat_request',
  code:token(error.reason)||token(error.code)||(error instanceof SyntaxError?'invalid_response':'unexpected_error'),status:Number.isInteger(error.status)?error.status:502,
  upstreamStatus:Number.isInteger(error.providerStatus)?error.providerStatus:ctx.upstreamStatus,
  upstreamCode:token(error.upstreamCode),upstreamRequestId:token(error.upstreamRequestId,128)||token(ctx.upstreamRequestId,128),
  networkCode:token(error.cause?.code)||token(error.networkCode),
  model:token(ctx.model),elapsedMs:ctx.startedAt?Date.now()-ctx.startedAt:undefined};
}
function record(error,context={}){
 const row={at:new Date().toISOString(),...details(error,context),outcome:token(context.outcome)||'failed'};
 if(process.env.PET_SKIP_ENV==='1'&&!process.env.PET_DATA_DIR)return row;
 try{
  const dir=process.env.PET_DATA_DIR||path.join(__dirname,'data');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'chat-errors.json');let rows=[];
  try{rows=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(rows))rows=[];}catch{}
  const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify([...rows,row].slice(-200),null,2),{mode:0o600});fs.renameSync(temp,file);
 }catch{console.warn(JSON.stringify({event:'pet_chat_diagnostic_write_failed',requestId:row.requestId}));}
 if(process.env.PET_SKIP_ENV!=='1')console.warn(JSON.stringify({event:'pet_chat_error',...row}));
 return row;
}
function finish(id,outcome){
 if(process.env.PET_SKIP_ENV==='1'&&!process.env.PET_DATA_DIR)return;
 try{const file=path.join(process.env.PET_DATA_DIR||path.join(__dirname,'data'),'chat-errors.json');
  const rows=JSON.parse(fs.readFileSync(file,'utf8'));let changed=false;
  for(const row of rows)if(row.requestId===id){row.finalOutcome=outcome;changed=true;}
  if(changed){const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(rows,null,2),{mode:0o600});fs.renameSync(temp,file);}
 }catch{}
}
module.exports={requestId,mark,details,record,finish,run:(ctx,fn)=>scope.run(ctx,fn)};
