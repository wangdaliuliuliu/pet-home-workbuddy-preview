const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const localAgent=require('./local-agent');
const THRESHOLDS = [3, 8, 15, 25];
const ORIGINAL_IMAGE = '/assets/zuanzuan.png';
const DEFAULT_KEY = { hex: '00FF00', label: 'chroma green' };
const KEY_LABELS = { '00FF00': 'chroma green', '0000FF': 'chroma blue', 'FF00FF': 'chroma magenta' };

// A green pet cannot be cut out of a green screen, so a different key may be picked.
function chromaKey(value) {
  const raw = typeof value === 'string' ? value : value?.hex;
  const hex = typeof raw === 'string' ? raw.replace('#', '').toUpperCase() : '';
  return KEY_LABELS[hex] ? { hex, label: KEY_LABELS[hex] } : { ...DEFAULT_KEY };
}

function promptFor(level, key = DEFAULT_KEY) {
  const { hex, label } = chromaKey(key);
  return `Create evolution ${level} of 4 for Zuanzuan, the SAME pink gemstone ballet cat in this mobile pet game.
Reference image 1 is the CURRENT form: use it as the direct starting point. Reference image 2 is the ORIGINAL identity anchor: preserve its face, pink fluffy fur, ruby pink eyes, white muzzle, heart-shaped pink gemstone crown, elegant pink ballet tutu and ballet identity.
This is a coherent fantasy evolution, NOT a new pet, baby form, costume replacement or mere enlargement. Keep all recognizable features from the current form. Add a meaningful, attractive transformation that develops its existing gemstone and ballet motifs. Increase the visual progression gradually: early evolutions refine the crown silhouette, layered tutu and flowing jewel ribbons; later evolutions may develop delicate heart-crystal fairy wings and a regal gemstone aura. At evolution ${level}, match the magnitude of change to its position in this four-step journey, building on the previous form without losing the pink ballet cat identity. Do not use any other franchise's characters or distinctive designs.
One full-body character only. Consistent exquisite soft 3D storybook rendering, pink-and-rose-gold palette, jewel highlights, fine fur, and clear silhouette. Keep ears, crown, tail, wings and feet entirely within the square canvas with 8% padding. The pose may evolve but should remain suitable for a front-facing game sprite. No typography, watermark, scenery, floor, ground shadow or separate floating particles.
Use an opaque, entirely flat solid ${label} background (#${hex}) across all empty pixels, with no gradient or shadows. Background removal is handled separately by the game. Do not attempt to depict transparency: no checkerboard, white background or gray squares. Do not use ${label} anywhere inside the character, accessories or wings. Keep costume edges and wings clearly separate from the background for clean extraction.`;
}

// Custom pets carry no species notes, so the four stages are spelled out instead
// of trusting the model to guess how much should change at each step.
function customPromptFor(level, key = DEFAULT_KEY) {
  const { hex, label } = chromaKey(key);
  return `Create evolution ${level} of 4 of the EXACT same pet shown in the reference images, for this mobile pet game.
Reference image 1 is the CURRENT form: use it as the direct starting point. Reference image 2 is the ORIGINAL identity anchor: preserve its species, face, body structure, proportions, palette, material and distinctive features.
This is a coherent magical growth of ONE pet. It is NOT a new pet, a baby form, a costume replacement or a mere enlargement. Never turn it into a cat or any other character. Do not change its species, and do not swap its material or art style: a child's drawing keeps that drawing style, a plush toy stays a plush toy, a photo-real animal stays photo-real.
Progress gradually across four steps, and match the magnitude of change to evolution ${level}:
- evolution 1: refine only what already exists. Cleaner silhouette, tidier fur or material edges, and a faint first shimmer along its own markings.
- evolution 2: let one signature feature of this pet develop slightly, such as its tail, ears, mane, shell, horns or accessory, with a soft matching glow.
- evolution 3: add one clearly magical trait grown from its own patterns, such as floating ribbon-like accents, luminous markings or small crystal growths, while staying unmistakably the same pet.
- evolution 4: a full final form with a complete aura and its magical trait fully developed, still keeping the same face, palette and species.
Later steps must build on the previous form and must not lose its identity.
One complete full-body pet, eyes clearly visible, front-facing and suitable for a game sprite. Keep the same framing and a similar scale as the current form, with the whole silhouette inside the square canvas and 10 percent padding. No typography, watermark, scenery, floor, ground shadow or separate floating particles.
Use an opaque, perfectly flat solid ${label} background (#${hex}) across all empty pixels, with no gradient or shadow. Background removal is handled separately by the game. Do not attempt to depict transparency: no checkerboard, white background or gray squares. Do not use ${label} anywhere on the pet, its accessories or its effects. Keep the silhouette cleanly separated from the background for easy extraction.`;
}

