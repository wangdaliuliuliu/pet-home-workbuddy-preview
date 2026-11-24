'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const mime=n=>({'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.mp3':'audio/mpeg'}[path.extname(n)]||'application/octet-stream');
function createStore(env=process.env,fetchImpl=fetch){
 const bucket=env.OSS_BUCKET,id=env.OSS_ACCESS_KEY_ID,secret=env.OSS_ACCESS_KEY_SECRET;
 const enabled=env.PET_PORTABLE!=='1'&&env.PET_OSS_ENABLED==='1'&&!!bucket&&!!id&&!!secret;
 const endpoint=env.OSS_ENDPOINT||'https://oss-cn-beijing.aliyuncs.com',internal=env.OSS_UPLOAD_ENDPOINT||endpoint;
 function host(base){const u=new URL(base);if(u.protocol!=='https:'||!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(u.hostname)||u.username||u.password)throw Error('OSS endpoint invalid');return 'https://'+bucket+'.'+u.hostname;}
 function valid(key){if(!/^(work-assets|work-examples|connection-tests)\/[a-zA-Z0-9/_.-]+$/.test(key)||key.split('/').includes('..'))throw Error('OSS key invalid');return key;}
 function sign(value){return crypto.createHmac('sha1',secret).update(value).digest('base64');}
 async function request(method,key,bytes,type,signal){valid(key);const date=new Date().toUTCString(),headers={Date:date,Authorization:'OSS '+id+':'+sign(method+'\n\n'+(type||'')+'\n'+date+'\n/'+bucket+'/'+key)};if(type)headers['Content-Type']=type;let r;try{r=await fetchImpl(host(internal)+'/'+key,{method,headers,body:bytes,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}catch{throw Object.assign(Error('作品已经做好，存储暂时没连上，稍后可重试保存。'),{code:'OSS_CONNECTION_FAILED',status:502});}if(!r.ok)throw Object.assign(Error('作品存储没有完成，请老师检查 OSS 权限。'),{code:'OSS_HTTP_'+r.status,status:502});return r;}
 return {enabled,mime,async put(key,bytes,type=mime(key),signal){if(bytes.length>32*1024*1024)throw Error('OSS object too large');const md5=crypto.createHash('md5').update(bytes).digest('hex');const r=await request('PUT',key,bytes,type,signal);if((r.headers.get('etag')||'').replaceAll('"','').toLowerCase()!==md5)throw Error('OSS upload checksum mismatch');return{key,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};},async get(key,signal){const r=await request('GET',key,undefined,undefined,signal);if(Number(r.headers.get('content-length'))>32*1024*1024)throw Error('OSS object too large');const b=Buffer.from(await r.arrayBuffer());if(b.length>32*1024*1024)throw Error('OSS object too large');return b;},url(key){valid(key);const expires=Math.floor(Date.now()/1000)+900;return host(endpoint)+'/'+key+'?'+new URLSearchParams({OSSAccessKeyId:id,Expires:String(expires),Signature:sign('GET\n\n\n'+expires+'\n/'+bucket+'/'+key)});}};
}
function ownerPrefix(dir){return 'work-assets/'+crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0,24)+'/';}
function forPet(dir,env=process.env){const store=createStore(env);try{if(!JSON.parse(fs.readFileSync(path.join(dir,'pet.json'))).petProfile)store.enabled=false;}catch{store.enabled=false;}return store;}
module.exports={createStore,forPet,ownerPrefix,mime};
