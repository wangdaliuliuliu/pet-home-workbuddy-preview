'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {fail}=require('./account-service');
function snapshot(root,own,job,ref){
 if(!ref)return null;
 if(!/^[a-f0-9]{32}$/.test(ref.resultId||''))throw fail('试玩没找到，请重新试一次。');
 const base=path.join(own,'job-studio'),file=path.join(base,ref.resultId,'result.json');
 if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink())throw fail('试玩没找到，请重新试一次。');
 const r=JSON.parse(fs.readFileSync(file));
 if(r.status!=='ready'||['careerName','rule','subject'].some(k=>r.job[k]!==job[k])||JSON.stringify(r.job.formats)!==JSON.stringify(job.formats))throw fail('玩法改过了，先再试玩一次吧。');
 const media={};const pending=[];
 for(const k of job.formats.filter(k=>k!=='text')){const name=k==='image'?'image.png':k+'.mp3',src=path.join(base,ref.resultId,name);if(r.assets?.[k]!=='ready'||!fs.existsSync(src)||fs.lstatSync(src).isSymbolicLink())throw fail('试玩作品还没做完，请等一下。');pending.push([k,src,name]);}
 if(ref.imageIds&&!Array.isArray(ref.imageIds))throw fail('试玩照片不正确。');
 const images=[];for(const id of [...new Set(ref.imageIds||[])].slice(0,6)){if(!/^[a-f0-9]{32}$/.test(id))throw fail('试玩照片不正确。');const src=path.join(base,'trial-inputs',id+'.json');if(!fs.existsSync(src)||fs.lstatSync(src).isSymbolicLink())throw fail('试玩照片没找到。');const m=JSON.parse(fs.readFileSync(src));if(!['png','jpg','webp'].includes(m.ext))throw fail('试玩照片不正确。');const f=path.join(base,'trial-inputs',id+'.'+m.ext);if(fs.lstatSync(f).isSymbolicLink())throw fail('试玩照片不正确。');pending.push(['input'+images.length,f,'input'+images.length+'.'+m.ext]);images.push('input'+(images.length));}
 const id=crypto.randomUUID(),dest=path.join(root,'work-examples',id);fs.mkdirSync(dest,{recursive:true});for(const [k,src,name] of pending){fs.copyFileSync(src,path.join(dest,name));media[k]='/api/work-examples/'+id+'/'+name;}
 let input=String(r.input||'').slice(0,3000);for(const f of job.inputSpec?.fields||[]){input=input.split('\n').map(line=>line.startsWith(f.id+'：')?f.label+'：'+line.slice(f.id.length+1).replace(/^true$/,'完成啦').replace(/^false$/,'还没完成'):line).join('\n');}
 return {version:1,input,images:images.map(k=>media[k]),result:Object.fromEntries(['title','body','lyrics','question','reveal'].map(k=>[k,String(r[k]||'')])),media:Object.fromEntries(Object.entries(media).filter(([k])=>!k.startsWith('input')))};
}
function serve(root,url,res){const m=url.match(/^\/api\/work-examples\/([a-f0-9-]{36})\/(image\.png|speech\.mp3|music\.mp3|input[0-5]\.(?:png|jpg|webp))$/);if(!m)throw fail('示例没找到。',404);const f=path.join(root,'work-examples',m[1],m[2]);if(fs.existsSync(f+'.oss.json')){const cloud=require('./work-oss').createStore(),entry=JSON.parse(fs.readFileSync(f+'.oss.json'));if(!cloud.enabled)throw fail('示例存储还没连接。',503);if(entry.key!=='work-examples/'+m[1]+'/'+m[2])throw fail('示例没找到。',404);res.writeHead(302,{Location:cloud.url(entry.key),'Cache-Control':'no-store'});return res.end();}if(!fs.existsSync(f)||fs.lstatSync(f).isSymbolicLink())throw fail('示例没找到。',404);const ext=path.extname(f);res.writeHead(200,{'Content-Type':{'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.mp3':'audio/mpeg'}[ext],'Cache-Control':'public, max-age=86400'});fs.createReadStream(f).pipe(res);}
async function publishSnapshot(root,own,job,ref){
 if(!ref)return null;const oss=require('./work-oss'),cloud=oss.forPet(own);if(!cloud.enabled)return snapshot(root,own,job,ref);
 if(!/^[a-f0-9]{32}$/.test(ref.resultId||''))throw fail('试玩没找到。');
 const file=path.join(own,'job-studio',ref.resultId,'result.json');if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink())throw fail('试玩没找到。');const r=JSON.parse(fs.readFileSync(file));
 if(r.status!=='ready'||['careerName','rule','subject'].some(k=>r.job[k]!==job[k])||JSON.stringify(r.job.formats)!==JSON.stringify(job.formats))throw fail('玩法改过了，先再试玩一次吧。');
 const hydrated=[];try{for(const [kind,entry] of Object.entries(r.oss||{})){if(!entry.key.startsWith(oss.ownerPrefix(own)+ref.resultId+'/'))throw fail('试玩路径不正确。');const name=kind==='image'?'image.png':kind+'.mp3';if(!['image','speech','music'].includes(kind))throw fail('试玩格式不正确。');const target=path.join(path.dirname(file),name);if(!fs.existsSync(target)){const b=await cloud.get(entry.key);if(require('crypto').createHash('sha256').update(b).digest('hex')!==entry.sha256)throw Error('OSS checksum mismatch');fs.writeFileSync(target,b);hydrated.push(target);}}
 const example=snapshot(root,own,job,ref);for(const url of [...example.images,...Object.values(example.media)]){const relative=url.replace('/api/work-examples/',''),f=path.join(root,'work-examples',relative),key='work-examples/'+relative;const entry=await cloud.put(key,fs.readFileSync(f),oss.mime(f));fs.writeFileSync(f+'.oss.json',JSON.stringify(entry));fs.unlinkSync(f);}return example;
 }finally{for(const f of hydrated)if(fs.existsSync(f))fs.unlinkSync(f);}
}
module.exports={snapshot,publishSnapshot,serve};