function run(command, args, env, stage = '进化工具', timeoutMs = 480000) {
  return new Promise((resolve, reject) => {
    const imageEdit = args[1] === 'edit';
    // Keep the parent alive through the image tool's bounded primary and fallback attempts.
    if (imageEdit) timeoutMs = Math.max(timeoutMs, 750000);
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', imageEdit ? 'pipe' : 'ignore'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
    const imageEvents = () => stderr.split(/\r?\n/).flatMap(line => {
      if (!line.startsWith('IMAGE_EDIT ')) return [];
      try {
        const { provider, stage, elapsedMs, error, status, code, retryable } = JSON.parse(line.slice(11));
        if (!['primary', 'fallback'].includes(provider) || !['response', 'failed'].includes(stage) || !Number.isSafeInteger(elapsedMs)) return [];
        return [{ provider, stage, elapsedMs, ...(/^[A-Za-z]+$/.test(error || '') ? { error } : {}), ...(Number.isInteger(status) ? { status } : {}), ...(/^[a-z_]+$/.test(code||'')?{code,retryable:retryable===true}:{}) }];
      } catch { return []; }
    }).slice(-4);
    const timer = setTimeout(() => { child.kill(); const error = new Error(`${stage}等得有点久，这次先停一下。请稍后再试。`); error.diagnostic = { stage, timeout: true, timeoutMs, ...(imageEdit ? { imageEvents: imageEvents() } : {}) }; reject(error); }, timeoutMs);
    child.once('error', cause => { clearTimeout(timer); const error=new Error('进化工具暂时没有准备好，请大人检查配置。');error.diagnostic={stage,reason:'tool_unavailable',code:cause.code||'UNKNOWN'};reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); if (code === 0) resolve(); else { const error = new Error(`${stage}没有完成，原来的宠物和成长进度都还在。`); error.diagnostic = { stage, exitCode: code, signal, ...(imageEdit ? { imageEvents: imageEvents() } : {}) }; reject(error); } });
  });
}

