'use strict';
const {date}=require('./work-service');
// Counts are derived from persisted successful issues, never from clicks or paid attempts.
function workStats(states,now=Date.now()){
 const stats=new Map(),today=date(now),get=id=>{if(!stats.has(id))stats.set(id,{activeUsers:0,totalUses:0});return stats.get(id);};
 for(const state of states){
  const active=[...(state.work?.schedule||[])].filter(s=>s.effectiveDate<=today).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate))[0]?.work;
  if(active?.id)get(active.id).activeUsers++;
  const seen=new Set();
  for(const issue of [...Object.values(state.work?.completions||{}).map(c=>({...c,status:'ready'})),...Object.values(state.work?.issues||{})]){if(issue.status!=='ready'||!issue.work?.id||!issue.date)continue;const key=(issue.sourceDate||issue.date)+'|'+issue.work.id;if(seen.has(key))continue;seen.add(key);get(issue.work.id).totalUses++;}
 }
 return stats;
}
function browseWorks(works,states,params=new URLSearchParams(),now=Date.now()){
 const stats=workStats(states,now),q=(params.get('q')||'').trim().toLowerCase().slice(0,100),filter=params.get('format')||'all',sort=params.get('sort')==='popular'?'popular':'new';
 let rows=works.map(w=>({...w,stats:stats.get(w.id)||{activeUsers:0,totalUses:0}})).filter(w=>[w.job.title,w.job.harvest,w.authorName,w.job.careerName].join(' ').toLowerCase().includes(q)&&(filter==='all'||(filter==='audio'?w.job.formats.some(f=>['music','speech'].includes(f)):w.job.formats.includes(filter))));
 rows.sort((a,b)=>sort==='popular'?(b.stats.totalUses-a.stats.totalUses||b.stats.activeUsers-a.stats.activeUsers||b.publishedAt-a.publishedAt||a.id.localeCompare(b.id)):(Number(a.sample)-Number(b.sample)||b.publishedAt-a.publishedAt||a.id.localeCompare(b.id)));
 const pageSize=12,total=rows.length,pages=Math.max(1,Math.ceil(total/pageSize)),page=Math.min(pages,Math.max(1,parseInt(params.get('page'),10)||1));
 return {works:rows.slice((page-1)*pageSize,page*pageSize),total,pages,page,pageSize,sort};
}
module.exports={workStats,browseWorks};
