// Run as the application account, not root: verifies actual runtime write access without image generation.
const path=require('node:path');
const {prepareAnimationDirectory}=require('../animation-service');
try {prepareAnimationDirectory(path.join(process.env.PET_DATA_DIR||path.join(__dirname,'../data'),'animations'));console.log('ANIMATION_STORAGE_WRITABLE');}
catch(e){console.error(JSON.stringify(e.diagnostic));process.exitCode=1;}
