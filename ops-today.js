'use strict';
// 运营只读面板的数据源。不写任何文件，不碰 runtime，直接读磁盘上的 pet.json 和串门记录。
const fs = require('node:fs');
const path = require('node:path');
const { chinaDay } = require('./visit-service');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function stamp(value) {
  if (!value) return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
function dayOf(value) {
  const t = stamp(value);
  return t === null ? '' : chinaDay(t);
}
function clockOf(value) {
  const t = stamp(value);
  if (t === null) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(t));
}

function build({ dataDir, accounts, now = Date.now() }) {
  const today = chinaDay(now);
  const people = accounts.users().map(user => {
    const pet = readJson(path.join(accounts.dataPath(user), 'pet.json'), {}) || {};
    const stories = Array.isArray(pet.stories) ? pet.stories : [];
    const mine = stories.filter(item => item && dayOf(item.createdAt) === today);
    const credit = pet.visitCredit && pet.visitCredit.day === today ? pet.visitCredit.left : 0;
    return {
      id: user.id,
      petName: pet.name || user.petName || '未命名',
      childName: user.childName || '',
      login: user.login || '',
      readToday: mine.length,
      readings: pet.readings || 0,
      lastTitle: mine[0]?.title || '',
      lastAt: clockOf(mine[0]?.createdAt),
      visitCredit: credit
    };
  }).sort((a, b) => b.readToday - a.readToday || String(a.petName).localeCompare(String(b.petName), 'zh'));

  const dir = path.join(dataDir, 'visits', 'records');
  let records = [];
  try {
    records = fs.readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => readJson(path.join(dir, name), null))
      .filter(Boolean);
  } catch { records = []; }

  const row = record => ({
    id: record.id,
    from: record.requester?.petName || '',
    to: record.target?.petName || '',
    status: record.status || '',
    title: record.story?.title || '',
    photos: Array.isArray(record.photos) ? record.photos.length : 0,
    place: record.place || ''
  });

  return {
    date: today,
    updatedAt: now,
    people,
    visits: {
      // 今天真正投递到孩子面前的
      shown: records.filter(record => record.storyDate === today).map(row),
      // 今天设定、明天才生效的
      queued: records.filter(record => record.day === today && record.storyDate > today).map(row)
    }
  };
}

module.exports = { build };
