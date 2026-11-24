const voice = require('./voice-service');
const {personalizeStory,unsupportedSharedHistory}=require('./child-name');

function text(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`旅行故事的${name}没有准备完整。`);
  return value.trim();
}
function validateStory(raw, profile = {}) {
  raw = personalizeStory(raw,profile);
  const english=profile.companion?.mode==='en';
  if (!Array.isArray(raw.scenes) || raw.scenes.length !== 2) throw Error('旅行故事需要两个连贯的瞬间。');
  const story = { version: 2, title: text(raw.title, english?70:28, '标题'), intro: text(raw.intro, english?200:100, '开头'), ending: text(raw.ending, english?200:120, '结尾'),
    scenes: raw.scenes.map(s => ({ narration: text(s.narration, english?900:220, '讲述'), caption: text(s.caption, english?140:65, '配文'),
      actionKey: text(s.actionKey, 300, '动作'), cameraKey: text(s.cameraKey, 160, '视角'), imagePrompt: text(s.imagePrompt, 2200, '画面设计') })) };
  if (story.scenes[0].actionKey.toLowerCase() === story.scenes[1].actionKey.toLowerCase()) throw Error('两个旅行瞬间的动作重复了。');
  if(story.scenes.some(s=>/\btabby\b|\bno\s+(?:clothing|clothes|costume|accessories|wings)\b|\bwithout\s+(?:clothing|clothes|costume|accessories|wings)\b/i.test(s.imagePrompt))) throw Error('画面设计改变了角色外观。主语只用the reference kitten，删除毛色/品种及no clothing/no accessories/no wings等条件，服装饰品以参考图为准。');
  if (!english && story.intro.length + story.ending.length + story.scenes.reduce((n,s) => n+s.narration.length,0) > 650) throw Error('旅行故事太长了。');
  if(unsupportedSharedHistory([story.intro,story.ending,...story.scenes.flatMap(s=>[s.narration,s.caption])].join(' '),profile))throw Error('不能编造与孩子的共同经历。请只讲这次旅行中宠物自己的行动、观察、想法和感受。');
  return story;
}
async function planStory(input) {
  let feedback = input.feedback || '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const story = validateStory(await voice.planTravelStory({ ...input, feedback }),input);
      return story;
    } catch (error) { feedback = error.message; if (attempt === 1) throw error; }
  }
}
function publicStory(story) {
  return story ? { title: story.title, intro: story.intro, ending: story.ending,
    scenes: story.scenes.map(({ narration, caption }) => ({ narration, caption })) } : null;
}
function segmentText(story, index) {
  return index === 0 ? `${story.intro}\n${story.scenes[0].narration}` : `${story.scenes[1].narration}\n${story.ending}`;
}
async function planStoryFromPhotos(input) { return validateStory(await voice.planTravelStoryFromPhotos(input),input); }
module.exports = { validateStory, planStory, planStoryFromPhotos, publicStory, segmentText };
