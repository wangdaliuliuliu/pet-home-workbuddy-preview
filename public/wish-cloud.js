(function(root){
'use strict';
const icons=['📚','🏃','<svg viewBox="0 0 64 64" width="40" height="40" fill="none" aria-hidden="true"><path d="M14 25C-1 63 65 63 50 25" stroke="#667d66" stroke-width="4" stroke-linecap="round"/><path d="M11 12l8 3-5 17-8-3zM45 15l8-3 5 17-8 3z" fill="#dc7959" stroke="#68564a" stroke-width="2"/></svg>','🌙','✏️','🔤','🎨','🦷','💧','🎒'];
const names=['每天读书','每天运动','每天跳绳','按时睡觉','每天练字','读读英语','每天画画','认真刷牙','喝够水','收好书包'];
const colors=['#f5d889','#c4e3bf','#f3b6a0','#d3c5ee','#b9dfe5','#efc9d8','#d7df9c'];
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function html(tasks,selected){return `<section class="wish-garden" aria-label="心愿泡泡云"><div class="wish-sky"><span class="sky-star star-one">✦</span><span class="sky-star star-two">✧</span><span class="sky-star star-three">✦</span><div class="wish-orbit" role="group" aria-label="轻轻拖动，也可以直接点选">${tasks.map((t,i)=>`<button type="button" class="wish-bubble ${t===selected?'is-picked':''}" data-task="${escape(t)}" data-wish-index="${i}" aria-label="${escape(t)}" aria-pressed="${t===selected}" style="--bubble:${colors[i%colors.length]}"><span class="bubble-shine"></span><span class="bubble-icon" aria-hidden="true">${icons[i%icons.length]}</span><strong>${names[i]||escape(t)}</strong><span class="bubble-check" aria-hidden="true">✓</span></button>`).join('')}</div></div><div class="wish-cloud-hint">轻轻拖一拖 · 点泡泡选心愿</div><p class="wish-chosen" role="status">${selected?'✓ '+escape(selected):'点一个泡泡，收下你的心愿'}</p></section>`;}
let cleanup=null,orientation={yaw:.35,pitch:-.18};
function mount(container,tasks,selected){
 if(cleanup)cleanup();const orbit=container.querySelector('.wish-orbit');if(!orbit)return;
 const bubbles=[...orbit.querySelectorAll('.wish-bubble')];let drag=null,suppressUntil=0,frame=0,last=0,vx=0,vy=0,target=null;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
 const points=bubbles.map((_,i)=>{const y=1-2*(i+.5)/bubbles.length,r=Math.sqrt(1-y*y),a=i*Math.PI*(3-Math.sqrt(5));return{x:Math.cos(a)*r,y,z:Math.sin(a)*r}});
 const chosen=tasks.indexOf(selected);
 function nearest(value,current){return current+Math.atan2(Math.sin(value-current),Math.cos(value-current))}
 if(chosen>=0){const p=points[chosen];target={yaw:nearest(Math.atan2(-p.x,p.z),orientation.yaw),pitch:nearest(Math.atan2(p.y,Math.hypot(p.x,p.z)),orientation.pitch)};if(reduced){orientation={...target};target=null}}
 function pose(){const w=orbit.clientWidth,h=orbit.clientHeight,radius=Math.min(w*.34,h*.34),cy=Math.cos(orientation.yaw),sy=Math.sin(orientation.yaw),cp=Math.cos(orientation.pitch),sp=Math.sin(orientation.pitch);
 bubbles.forEach((b,i)=>{const p=points[i],x=p.x*cy+p.z*sy,z0=p.z*cy-p.x*sy,y=p.y*cp-z0*sp,z=p.y*sp+z0*cp,depth=(z+1)/2;
 b.style.setProperty('--x',x*radius+'px');b.style.setProperty('--y',y*radius+'px');b.style.setProperty('--scale',.55+depth*.70);b.style.opacity=String(.38+depth*.62);b.style.zIndex=String(Math.round(depth*100)+1);b.dataset.depth=depth.toFixed(3);
 });}
 function tick(time){if(!orbit.isConnected)return;const dt=Math.min(32,time-last||16);last=time;if(target&&!drag){const blend=1-Math.exp(-dt/95);orientation.yaw+=(target.yaw-orientation.yaw)*blend;orientation.pitch+=(target.pitch-orientation.pitch)*blend;if(Math.abs(target.yaw-orientation.yaw)+Math.abs(target.pitch-orientation.pitch)<.0001){orientation={...target};target=null}}else if(!drag&&!reduced){orientation.yaw+=vx;orientation.pitch+=vy;vx*=.94;vy*=.94;if(Math.abs(vx)+Math.abs(vy)<.0002){vx=0;vy=0}}pose();frame=requestAnimationFrame(tick)}
 orbit.addEventListener('pointerdown',e=>{if(e.button!==0)return;target=null;vx=vy=0;drag={id:e.pointerId,x:e.clientX,y:e.clientY,moved:false};});
 orbit.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.moved&&Math.hypot(dx,dy)<6)return;drag.moved=true;orbit.setPointerCapture(e.pointerId);orbit.classList.add('is-dragging');vx=dx*.009;vy=-dy*.009;orientation.yaw+=vx;orientation.pitch+=vy;drag.x=e.clientX;drag.y=e.clientY;pose()});
 function stop(e){if(!drag||e.pointerId!==drag.id)return;if(drag.moved)suppressUntil=Date.now()+350;drag=null;orbit.classList.remove('is-dragging')}
 orbit.addEventListener('pointerup',stop);orbit.addEventListener('pointercancel',stop);orbit.addEventListener('click',e=>{if(Date.now()<suppressUntil){e.preventDefault();e.stopPropagation()}},true);
 orbit.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();target=null;orientation.yaw+=e.key==='ArrowRight'?.3:e.key==='ArrowLeft'?-.3:0;orientation.pitch+=e.key==='ArrowDown'?.3:e.key==='ArrowUp'?-.3:0;pose()});
 const observer=new ResizeObserver(pose);observer.observe(orbit);cleanup=()=>{cancelAnimationFrame(frame);observer.disconnect()};pose();frame=requestAnimationFrame(tick);
}
root.WishCloud={html,mount};
})(globalThis);
