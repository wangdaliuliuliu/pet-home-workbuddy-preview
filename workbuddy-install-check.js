'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {write}=require('./account-service');

const requestFile=directory=>path.join(directory,'workbuddy-install-check.json');
const lifetime=3*60000;

function requestCheck(directory){
  const request={id:randomUUID(),createdAt:Date.now()};
  write(requestFile(directory),request);
  return request.id;
}

function createInstallCheck(directory,probe){
  let outcome={state:'unchecked'},running=null;
  function status(){
    if(running)return outcome;
    let request;
    const file=requestFile(directory),claimed=file+'.'+randomUUID()+'.claimed';
    try{fs.renameSync(file,claimed);}catch{return outcome;}
    try{request=JSON.parse(fs.readFileSync(claimed,'utf8'));}catch{return outcome;}
    finally{try{fs.rmSync(claimed,{force:true});}catch{}}
    if(typeof request?.id!=='string'||!Number.isFinite(request.createdAt)||Date.now()-request.createdAt>lifetime)return outcome;
    outcome={id:request.id,state:'checking'};
    running=Promise.resolve().then(probe).then(reply=>{
      outcome={id:request.id,state:typeof reply==='string'&&reply.trim()==='PET_HOME_OK'?'ready':'unavailable'};
    }).catch(error=>{
      outcome={id:request.id,state:error?.diagnostic?.code==='workbuddy_auth'||error?.code==='workbuddy_auth'?'authorization_required':'unavailable'};
    }).finally(()=>{running=null;});
    return outcome;
  }
  return {status};
}

module.exports={requestCheck,createInstallCheck};
