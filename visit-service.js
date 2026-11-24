'use strict';
// 串门：两个账号共享一条故事记录，只生成一次，各按自己的资格决定投不投递。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {reserveStoryEvent}=require('./story-events');
const companion = require('./companion-language');
const { execFileSync } = require('node:child_process');

// 一条串门从开始到出完图最多十几分钟；超过半小时还停在 generating，说明生成它的进程已经不在了。
const STALE_MS = 30 * 60 * 1000;

function chinaDay(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
function nextDay(date) {
  return chinaDay(Date.parse(date + 'T12:00:00+08:00') + 86400000);
}
function text(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`串门故事的${name}没有准备完整。`);
  return value.trim();
}
function validateVisitStory(raw, companion) {
  if (!Array.isArray(raw.scenes) || raw.scenes.length !== 2) throw Error('串门故事需要两个连贯的瞬间。');
  const intros = raw.intros || {};
  return {
    title: text(raw.title, 28, '标题'),
    // 玩法主题单独记，用来避免"今天玩蝴蝶、明天还玩蝴蝶"；模型漏写时退化成标题前几个字。
    theme: typeof raw.theme === 'string' && raw.theme.trim() ? raw.theme.trim().slice(0, 12) : text(raw.title, 28, '标题').slice(0, 12),
    ending: text(raw.ending, 120, '结尾'),
    intros: { requester: text(intros.requester, 100, '开头'), target: text(intros.target, 100, '开头') },
    scenes: raw.scenes.map(s => ({
      narration: text(s.narration, companion?.mode==='en'?900:220, '讲述'),
      caption: text(s.caption, 65, '配文'),
      actionKey: text(s.actionKey, 300, '动作'),
      cameraKey: text(s.cameraKey, 160, '视角'),
      imagePrompt: text(s.imagePrompt, 2200, '画面设计')
    }))
  };
}
function publicVisitStory(story, role) {
  if (!story) return null;
  return {
    title: story.title,
    intro: story.intros?.[role] || story.intros?.target || '',
    ending: story.ending,
    scenes: story.scenes.map(({ narration, caption }) => ({ narration, caption }))
  };
}

