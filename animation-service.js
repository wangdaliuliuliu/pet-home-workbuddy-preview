const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./evolution-service');
const genericMotion=require('./generic-pet-motion');
const localAgent=require('./local-agent');
const BUNDLED_FORM = '/api/evolutions/0b14c716-3fe7-4472-8605-8c7f785aa1fc.png';
function atlasPrompt() {
  return `Make a transparent PNG 3x3 cutout animation atlas of the EXACT current evolved kitten in the reference. Preserve its CURRENT identity, costume, colors and ALL current anatomical features. Do not restore any old wings or invent new features absent from this reference. Front-facing orthographic consistent scale/light, exquisite 3D storybook rendering. STRICT nine equal cells, each part wholly inside its own cell with at least 8 percent empty margin. No text, lines, labels, background, floor or shadows.
Row1: (1) head only with crown ears and open eyes, ending immediately below chin: NO neck, chest or necklace; (2) exactly identical head with softly closed eyes, identical proportions, position and crop, NO neck; (3) full torso including neck/chest, clothing, skirt if present, necklace and ALL body decorations; NO head arms legs tail or back appendages. Hidden surfaces must be complete for joint overlap.
Row2: (1) viewer-left arm from shoulder to paw pointing straight down, complete upper shoulder; (2) viewer-right arm matching and pointing straight down; (3) viewer-left leg from upper thigh to toe pointing straight down, full shoe and current decorations.
Row3: (1) tail only, root bottom-right curling up-left, or leave cell entirely transparent if no tail in reference; (2) ONLY current back appendages together, front-view symmetric attachment at central upper back. If reference has wings, include ONLY those CURRENT wings; if it has other back adornments use those; if none, leave entire cell truly transparent. Other new decorations belong to their own head, torso or limb layer and must remain identical to reference; (3) viewer-right leg from thigh to toe, matching left leg.
Keep pieces separate, never show a whole cat, no duplicate necklace on head, no dangling extra neck. Use an opaque perfectly flat #00FF00 chroma green background; the game removes it separately. Never depict transparency as checkerboard or white squares. No green in the character or accessories. This is a rigging asset, not an evolution: NEVER add/remove character features.`;
}
function validManifest(m) {
  if(genericMotion.valid(m))return true;
  if (m?.version !== 1 || m.rig !== 'front-cat-v1' || !m.layers) return false;
  return ['head','blink','torso','armLeft','armRight','legLeft','legRight'].every(n => m.layers[n]?.file === `${n}.png` && m.layers[n].width > 0 && m.layers[n].height > 0);
}
function inspectPack(dir, formImage) {
  try {
    const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
    if(!validManifest(manifest)||manifest.formImage!==formImage) return false;
    if(manifest.rig==='pet-mesh-v1'){
      const data=path.resolve(dir,'../..');
      let source;
      if(formImage==='/api/pet-creation/image'){
        const profile=JSON.parse(fs.readFileSync(path.join(data,'pet.json'),'utf8')).petProfile;
        if(profile&&/^pet-creation[\\/][a-f0-9-]+\.png$/.test(profile.file))source=path.join(data,profile.file);
      }else{
        const match=/^\/api\/(evolutions|pet-appearance)\/([a-f0-9-]+\.png)$/.exec(formImage);
        if(match)source=path.join(data,match[1]==='pet-appearance'?'pet-creation':'evolutions',match[2]);
      }
      if(!source||crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')!==manifest.sourceSha256)return false;
      for(const layer of Object.values(manifest.layers))if(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,layer.file))).digest('hex')!==layer.sha256)return false;
    }
    for(const layer of Object.values(manifest.layers)) {
      if(!/^[A-Za-z]+\.png$/.test(layer.file)) return false;
      const bytes=fs.readFileSync(path.join(dir,layer.file));
      if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==layer.width||bytes.readUInt32BE(20)!==layer.height||!bytes.subarray(-12).equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130])))return false;
    }
    return true;
  } catch { return false; }
}
function prepareAnimationDirectory(dir) {
  try {
    fs.mkdirSync(dir,{recursive:true});
    if(typeof process.getuid==='function'&&fs.statSync(dir).uid!==process.getuid())throw Object.assign(Error('Animation directory owner mismatch'),{code:'EACCES'});
    const probe=path.join(dir,'.write-check-'+crypto.randomUUID());
    const fd=fs.openSync(probe,'wx',0o600);fs.closeSync(fd);fs.unlinkSync(probe);
  }
  catch(cause) { const error=new Error('动作素材目录无法写入，请管理员修复目录权限后重新准备动作。');error.diagnostic={stage:'准备动作目录',reason:['EACCES','EPERM'].includes(cause.code)?'permission_denied':'storage_unavailable',code:cause.code||'UNKNOWN'};throw error; }
}
async function generateAnimation({ sourceFile, dir }) {
  if (!localAgent.enabled() && (!process.env.PET_IMAGE_API_KEY || !process.env.PET_IMAGE_BASE_URL)) throw new Error('动作图片服务还没准备好。');
  const python=process.env.PET_IMAGE_PYTHON || (process.platform==='win32'?path.join(__dirname,'.tools/imagegen/Scripts/python.exe'):'python3');
  const cli=process.env.PET_IMAGE_CLI || path.join(__dirname,'scripts/image_gen.py');
  await run(python,['-c',localAgent.enabled()?'from PIL import Image':'import openai; from PIL import Image'],process.env,'检查动作工具');
  fs.mkdirSync(dir,{recursive:true});const prompt=path.join(dir,'prompt.txt'),raw=path.join(dir,'source.png');fs.writeFileSync(prompt,atlasPrompt());
  const env={...process.env,OPENAI_API_KEY:process.env.PET_IMAGE_API_KEY,OPENAI_BASE_URL:process.env.PET_IMAGE_BASE_URL,PYTHONUTF8:'1'};
  // A saved candidate is reused on manual retry; background/packing failures must not charge again.
  if(!fs.existsSync(raw)){
    if(localAgent.enabled())await localAgent.generateImage({prompt:atlasPrompt(),files:[sourceFile],destination:raw});
    else await run(python,[cli,'edit','--model',process.env.PET_IMAGE_MODEL||'gpt-image-2','--image',sourceFile,'--prompt-file',prompt,'--size','1024x1024','--quality','high','--output-format','png','--out',raw],env,'生成新形态动作素材',900000);
  }
  const inspect=path.join(__dirname,'scripts/inspect-evolution.py'),atlas=path.join(dir,'atlas.png');
  let hasAlpha=true;try{await run(python,[inspect,raw,'atlas-alpha'],process.env,'检查动作透明背景');}catch{hasAlpha=false;}
  if(hasAlpha) fs.copyFileSync(raw,atlas);
  else{
    await run(python,[inspect,raw,'atlas-green'],process.env,'检查动作绿幕背景');
    await run(process.env.PET_IMAGE_FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-y','-i',raw,'-vf','format=rgba,colorkey=0x00FF00:0.24:0.10,despill=green:mix=0.8:expand=0.1','-frames:v','1',atlas],process.env,'去除动作素材背景');
    await run(python,[inspect,atlas,'atlas-alpha'],process.env,'检查动作透明结果');
  }
  await run(python,[path.join(__dirname,'scripts/pack-animation.py'),atlas,dir],process.env,'检查并绑定动作素材');
  return JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
}
function createAnimation({state,save,dataDir,generator=generateAnimation,prepareDirectory=prepareAnimationDirectory}) {
  state.animationPacks ||= {};
  for(const record of Object.values(state.animationPacks)) if(record.status==='generating'){record.status='failed';record.error='动作准备中断了，可以再试一次。';}
  let active=false,activeForm=null,queued=null,completion=Promise.resolve();
  function current(){return state.evolution?.forms.at(-1)?.image || state.petProfile?.image || '/assets/zuanzuan.png';}
  function view(formImage=current()){const r=state.animationPacks[formImage];
    if(r) {
      const valid=r.status!=='ready'||(/^[a-f0-9-]+$/.test(r.jobId)&&r.formImage===formImage&&inspectPack(path.join(dataDir,'animations',r.jobId),formImage));
      return {formImage,status:valid?r.status:'failed',error:valid?r.error||'':'当前形态的动作素材不完整，请重新准备动作。',manifest:valid&&r.status==='ready'?`/api/animations/${r.jobId}/manifest.json`:null};
    }
    if(formImage===BUNDLED_FORM && inspectPack(path.join(__dirname,'public/assets/animations/current'),formImage)) return {formImage,status:'ready',manifest:'/assets/animations/current/manifest.json'};
    return {formImage,status:'unavailable',manifest:null};
  }
  function currentForm(){return state.evolution?.forms.at(-1)||(state.petProfile?{level:0,image:state.petProfile.image,file:state.petProfile.file,base:true}:null);}
  function start(form=currentForm()){
    const generic=!!(form?.base||state.petProfile);
    if(generic&&generator===generateAnimation&&!localAgent.enabled()&&(!process.env.PET_IMAGE_API_KEY||!process.env.PET_IMAGE_BASE_URL||process.env.STUDIO_ALLOW_PAID!=='1'))return false;
    if(!form || view(form.image).status==='ready' || state.animationPacks[form.image]?.status==='generating') return false;
    if(active){if(form.image!==activeForm)queued=form;return false;}
    const sourceFile=form.base?path.join(dataDir,form.file):path.join(dataDir,'evolutions',form.file);if(!fs.existsSync(sourceFile)) return false;
    const previous=state.animationPacks[form.image];
    const reuse=previous&&previous.status!=='generating'&&/^[a-f0-9-]+$/.test(previous.jobId)&&(fs.existsSync(path.join(dataDir,'animations',previous.jobId,'source.png'))||fs.existsSync(path.join(dataDir,'animations',previous.jobId,'blink-source.png')));
    const jobId=reuse?previous.jobId:state.petProfile&&/^[a-f0-9-]+$/.test(form.animationJobId||'')?form.animationJobId:crypto.randomUUID(),dir=path.join(dataDir,'animations',jobId);const record={status:'generating',jobId,formImage:form.image,level:form.level};state.animationPacks[form.image]=record;active=true;activeForm=form.image;save();
    completion=(async()=>{try {if(generic)prepareDirectory(path.join(dataDir,'animations'));prepareDirectory(dir);const manifest=await (generic&&generator===generateAnimation?genericMotion.generate:generator)({sourceFile,dir,formImage:form.image});if(!validManifest(manifest))throw new Error('新动作的部件没有准备完整。');
      for(const l of Object.values(manifest.layers)) if(!/^[A-Za-z]+\.png$/.test(l.file)||!fs.existsSync(path.join(dir,l.file)))throw new Error('新动作素材缺失。');
      manifest.formImage=form.image;manifest.motions=['idle','blink'];fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
      if(!inspectPack(dir,form.image))throw new Error('当前形态的绑定或部件图片校验未通过。');
      record.status='ready';record.error='';
    }catch(e){record.status='failed';record.error=e.diagnostic?.reason==='permission_denied'?e.message:'新动作还没准备好，宠物的新形象和成长进度都还在。';record.diagnostic=e.diagnostic||{stage:'绑定动作素材',code:e.code||'VALIDATION_FAILED'};}finally{active=false;activeForm=null;save();const next=queued;queued=null;if(next?.image===current())start(next);}})();return true;
  }
  function asset(url){const match=/^\/api\/animations\/([a-f0-9-]+)\/(manifest\.json|[A-Za-z]+\.png)$/.exec(url);if(!match)return null;
    const record=Object.values(state.animationPacks).find(r=>r.jobId===match[1]&&r.status==='ready');if(!record)return null;
    const file=path.join(dataDir,'animations',match[1],match[2]);return fs.existsSync(file)?file:null;
  }
  // Restored forms can bypass evolution's onForm callback. Start their first preparation once;
  // interrupted or failed jobs remain manual retries and never repeat on restart.
  function ensureCurrent(){const form=currentForm();return !!form&&view().status==='unavailable'?start(form):false;}
  return {view,start,ensureCurrent,asset,settled:()=>completion};
}
module.exports={createAnimation,generateAnimation,atlasPrompt,validManifest,inspectPack,prepareAnimationDirectory};
