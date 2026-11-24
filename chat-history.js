const crypto = require('node:crypto');
function migrate(state) {
  if (Array.isArray(state.chatArchive)) return;
  state.chatArchive = (state.chatMessages || []).map(m => ({ ...m, id: crypto.randomUUID(), createdAt: null }));
}
function append(state, message, reply, actionId) {
  const createdAt = Date.now();
  state.chatArchive.push({ id: crypto.randomUUID(), role: 'user', content: message, actionId, createdAt },
    { id: crypto.randomUUID(), role: 'assistant', content: reply, actionId, createdAt });
}
function page(state, cursor) {
  const before = cursor === null ? state.chatArchive.length : Number(cursor);
  if (!Number.isInteger(before) || before < 0 || before > state.chatArchive.length) { const err = new Error('聊天记录位置不正确，请重新打开聊天。'); err.status = 400; throw err; }
  const start = Math.max(0, before - 50);
  const readIndex=state.chatArchive.findIndex(message=>message.id===state.chatReadThrough);
  return { messages: state.chatArchive.slice(start, before).map(({ id, role, content, createdAt, photoIds, referencePhotoId, proactive }, index) => ({ id, role, content, createdAt, ...(proactive?{proactive:true,unread:start+index>readIndex}:{}), ...(photoIds?.length?{photoIds}:{}),...(referencePhotoId?{referencePhotoId}:{}) })), nextBefore: start > 0 ? start : null };
}
function unread(state) {
  const messages=state.chatArchive || [];
  const readIndex=messages.findIndex(message=>message.id===state.chatReadThrough);
  const pending=messages.slice(readIndex+1).filter(message=>message.role==='assistant'&&message.proactive===true);
  return {count:pending.length,latestId:pending.at(-1)?.id||null};
}
function markRead(state,id) {
  const messages=state.chatArchive || [];
  const index=messages.findIndex(message=>message.id===id&&message.role==='assistant'&&message.proactive===true);
  const previous=messages.findIndex(message=>message.id===state.chatReadThrough);
  if(index>previous)state.chatReadThrough=id;
  return unread(state);
}
module.exports = { migrate, append, page, unread, markRead };
