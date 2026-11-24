function childNames(profile = {}) {
  const fullName = typeof profile.owner === 'string' && profile.owner.trim() ? profile.owner.trim() : '小朋友';
  const nickname = typeof profile.ownerNickname === 'string' && profile.ownerNickname.trim() ? profile.ownerNickname.trim() : fullName === '王拾月' ? '拾月' : fullName;
  return { fullName, nickname };
}
function personalizeText(value, profile) {
  return typeof value === 'string' ? value.replace(/小?主人(?!公)/g, childNames(profile).nickname) : value;
}
function personalizeStory(raw, profile) {
  if (!raw) return raw;
  const story = { ...raw };
  for (const key of ['title', 'intro', 'ending']) story[key] = personalizeText(story[key], profile);
  if (Array.isArray(raw.scenes)) story.scenes = raw.scenes.map(scene => {
    const result = { ...scene };
    for (const key of ['narration', 'caption', 'imagePrompt']) result[key] = personalizeText(result[key], profile);
    return result;
  });
  return story;
}
function unsupportedSharedHistory(value, profile) {
  const escape = name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const { fullName, nickname } = childNames(profile);
  return new RegExp(`(?:主人|${escape(fullName)}|${escape(nickname)})(?:教|带我|告诉我|说过|送给我)|你(?:教过|教我|带我|说过|送给我)`).test(value);
}
module.exports = { childNames, personalizeText, personalizeStory, unsupportedSharedHistory };