// 串门不是打架。模型很爱写"抢同一样东西"，所以写完也要自己核对一遍：
// 出现争抢、对峙、吵起来的词，就带着这句话再写一次，而不是只靠提示词求它。
const CONFLICT_WORDS = ['抢', '夺', '争', '吵', '打架', '打斗', '扭打', '较劲', '拉锯', '比赛', '输赢', '较量', '对峙', '推搡', '按住', '凶'];
const CONFLICT_EN = ['tug of war', 'tug-of-war', 'pulling against', 'wrestl', 'fighting over', 'glaring'];
function conflicting(story) {
  const parts = [story?.title, story?.theme, story?.ending].concat(
    (story?.scenes || []).flatMap(scene => [scene?.narration, scene?.caption, scene?.imagePrompt])
  );
  for (const part of parts) {
    const text = String(part || '');
    if (!text) continue;
    for (const word of CONFLICT_WORDS) if (text.includes(word)) return word;
    const lower = text.toLowerCase();
    for (const word of CONFLICT_EN) if (lower.includes(word)) return word;
  }
  return '';
}
// 模型最爱滑回的两种套路：开头"推开门"报幕，结尾"两只并排"合影。
// 这里只核对并记进诊断，不重写——重写会让等待变长，先看提示词管不管用。
const OPENING_FORMULA = /推开门|推了推门|门开了|走进来|走了进来|来到.{1,8}门口|到门口时/;
const ENDING_FORMULA = /^(两只|它们|两个小家伙)/;
function formulaic(story) {
  if (OPENING_FORMULA.test(String(story?.intros?.requester || ''))) return '开头报幕';
  const ending = String(story?.ending || '');
  if (ENDING_FORMULA.test(ending) || /两只(齐齐|都|一起)|并排/.test(ending)) return '结尾合影';
  return '';
}
// 有些孩子把宠物做成了人类小孩或别的角色。写故事前先看一眼它到底长什么样，
// 否则会写出"用头顶""叼起来""尾巴摇"这种它根本做不到的动作。
async function anatomyOf(person,describe) {
  if (!describe || !person?.formFile) return '';
  try {
    const bytes = fs.readFileSync(person.formFile);
    const type = /\.jpe?g$/i.test(person.formFile) ? 'jpeg' : /\.webp$/i.test(person.formFile) ? 'webp' : 'png';
    const text = await describe([`data:image/${type};base64,${bytes.toString('base64')}`], '只客观描述这个角色实际可见的身体：它是人类小孩、动物还是其他；有没有手、爪、翅膀、尾巴、耳朵；穿什么衣服。不要编故事，不要根据名字推测品种。');
    return String(text || '').slice(0, 300);
  } catch { return ''; }
}
async function planVisitDraft({host,guest,place,themeHistory=[],storyEvent,planner,describe}){
  const hostAnatomy=await anatomyOf(host,describe);
  const guestAnatomy=await anatomyOf(guest,describe);
  const writeStory=avoid=>planner({
    requesterPet:guest.petName,targetPet:host.petName,place,
    themeHistory:themeHistory.map(item=>`${item.date||''} ${item.text||''}`.trim()).slice(-8),
    storyEvent,avoid,requesterAnatomy:guestAnatomy,targetAnatomy:hostAnatomy
  });
  let story=validateVisitStory(await writeStory(''));
  let conflictRetried=false;
  for(let attempt=0;attempt<2;attempt++){
    const bad=conflicting(story);
    if(!bad)break;
    story=validateVisitStory(await writeStory(
      `上一篇写成了两只在"${bad}"，这是打闹故事，不算。这一篇必须两只站一边、没有冲突：`+
      '趣味来自误会、巧合、帮倒忙或意外，不许有抢、争、吵、对峙、较劲、比赛输赢。'
    ));
    conflictRetried=true;
  }
  return {story,conflictRetried,conflict:conflicting(story),formula:formulaic(story)};
}

