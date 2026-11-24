'use strict';

const MODES = ['zh', 'mixed', 'en'];
const LEVELS = ['Pre-A1', 'A1', 'A2', 'B1'];
const TARGETS = [
  'Use visible objects and familiar actions. Say one very short sentence at a time.',
  'Use simple sentences about familiar things, adding one concrete detail when useful.',
  'Use familiar words to link two ideas about what the child is already talking about.',
  'Use clear everyday English with occasional simple reasons or details.'
];

function settings(value) {
  return {
    mode: MODES.includes(value?.mode) ? value.mode : 'zh',
    level: LEVELS.includes(value?.level) ? value.level : LEVELS[0],
    adaptive: value?.adaptive !== false
  };
}

function instruction(value) {
  const {mode, level} = settings(value);
  if (mode === 'zh') return '';
  const support = mode === 'en'
    ? 'Output English, even if the child uses Chinese. Exact pet and child names may keep their original spelling; all other words must be English. Never translate into Chinese. When needed, repeat with shorter English and offer two easy options.'
    : 'Let Chinese carry the meaning. Naturally use one very short English expression where the context makes it understandable. Reuse familiar expressions without quizzing or requiring English.';
  return support + ' ' + TARGETS[LEVELS.indexOf(level)] + ' Keep the pet expressive. React to the child before asking anything. Never grade the child in the reply.';
}

function enforceLanguage(text, value, names = []) {
  if (settings(value).mode !== 'en') return text;
  let prose=String(text);
  for(const name of [...new Set(names.filter(n=>typeof n==='string'&&n.trim()).map(n=>n.trim()))].sort((a,b)=>b.length-a.length))
    prose=prose.split(name).join('');
  if (/\p{Script=Han}/u.test(prose)||!/[A-Za-z]{2,}/.test(String(text))) throw Object.assign(new Error('English reply needs language repair.'),
    {status:502,stage:'language_check',reason:'language_mismatch'});
  return text;
}

function storyInstruction(value) {
  const {mode}=settings(value);
  if(mode==='zh')return '';
  const language=mode==='en'
    ? 'Write all reader-facing fields in English, including title, intro(s), ending, narration and captions. Romanize pet names faithfully. Use familiar words and short sentences, and maintain the full plot. Write 120–160 spoken words per reader across the intro, two narrations and ending, including at least 40 words in each narration. Each narration may use up to 900 characters. This overrides the base prompt’s language and narration-length guidance.'
    : 'Tell a full story in natural Chinese. Aim for 200–350 Chinese characters of spoken story per reader, excluding captions and titles. Use one or two short English expressions only where a character would naturally say them and the surrounding action makes the meaning clear.';
  return '\nTell a complete, lively story. Use concrete details, reactions and a satisfying ending. The two pictures show distinct moments in the same event. '+language+' The story is for listening straight through. Keep imagePrompt, actionKey and cameraKey in English when requested.';
}

function storyLanguage(story) {
  const narration = [story?.intro, ...Object.values(story?.intros || {}), ...(story?.scenes || []).map(scene => scene.narration), story?.ending].join(' ');
  if (!/\p{Script=Han}/u.test(narration)) return 'en';
  return /\b[a-z]{2,}(?:['’][a-z]+)?[ ,]+[a-z]{2,}\b/i.test(narration) ? 'mixed' : 'zh';
}

function checkStoryLanguage(story,value) {
  const {mode}=settings(value);
  if(mode==='en'){
    const prose=[story.title,story.intro,story.ending,...Object.values(story.intros||{}),
      ...(story.scenes||[]).flatMap(scene=>[scene.narration,scene.caption])];
    if(prose.some(part=>typeof part==='string'&&/\p{Script=Han}/u.test(part)))
      throw Object.assign(new Error('全英文故事需要重新准备。'),{diagnostic:{stage:'故事语言检查',code:'story_language_mismatch',retryable:true}});
  }
  if(mode==='zh'||!Array.isArray(story.scenes)||story.scenes.length!==2)return story;
  if (mode==='mixed' && storyLanguage(story)!=='mixed') {
    throw Object.assign(new Error('中英混合故事需要一句自然的英语。'),{diagnostic:{stage:'故事语言检查',code:'story_language_mismatch',retryable:true}});
  }
  const measure=text=>mode==='en'
    ? (String(text||'').match(/[a-z]+(?:['’-][a-z]+)*/gi)||[]).length
    : (String(text||'').match(/\p{Script=Han}/gu)||[]).length;
  const counts=story.scenes.map(scene=>measure(scene.narration));
  const intros=story.intros?Object.values(story.intros):[story.intro];
  const minimum=mode==='en'?120:200;
  const core=counts.reduce((sum,n)=>sum+n,0)+measure(story.ending);
  if(Math.min(...counts)<(mode==='en'?40:55)||intros.some(intro=>core+measure(intro)<minimum))
    throw Object.assign(new Error(mode==='en'?'英文朗读正文至少需要120词，每幕至少40词。':'混合故事朗读正文至少需要200个汉字，每幕至少55字。'),{diagnostic:{stage:'故事篇幅检查',code:'story_too_short',retryable:true}});
  return story;
}

function forTurn(value, message) {
  const current = settings(value);
  if (!current.adaptive || current.mode === 'zh') return current;
  if (/听不懂|没听清|再说一遍|说慢一点|i don.t understand|please repeat|say that again|speak slower/i.test(message))
    current.level=LEVELS[Math.max(0,LEVELS.indexOf(current.level)-1)];
  return current;
}

function recordEvidence(progress, configured, evidence, now = Date.now()) {
  const current = settings(configured);
  const index = LEVELS.indexOf(current.level);
  if (!current.adaptive || current.mode === 'zh' || index === LEVELS.length - 1 ||
      evidence?.understood !== true || !['home','school','story','plans','play'].includes(evidence.topic)) return current;
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  if (progress.level !== current.level || !Array.isArray(progress.observations)) Object.assign(progress,{level:current.level,observations:[]});
  const observations = progress.observations.filter(item=>now-item.at<14*86400000);
  if (!observations.some(item=>item.day===day&&item.topic===evidence.topic)) observations.push({day,topic:evidence.topic,at:now});
  progress.observations=observations;
  if(new Set(observations.map(item=>item.day)).size>=3&&new Set(observations.map(item=>item.topic)).size>=2)
    return {...current,level:LEVELS[index+1]};
  return current;
}

module.exports = {MODES, LEVELS, settings, instruction, enforceLanguage, storyInstruction, storyLanguage, checkStoryLanguage, forTurn, recordEvidence};
