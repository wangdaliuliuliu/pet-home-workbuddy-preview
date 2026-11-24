const crypto = require('node:crypto');
function createMemory({ state, save, extract }) {
  state.memories ||= []; state.memoryRevision ||= 0;
  let queue = Promise.resolve();
  function put(entry, source) {
    if (!entry || !['preference', 'promise', 'story', 'trip', 'photo', 'work'].includes(entry.type) || typeof entry.text !== 'string' || !entry.text.trim()) return;
    const text = entry.text.trim().slice(0, 240), key = String(entry.key || source).slice(0, 80);
    const old = state.memories.find(m => m.key === key && m.type === entry.type);
    const item = { id: old?.id || crypto.randomUUID(), type: entry.type, key, text, source, updatedAt: Date.now() };
    state.memories = state.memories.filter(m => m.id !== old?.id);
    state.memories.push(item); state.memories = state.memories.slice(-100);
  }
  function story(story) {
    if (!story.transcript) return;
    // Immediate excerpt remains available even if the AI extraction service fails.
    put({ type: 'story', key: story.id, text: '讲过的故事摘记：' + story.transcript.slice(0, 210) }, story.id); save();
    learn(story.transcript, story.id, true);
  }
  function learn(text, source, isStory = false) {
    const revision = state.memoryRevision;
    queue = queue.then(async () => {
      if (revision !== state.memoryRevision) return;
      const entries = await extract(text, isStory, state.memories.filter(m => m.type === 'preference' || m.type === 'promise').map(({ key, type, text }) => ({ key, type, text })));
      if (revision !== state.memoryRevision) return; // Deleted memories never reappear from pending requests.
      for (const entry of entries) put(isStory && entry.type === 'story' ? { ...entry, key: source } : entry, source);
      save();
    }).catch(() => { /* Memory failure must not undo a story, reward, or chat reply. */ });
  }
  function remove(id) {
    if (!state.memories.some(m => m.id === id)) return false;
    state.memories = state.memories.filter(m => m.id !== id); state.memoryRevision++;
    // Recent turns may contain the same fact. Clear that context too when explicitly forgetting.
    state.chatMessages = []; save(); return true;
  }
  function relevant(message) {
    const query = message.toLowerCase();
    const words = query.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/g) || [];
    const terms = Array.from(new Set(words.flatMap(w => /^[a-z]/i.test(w) ? [w] : Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2))))).filter(t => !['钻钻', '什么', '可以', '记得', '喜欢'].includes(t));
    const score = m => {
      const haystack = `${m.key} ${m.text}`.toLowerCase();
      return (m.type === 'preference' ? 2 : m.type === 'promise' ? 1 : 0) + terms.reduce((n, t) => n + (haystack.includes(t) ? 4 : 0), 0);
    };
    const ranked = [...state.memories].sort((a, b) => score(b) - score(a) || b.updatedAt - a.updatedAt);
    const selected = ranked.slice(0, 16);
    // For an explicit recall question, give the reply model all saved facts it can match by meaning across languages.
    if (/记得|还记不记得|我(?:最)?喜欢.{0,16}(?:什么|哪个|哪种)|约好.{0,16}(?:什么|哪)|\b(?:remember|favou?rite|did i tell|do i (?:like|love|want)|did we (?:agree|plan|promise)|what (?:had|have|did) i (?:said|say|tell|like|want))\b/i.test(query)) {
      selected.push(...ranked.slice(16).filter(m => m.type === 'preference' || m.type === 'promise'));
    }
    return selected.map(m => ({ type: m.type, key: m.key, text: m.text }));
  }
  return { story, learn, put, remove, relevant, settled: () => queue };
}
module.exports = { createMemory };