function createVisits({ dataDir, now = () => Date.now(), people, generator, planner, narrator, reviewer = null, describe = null }) {
  const root = path.join(dataDir, 'visits');
  const recordDir = path.join(root, 'records');
  const mediaDir = path.join(root, 'media');
  const narrationDir = path.join(root, 'narrations');
  const avatarDir = path.join(root, 'avatars');
  fs.mkdirSync(recordDir, { recursive: true });
  const jobs = new Map();
  const narrationJobs = new Map();
  // 缩略图：按原图 mtime 缓存，内存里也留一份，串门面板打开时不重复读盘。
  const avatarMemory = new Map();
  const avatarBroken = new Set();
  // 每次打开页面都会问一次"今天有几篇"，缓存几秒，免得记录攒多以后每次都读一遍目录。
  let cache = null, cacheAt = 0;

  const recordPath = id => path.join(recordDir, id + '.json');
  function read(id) {
    try { return JSON.parse(fs.readFileSync(recordPath(id), 'utf8')); } catch { return null; }
  }
  function write(record) {
    const file = recordPath(record.id);
    fs.writeFileSync(file + '.tmp', JSON.stringify(record, null, 2));
    fs.renameSync(file + '.tmp', file);
    cache = null;
  }
  function all() {
    if (cache && now() - cacheAt < 5000) return cache;
    let list = [];
    try {
      list = fs.readdirSync(recordDir).filter(f => f.endsWith('.json')).map(f => read(f.slice(0, -5))).filter(Boolean);
    } catch { list = []; }
    cache = list;
    cacheAt = now();
    return list;
  }
  function roleOf(record, userId) {
    if (record.requester.userId === userId) return 'requester';
    if (record.target.userId === userId) return 'target';
    return '';
  }
  // 对方的宠物缩略图：72×72 透明 PNG，前端只显示 44px，一张几 KB。
  function avatar(userId) {
    const person = people.get(userId);
    if (!person || !person.formFile) return null;
    let stat;
    try { stat = fs.statSync(person.formFile); } catch { return null; }
    const version=crypto.createHash('sha256').update(person.formFile).digest('hex').slice(0,12);
    const key = `${userId}-${version}-${Math.round(stat.mtimeMs)}-${stat.size}`;
    const hit = avatarMemory.get(userId);
    if (hit && hit.key === key) return hit.file;
    const thumb = path.join(avatarDir, key + '.png');
    if (!fs.existsSync(thumb) && !avatarBroken.has(userId)) {
      try {
        fs.mkdirSync(avatarDir, { recursive: true });
        const script = path.join(__dirname, 'scripts', 'make-avatar.py');
        const run = bin => execFileSync(bin, [script, person.formFile, thumb, '72'], { timeout: 15000, stdio: 'ignore' });
        try { run(process.env.PET_PYTHON || 'python3'); } catch { run('python'); }
      } catch {
        // 没有 Pillow 就退回原图，缩不缩都能显示，只是多占点内存。
        avatarBroken.add(userId);
      }
    }
    const file = fs.existsSync(thumb)
      ? { file: thumb, type: 'image/png' }
      : { file: person.formFile, type: /\.jpe?g$/i.test(person.formFile) ? 'image/jpeg' : 'image/png' };
    avatarMemory.set(userId, { key, file });
    return file;
  }
  function targets(userId) {
    return people.list().filter(u => u.id !== userId && u.petReady)
      .sort((a,b) => (Number.isFinite(b.lastLoginAt)?b.lastLoginAt:0)-(Number.isFinite(a.lastLoginAt)?a.lastLoginAt:0))
      .map(u => ({ id: u.id, petName: u.petName, childName: u.childName, avatar: `/api/visit/avatar/${u.id}`+(u.formImage?`?v=${encodeURIComponent(u.formImage)}`:'') }));
  }
  // 给写故事的人看最近"做过什么"。只记动作，不记地点：同一个地方可以反复去，同一件事不该反复做。
  // 故事没有"记忆"：每次都是单独一次请求，所以"不重样"只能靠这里把真实清单取出来塞进去。
  // 取哪些：这条故事的两家都算——我参加过的串门、伙伴跟别人串过的、以及各自独自出门的故事
  // （故事本里是混在一起给孩子看的）。顺序必须按日期排，"最近"才是真的最近。
  function recentThemes(userId,sharedOnly=false) {
    const ids = new Set([userId]);
    for (const record of all()) {
      if (record.requester.userId === userId) ids.add(record.target.userId);
      else if (record.target.userId === userId) ids.add(record.requester.userId);
    }
    const items = [];
    for (const record of all()) {
      if (!record.story) continue;
      if(sharedOnly&&(!roleOf(record,userId)||record.storyDate>chinaDay(now())))continue;
      if (!ids.has(record.requester.userId) && !ids.has(record.target.userId)) continue;
      // 历史只记"做了什么"：玩法 + 当时的故事名（用来看关系和结果），不单独记地点。
      const action = record.theme || record.story.theme || record.story.title || '';
      if (!action) continue;
      const title = record.story.title && record.story.title !== action ? `（${record.story.title}）` : '';
      items.push({ date: record.storyDate || record.day || '', text: `${action}${title}` });
    }
    for (const id of ids) {
      if(sharedOnly&&id!==userId)continue;
      const person = people.get(id);
      for (const story of person?.recentStories || []) {
        // 独自出门记它当天真正在做的事（activity），不是"去了哪里"。
        const action = story?.action || story?.title || '';
        if (!action) continue;
        const title = story.title && story.title !== action ? `（${story.title}）` : '';
        items.push({ date: story.date || '', text: `${action}${title}` });
      }
    }
    const seen = new Set();
    return items
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .filter(item => (seen.has(item.text) ? false : seen.add(item.text)))
      .slice(-10);
  }
  // 模型换个说法就能绕过"不要重复"，所以写完还要自己核对一次；只核对，不猜语义。
  function send(userId, targetId, options = {}) {
    const force = options.force === true;
    const me = people.get(userId), other = people.get(targetId);
    if (!me || !me.petReady) throw Object.assign(Error('先给宠物取好名字，才能出门。'), { status: 409 });
    if (!other || !other.petReady) throw Object.assign(Error('这个小伙伴还没有在家呢。'), { status: 404 });
    if (targetId === userId) throw Object.assign(Error('自己的家就不用串啦。'), { status: 400 });
    const today = chinaDay(now());
    // 只有"今天约明天"的记录才算今天出过门。运营补投的当天故事（storyDate 就是今天）
    // 不该占掉玩家今天的名额，否则他当天再点串门就永远被拒。
    if (!force && all().some(r => r.day === today && r.storyDate !== today && r.requester.userId === userId)) throw Object.assign(Error('今天已经出过一次门啦，明天再去吧。'), { status: 409 });
    const record = {
      id: crypto.randomUUID(),
      day: today,
      // 运营重做当天故事时可以直接指定投递日，正常入口永远是"明天"。
      storyDate: options.storyDate || nextDay(today),
      requester: { userId, petName: me.petName, childName: me.childName },
      target: { userId: targetId, petName: other.petName, childName: other.childName },
      // 串门的地点是主人最常在的地方：自己的房间、常去的地方，最后才是"某某的小屋"。
      place: other.homePlace || other.familiarPlace || `${other.petName}的小屋`,
      theme: '',
      status: options.external ? 'awaiting-client' : 'pending',
      ...(options.external?{external:true}:{}),
      story: null,
      photos: [],
      error: '',
      operator: force || undefined,
      createdAt: now()
    };
    if(options.external){
      snapshotExternal(record,me,other);
      record.refreshReferencesOnDue=true;
    }
    write(record);
    return view(record, userId);
  }
  function edition(record, mode) {
    if (!record.story) return { story: null, edition: null };
    if (!mode || mode === 'original' || mode === (record.storyLanguage || companion.storyLanguage(record.story))) {
      return { story: record.story, edition: 'original' };
    }
    try {
      const story = JSON.parse(fs.readFileSync(path.join(narrationDir, record.id, mode + '.json'), 'utf8'));
      return { story, edition: mode };
    } catch {
      return { story: null, edition: null };
    }
  }

  async function prepareNarration(record, mode) {
    if (edition(record, mode).story) return;
    if(record.external)throw Error('这次先听发起者准备好的版本。');
    const key = `${record.id}:${mode}`;
    if (narrationJobs.has(key)) return narrationJobs.get(key);
    const job = (async () => {
      const source = {
        title: record.story.title, intros: record.story.intros, ending: record.story.ending,
        scenes: record.story.scenes.map(({ narration, caption }) => ({ narration, caption }))
      };
      const raw = await narrator(source, mode);
      if (raw.scenes?.length !== source.scenes.length) throw Error('讲述的两幕没有准备完整。');
      const story = {
        title: text(raw.title, 70, '标题'), ending: text(raw.ending, 200, '结尾'),
        intros: {
          requester: text(raw.intros?.requester, 200, '客人的开头'),
          target: text(raw.intros?.target, 200, '主人的开头')
        },
        scenes: raw.scenes.map(scene => ({ narration: text(scene.narration, 900, '讲述'), caption: text(scene.caption, 140, '配文') }))
      };
      companion.checkStoryLanguage(story, {mode});
      if (mode === 'zh' && companion.storyLanguage(story) !== 'zh') throw Error('中文讲述没有准备完整。');
      const dir = path.join(narrationDir, record.id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, mode + '.json');
      fs.writeFileSync(file + '.tmp', JSON.stringify(story));
      fs.renameSync(file + '.tmp', file);
    })().catch(error => {
      error.diagnostic ||= {stage:'故事语言准备',code:error.code==='EACCES'?'story_language_storage_denied':'story_language_generation_failed',retryable:true};
      try {
        const dir=path.join(narrationDir,record.id);fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,mode+'.error.json'),JSON.stringify({at:new Date().toISOString(),mode,...error.diagnostic}));
      } catch {}
      throw error;
    }).finally(() => narrationJobs.delete(key));
    narrationJobs.set(key, job);
    return job;
  }

  function view(record, userId, mode) {
    const role = roleOf(record, userId);
    if (!role) return null;
    const other = role === 'requester' ? record.target.petName : record.requester.petName;
    const selected = edition(record, mode);
    return {
      id: record.id,
      day: record.day,
      storyDate: record.storyDate,
      role,
      otherPet: other,
      place: record.place,
      status: record.status,
      error: record.error || '',
      story: publicVisitStory(selected.story, role),
      edition: selected.edition,
      originalAvailable: Boolean(record.story),
      photos: record.photos.map((photo, index) => ({
        url: `/api/visit/${record.id}/photo/${index}`,
        caption: selected.story?.scenes?.[index]?.caption || (mode ? '' : photo.caption || '')
      })),
      title: selected.story?.title || `和${other}的一天`
    };
  }
  // 该账号在 storyDate 这天应该看到几条：只按自己的资格放行，与另一个人有没有资格无关。
  function forDate(userId, date, eligible, mode) {
    return all()
      .filter(r => r.storyDate === date && roleOf(r, userId))
      .filter(r => eligible !== false||r.external)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(r => view(r, userId, mode))
      .filter(Boolean);
  }
  // 这天该我看到的串门里，有没有一篇能顶掉当天旅行故事的：失败的记录不算，
  // 否则它会既挡住旅行故事、自己又交不出来，孩子当天就什么都没有了。
  function hasFor(userId, date) {
    return all().some(r => r.storyDate === date && roleOf(r, userId) && r.status !== 'failed');
  }
  // 运营预览：本来要等到 storyDate 才投递的故事，如果记录上标了 preview，当天就先放出来。
  // 只放 ready 的、只放属于我自己的；storyDate 一过就自然不再命中，不会长期多开一个入口。
  function previewFor(userId, today, mode) {
    const date = nextDay(today);
    return all()
      .filter(r => r.storyDate === date && r.preview === true && r.status === 'ready' && roleOf(r, userId))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(r => view(r, userId, mode))
      .filter(Boolean);
  }
  function listFor(userId, mode, visible = () => true) {
    return all()
      .filter(r => roleOf(r, userId) && r.status === 'ready' && visible(r))
      .sort((a, b) => b.storyDate.localeCompare(a.storyDate) || String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(r => view(r, userId, mode))
      .filter(Boolean);
  }
  async function generate(record, allowResubmit) {
    const host = record.formReferences?.host || people.get(record.target.userId);
    const guest = record.formReferences?.guest || people.get(record.requester.userId);
    if (!host || !guest) throw Error('有一家的宠物暂时找不到。');
    const reference=({petName,formFile,formImage,customPet})=>({petName,formFile,formImage,customPet});
    record.formReferences ||= {host:reference(host),guest:reference(guest)};
    record.status = 'generating';
    record.startedAt = now();
    record.error = '';
    write(record);
    // 重试时沿用已经写好的故事，别让第二张图失败把第一张和故事一起作废。
    let story = record.story;
    if (!story) {
      const history = recentThemes(record.requester.userId);
      // 历史太短时模型会退回默认题材（客厅靠垫、教转圈），给它一个具体的起手物，别让它自由发挥。
      record.storyEvent ||= reserveEvent('visit:'+record.id,record.storyDate,[record.requester.userId,record.target.userId]);
      write(record);
      const draft=await planVisitDraft({host,guest,place:record.place,themeHistory:history,storyEvent:record.storyEvent,planner,describe});
      story=draft.story;
      if(draft.conflictRetried)record.conflictRetried=true;
      if(draft.conflict||draft.formula)record.diagnostic={...(record.diagnostic||{}),...(draft.conflict?{conflict:draft.conflict}:{}),...(draft.formula?{formula:draft.formula}:{})};
      record.storyLanguage = 'zh';
    }
    record.theme = story.theme;
    record.story = story;
    write(record);
    const dir = path.join(mediaDir, record.id);
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 2; index++) {
      const work = path.join(dir, 'work-' + index);
      // 已经出好的那张直接留着。
      const done = path.join(dir, index + '.jpg');
      if (fs.existsSync(done) && fs.statSync(done).size > 0) {
        record.photos[index] = { index };
        continue;
      }
      // 两张参考图各管一只：主人的图决定主人，客人的图决定客人。
      const trip = {
        place: record.place,
        story,
        hostName: host.petName,
        guestName: guest.petName,
        hostCustom: !!host.customPet,
        guestCustom: !!guest.customPet
      };
      const bytes = await generator({
        formFile: host.formFile,
        formImage: host.formImage,
        guestFile: guest.formFile,
        guestImage: guest.formImage,
        trip, index, dir: work, feedback: '', allowResubmit
      });
      fs.writeFileSync(done+'.tmp',bytes);
      fs.renameSync(done+'.tmp',done);
      record.photos[index] = { index };
      write(record);
    }
    record.status = 'ready';
    record.finishedAt = now();
    // 前几轮失败留下的诊断到这一步就过期了，别让运营后台拿旧报错吓人。
    delete record.diagnostic;
    delete record.startedAt;
    delete record.deferredPhoto;
    write(record);
    return record;
  }
  function due(record) {
    return (record.status==='pending' && (!record.retryAt || now()>=record.retryAt))
      || (record.status==='failed' && record.retryAt && now()>=record.retryAt)
      || (record.status==='generating' && now()-(record.startedAt||0)>=STALE_MS);
  }
  // 两边看到同一份任务。只有已知可安全重试的失败才会再次排队。
  function ensure(record, manual=false) {
    if (!record) return Promise.resolve(record);
    if (record.external) return Promise.resolve(record);
    if (jobs.has(record.id)) return jobs.get(record.id);
    if (!due(record) && !(manual&&record.status==='failed')) return Promise.resolve(record);
    delete record.retryAt;
    if (record.status==='generating') {
      if(record.recoveredOnce){
        record.status='failed';record.error='这次串门准备中断了，已经画好的照片会留下。';
        record.diagnostic={stage:'串门故事',code:'visit_interrupted_again'};delete record.startedAt;write(record);
        return Promise.resolve(record);
      }
      record.recoveredOnce=true;
    }
    const job = generate(record,manual)
      .catch(error => {
        record.status = 'failed';
        record.error = '这次串门的故事还没准备好，明天可以再试一次。';
        // 上游（画图/写故事）自己的诊断要留着，否则线上只看到一句没用的失败提示。
        record.diagnostic = { stage: '串门故事', reason: String(error && error.message || '').slice(0, 300), ...(error && error.diagnostic ? { upstream: error.diagnostic } : {}) };
        const deferred = ['image_queue_timeout','image_queue_full','image_local_normalize_failed']
          .includes(error?.diagnostic?.code);
        if(error?.diagnostic?.retryable&&(record.autoFailures||0)<2){
          record.autoFailures=(record.autoFailures||0)+1;
          record.retryAt=now()+(deferred ? [5,20] : [30,120])[record.autoFailures-1]*60000;
          if(deferred){record.status='pending';record.error='';record.deferredPhoto=true;}
        }
        if(record.status==='failed')delete record.deferredPhoto;
        delete record.startedAt;
        try { write(record); } catch {}
        return record;
      })
      .finally(() => jobs.delete(record.id));
    jobs.set(record.id, job);
    return job;
  }
  async function ensureForDate(userId, date) {
    const pending = all().filter(r => r.storyDate === date && roleOf(r, userId) && due(r));
    for (const record of pending) await ensure(record);
  }
  function resumeDeferred() {
    const record = all().filter(r=>r.deferredPhoto && !jobs.has(r.id) && due(r))
      .sort((a,b)=>(a.retryAt||a.startedAt)-(b.retryAt||b.startedAt))[0];
    return ensure(record);
  }
  function photo(recordId, index, userId) {
    const record = read(recordId);
    if (!record || !roleOf(record, userId)) return null;
    const file = path.join(mediaDir, record.id, Number(index) + '.jpg');
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  }
  // 发起串门的人先看到自己那篇，被串门的人当天没有资格就收不到，也不会被通知。
  function reserveEvent(key,date,roles){return reserveStoryEvent(dataDir,{key,date,roles});}
  function snapshotExternal(record, requester, target){
    const dir=path.join(mediaDir,record.id);
    fs.mkdirSync(dir,{recursive:true});
    function retain(source,name){
      const destination=path.join(dir,name+'.png');
      if(!source){if(fs.existsSync(destination))fs.unlinkSync(destination);return;}
      const pending=destination+'.'+crypto.randomUUID();
      try{
        try{fs.linkSync(source,pending);}catch{fs.copyFileSync(source,pending);}
        fs.renameSync(pending,destination);
      }finally{if(fs.existsSync(pending))fs.unlinkSync(pending);}
    }
    retain(requester.formFile,'requester');
    retain(target.formFile,'target');
    retain(target.roomFile,'room');
    record.roomId=target.roomId||null;
    record.requesterCustom=!!requester.customPet;
    record.targetCustom=!!target.customPet;
  }
  function externalWork(userId){
    return all().filter(r=>r.external&&r.status==='awaiting-client'&&r.requester.userId===userId)
      .map(r=>{
        const dueToday=r.storyDate<=chinaDay(now());
        if(dueToday&&r.refreshReferencesOnDue){
          const requester=people.get(r.requester.userId),target=people.get(r.target.userId);
          if(!requester||!target)throw Error('有一家的宠物暂时找不到。');
          snapshotExternal(r,requester,target);
          delete r.refreshReferencesOnDue;
          write(r);
        }
        if(dueToday&&!r.storyEvent){r.storyEvent=reserveEvent('visit:'+r.id,r.storyDate,[r.requester.userId,r.target.userId]);write(r);}
        return {id:r.id,requester:r.requester.petName,target:r.target.petName,place:r.place,roomId:r.roomId,day:r.day,storyDate:r.storyDate,
          room:fs.existsSync(path.join(mediaDir,r.id,'room.png')),storyEvent:r.storyEvent,themeHistory:dueToday?recentThemes(userId,true):undefined,
          requesterCustom:r.requesterCustom??!!people.get(r.requester.userId)?.customPet,targetCustom:r.targetCustom??!!people.get(r.target.userId)?.customPet};
      });
  }
  function externalDay(userId,targetId){
    const record=all().find(r=>r.day===chinaDay(now())&&r.storyDate!==r.day&&r.requester.userId===userId);
    if(targetId&&record?.external&&record.target.userId===targetId)return view(record,userId);
    return targetId?null:!record;
  }
  function externalAsset(userId,id,asset){
    const r=read(id);
    if(!r?.external||r.requester.userId!==userId||!['requester','target','room'].includes(asset))return null;
    const file=path.join(mediaDir,id,asset+'.png');return fs.existsSync(file)?fs.readFileSync(file):null;
  }
  function submitExternal(userId,id,data){
    const r=read(id);
    if(!r?.external||r.requester.userId!==userId)throw Object.assign(Error('没有这次串门。'),{status:404});
    if(r.status==='ready')return view(r,userId);
    const mode=['zh','mixed','en'].includes(data.mode)?data.mode:'zh';
    const story=validateVisitStory(data.story,{mode});
    const editions={};
    for(const lang of ['mixed','en']){
      const raw=data.editions?.[lang];
      if(!raw||!Array.isArray(raw.scenes)||raw.scenes.length!==2)continue;
      const variant={
        title:text(raw.title,70,'标题'),ending:text(raw.ending,200,'结尾'),
        intros:{requester:text(raw.intros?.requester,200,'开头'),target:text(raw.intros?.target,200,'开头')},
        scenes:raw.scenes.map(s=>({narration:text(s.narration,900,'讲述'),caption:text(s.caption,140,'配文')}))
      };
      try{companion.checkStoryLanguage(variant,{mode:lang});editions[lang]=variant;}catch{}
    }
    const dir=path.join(mediaDir,id);
    if(!Array.isArray(data.photos)||data.photos.length!==2)throw Object.assign(Error('需要两张串门照片。'),{status:400});
    const photos=data.photos.map(value=>{
      if(typeof value!=='string'||value.length>2800000)throw Object.assign(Error('照片太大。'),{status:413});
      const bytes=Buffer.from(value,'base64');
      if(bytes.length<1000||bytes.readUInt16BE(0)!==0xffd8||bytes.readUInt16BE(bytes.length-2)!==0xffd9)throw Object.assign(Error('串门照片需要 JPEG 格式。'),{status:400});
      return bytes;
    });
    photos.forEach((bytes,i)=>{const file=path.join(dir,i+'.jpg');fs.writeFileSync(file+'.tmp',bytes);fs.renameSync(file+'.tmp',file);});
    for(const [lang,edition] of Object.entries(editions)){
      const dir=path.join(narrationDir,id);fs.mkdirSync(dir,{recursive:true});
      const file=path.join(dir,lang+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(edition));fs.renameSync(file+'.tmp',file);
    }
    Object.assign(r,{story,storyLanguage:mode,theme:story.theme,status:'ready',photos:[{index:0},{index:1}],error:''});
    write(r);
    for(const asset of ['requester.png','target.png','room.png']){
      try{fs.unlinkSync(path.join(dir,asset));}catch{}
    }
    return view(r,userId);
  }
  function deliveryRecord(userId,id){
    const record=read(id);
    if(!record?.external||!roleOf(record,userId)||record.storyDate>chinaDay(now())||record.status!=='ready')
      throw Object.assign(Error('还没有可以领取的串门故事。'),{status:404});
    return record;
  }
  function deliveryBundle(userId,id){
    const record=deliveryRecord(userId,id);
    if(record.photosArchived)throw Object.assign(Error('两边已经收下了照片，可以从本机备份恢复。'),{status:410});
    const photos=[0,1].map(index=>photo(id,index,userId));
    if(photos.some(bytes=>!bytes))throw Object.assign(Error('照片还没准备好。'),{status:409});
    const stories=Object.fromEntries(['original','zh','mixed','en'].map(mode=>[mode,view(record,userId,mode)]).filter(([,item])=>item.story));
    return {stories,photos:photos.map(bytes=>bytes.toString('base64'))};
  }
  function receiveDelivery(userId,id){
    const record=deliveryRecord(userId,id);
    record.delivered ||= {};
    record.delivered[roleOf(record,userId)]=true;
    if(record.delivered.requester&&record.delivered.target)record.photosArchived=true;
    write(record);
    if(record.photosArchived){
      for(const file of ['0.jpg','1.jpg'])fs.rmSync(path.join(mediaDir,id,file),{force:true});
    }
    return {archived:!!record.photosArchived};
  }
  return { reserveEvent,send, forDate, listFor, previewFor, ensureForDate, resumeDeferred, retry: id=>ensure(read(id),true), photo, avatar, targets, roleOf, read, hasFor, view, prepareNarration,externalWork,externalDay,externalAsset,submitExternal,deliveryBundle,receiveDelivery };
}

module.exports = { createVisits, chinaDay, nextDay, validateVisitStory, publicVisitStory, planVisitDraft };
