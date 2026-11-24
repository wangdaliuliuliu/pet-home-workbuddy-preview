'use strict';
function setTravelPolicy(state,enabled){if(!state.petProfile||state.petProfile.legacyRules)throw Object.assign(Error('原来的宠物继续按原来的方式旅行。'),{status:409});if(typeof enabled!=='boolean')throw Object.assign(Error('选一下要不要每天旅行。'),{status:400});state.travelEnabled=enabled;}
module.exports={setTravelPolicy};
