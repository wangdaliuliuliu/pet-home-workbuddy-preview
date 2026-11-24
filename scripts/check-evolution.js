// Read-only release check: never generates art, repairs state, or calls paid services.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {inspectPack}=require('../animation-service');
try{
 const root=path.resolve(__dirname,'..'),data=path.join(root,'data');
 let dir=path.resolve(process.argv[2]||process.env.PET_DATA_DIR||data);
 const portableOwner=path.join(data,'portable-owner.json');
 if(!process.argv[2]&&!process.env.PET_DATA_DIR&&fs.existsSync(portableOwner)){
  const {id}=JSON.parse(fs.readFileSync(portableOwner,'utf8'));
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid portable account');
  dir=path.join(data,'users',id);
 }
 const state=JSON.parse(fs.readFileSync(path.join(dir,'pet.json'),'utf8')),form=state.evolution?.forms.at(-1)||(state.petProfile?{level:0,image:state.petProfile.image,file:state.petProfile.file,base:true}:null);
 if(!form) throw Error('No evolved form to check');
 const record=state.animationPacks?.[form.image];
 const bundled=form.image==='/api/evolutions/0b14c716-3fe7-4472-8605-8c7f785aa1fc.png'&&!record;
 if(!bundled&&(!record||record.status!=='ready'||record.formImage!==form.image||!/^[a-f0-9-]+$/.test(record.jobId)))throw Error('Current form animation is not ready');
 const pack=bundled?path.join(root,'public/assets/animations/current'):path.join(dir,'animations',record.jobId);
 if(!inspectPack(pack,form.image))throw Error('Current form binding or part files are invalid');
 const manifest=JSON.parse(fs.readFileSync(path.join(pack,'manifest.json'),'utf8'));
 if(!form.base&&path.basename(form.file)!==form.file)throw Error('Invalid form filename');
 const portablePython=path.join(root,'.tools','portable-python',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const python=process.env.PET_IMAGE_PYTHON||(fs.existsSync(portablePython)?portablePython:process.platform==='win32'?path.join(root,'.tools/imagegen/Scripts/python.exe'):path.join(root,'.venv/bin/python'));
 if(manifest.rig!=='pet-mesh-v1'||!form.base||form.image.startsWith('/api/pet-appearance/')){
  const imageCheck=spawnSync(python,[path.join(root,'scripts/inspect-evolution.py'),path.join(dir,form.base?'':'evolutions',form.file),'alpha']);
  if(imageCheck.error||imageCheck.status!==0)throw Error('Current form image fails transparent PNG inspection');
 }
 const partCheck=spawnSync(python,manifest.rig==='pet-mesh-v1'?[path.join(root,'scripts/generic-pet-bind.py'),'check',pack]:[path.join(root,'scripts/inspect-animation-pack.py'),pack]);
 if(partCheck.error||partCheck.status!==0)throw Error('Current rig parts fail decoded image inspection');
 console.log(JSON.stringify({complete:true,level:form.level,formImage:form.image,rig:manifest.rig,bindingAndPartFiles:true,imageAlpha:true,browserVisualCheck:'required_separately'}));
}catch(error){console.error('EVOLUTION_INCOMPLETE: '+error.message);process.exitCode=1;}