function capture(command, args, env, stage, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out = (out + chunk.toString('utf8')).slice(-4096); });
    child.stderr.on('data', chunk => { err = (err + chunk.toString('utf8')).slice(-2048); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${stage}等得有点久`)); }, timeoutMs);
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(out.trim()); else reject(new Error(err.trim() || `${stage}没有完成`)); });
  });
}

// The screen colour is fixed per job, so a retry always reuses the same key.
async function resolveChromaKey({ python, workDir, previousFile }) {
  const meta = path.join(workDir, 'chroma.json');
  try {
    const saved = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (saved?.hex) return chromaKey(saved.hex);
  } catch {}
  let picked = { ...DEFAULT_KEY };
  const script = path.join(__dirname, 'scripts/pet-keycolor.py');
  if (previousFile && fs.existsSync(previousFile) && fs.existsSync(script)) {
    try {
      const out = await capture(python, [script, previousFile], process.env, '分析宠物主色', 30000);
      const parsed = JSON.parse(out.split(/\r?\n/).pop() || '{}');
      picked = chromaKey(parsed.hex || parsed.key);
    } catch {}
  }
  try { fs.writeFileSync(meta, JSON.stringify(picked)); } catch {}
  return picked;
}

async function generateForm({ level, previousFile, originalFile, dir, jobId, customPet=false }) {
  const useAgent=localAgent.enabled();
  if (!useAgent && (process.env.PET_LOCAL_FIRST==='1'||!process.env.PET_IMAGE_API_KEY || !process.env.PET_IMAGE_BASE_URL)) throw new Error('进化图片服务还没接通，请大人先完成配置。');
  const python = process.env.PET_IMAGE_PYTHON || (process.platform === 'win32' ? path.join(__dirname, '.tools/imagegen/Scripts/python.exe') : 'python3');
  const cli = process.env.PET_IMAGE_CLI || path.join(__dirname, 'scripts/image_gen.py');
  if (!fs.existsSync(cli)) throw new Error('进化工具还没安装好，请大人检查配置。');
  await run(python, ['-c', useAgent ? 'from PIL import Image' : 'import openai; from PIL import Image'], process.env, '检查图片工具');
  const workDir = path.join(dir, 'work', jobId);
  fs.mkdirSync(workDir, { recursive: true });
  const promptFile = path.join(workDir, 'prompt.txt');
  const raw = path.join(workDir, 'source.png');
  const output = path.join(dir, `${jobId}.png`);
  const key = await resolveChromaKey({ python, workDir, previousFile });
  const prompt=customPet ? customPromptFor(level, key) : promptFor(level, key);
  fs.writeFileSync(promptFile,prompt);
  // Only the explicitly selected image provider receives this key. Do not log SDK output.
  const env = { ...process.env, OPENAI_API_KEY: process.env.PET_IMAGE_API_KEY, OPENAI_BASE_URL: process.env.PET_IMAGE_BASE_URL, PYTHONUTF8: '1' };
  if(!fs.existsSync(raw)){
    if(useAgent)await localAgent.generateImage({prompt,files:[...new Set([previousFile,originalFile])],destination:raw});
    else await run(python, [cli, 'edit', '--model', process.env.PET_IMAGE_MODEL || 'gpt-image-2', '--image', previousFile, '--image', originalFile, '--prompt-file', promptFile, '--size', '1024x1024', '--quality', 'high', '--output-format', 'png', '--out', raw], env, '生成进化图片');
  }
  const inspect = path.join(__dirname, 'scripts/inspect-evolution.py');
  // Keep usable alpha, adding transparent canvas where needed.
  try {
    await run(python, [inspect, raw, 'prepare-alpha', output], process.env, '检查透明背景');
    return output;
  } catch {
    try { await run(python, [path.join(__dirname, 'scripts/evolution_alpha.py'), raw, output, previousFile, '--key', key.hex, '--auto'], process.env, '检查并去除绿幕背景'); }
    catch (cause) {
      const error = new Error('新形态图片已经生成，但背景无法去除。原来的宠物和成长进度都还在。');
      error.diagnostic = { ...cause.diagnostic, stage: '检查图片背景', reason: 'neither_valid_alpha_nor_chroma_screen', key: key.hex, sourceSaved: true };
      throw error;
    }
  }
  try { await run(python, [inspect, output, 'prepare-alpha', output], process.env, '检查最终图片'); }
  catch (cause) {
    const error = new Error('新形态的图片没有通过检查，这次先保留原来的宠物。');
    error.diagnostic = { ...cause.diagnostic, stage: '检查最终图片', sourceSaved: true };
    throw error;
  }
  return output;
}

function createEvolution({ state, save, dataDir, generator = generateForm, onForm = () => {}, animationView = () => ({ status: 'unavailable' }) }) {
  const dir = path.join(dataDir, 'evolutions');
  fs.mkdirSync(dir, { recursive: true });
  state.evolution ||= { level: 0, status: 'idle', forms: [] };
  // A server restart never silently retries a paid image request.
  if (state.evolution.status === 'generating') {
    state.evolution.status = 'failed'; state.evolution.error = '上次进化准备中断了，想继续时可以再试一次。'; save();
  }
  let active = false;
  let completion = Promise.resolve();
  function view() {
    const e = state.evolution;
    const image = e.forms.at(-1)?.image || state.petProfile?.image || ORIGINAL_IMAGE;
    const animation = animationView();
    const feeds = Math.max(0,state.feeds-(e.feedOffset||0));
    const complete = e.level === 0&&!state.petProfile || (animation.status === 'ready' && animation.formImage === image);
    return { level: e.level, totalEvolutions: THRESHOLDS.length, status: e.status, error: e.error || '', image: e.forms.at(-1)?.image || state.petProfile?.image || ORIGINAL_IMAGE,
      complete, completedLevel: Math.max(0, e.level - (complete ? 0 : 1)),
      preparation: e.status === 'generating' ? 'image' : complete ? 'ready' : 'animation',
      feeds, nextAt: THRESHOLDS[e.level] ?? null, eligible: complete && e.level < THRESHOLDS.length && feeds >= THRESHOLDS[e.level],
      forms: e.forms.map(f => ({ level: f.level, image: f.image, createdAt: f.createdAt })) };
  }
  function start() {
    const e = state.evolution;
    if (active || !view().eligible) return false;
    active = true;
    const prior = e.jobId;
    const jobId = e.status === 'failed' && typeof prior === 'string' && /^[a-f0-9-]{36}$/.test(prior) && fs.existsSync(path.join(dir, 'work', prior, 'source.png'))
      ? prior : crypto.randomUUID();
    const level = e.level + 1;
    const previous = e.forms.at(-1);
    e.status = 'generating'; e.error = ''; delete e.diagnostic; e.jobId = jobId; save();
    completion = (async () => {
      try {
        if(state.petProfile){const prepare=require('./animation-service').prepareAnimationDirectory;prepare(path.join(dataDir,'animations'));prepare(path.join(dataDir,'animations',jobId));}
        const originalFile=state.petProfile?path.join(dataDir,state.petProfile.file):path.join(__dirname,'public/assets/zuanzuan.png');const output = await generator({ level, previousFile: previous ? path.join(dir, previous.file) : originalFile, originalFile, dir, jobId,customPet:!!state.petProfile });
        if (!fs.existsSync(output) || path.resolve(output) !== path.join(dir, `${jobId}.png`)) throw new Error('新形态文件没有保存好，请再试一次。');
        e.forms.push({ level, file: `${jobId}.png`, image: `/api/evolutions/${jobId}.png`, createdAt: Date.now(),...(state.petProfile?{animationJobId:jobId}:{}) });
        e.level = level; e.status = 'idle'; e.error = '';
        // Keep image/progress on binding failure, but view() cannot mark it complete or start another evolution.
        try { onForm(e.forms.at(-1)); }
        catch { e.diagnostic = { stage: '启动当前形态动作', animationPending: true }; }
      } catch (error) { e.status = 'failed'; e.error = error.message; e.diagnostic = error.diagnostic || { stage: '保存进化形态' }; }
      finally { active = false; save(); }
    })();
    return true;
  }
  return { view, start, settled: () => completion };
}

module.exports = { createEvolution, generateForm, promptFor, customPromptFor, chromaKey, THRESHOLDS, run };
