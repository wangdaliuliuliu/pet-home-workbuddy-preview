(() => {
  const entry = document.getElementById('change-appearance');
  if (!entry) return;
  const panel = document.createElement('dialog');
  panel.className = 'game-dialog';
  panel.innerHTML = `<div class="dialog-top"><span>更改形象</span><button type="button" class="close-button" aria-label="关闭">×</button></div>
    <p>更换后，进化阶段回到初始形态，新形象的喂养进度从零开始。以前的喂食、故事、聊天和声音会保留。</p>
    <label>选择新形象 <input type="file" accept="image/*"></label>
    <div class="growth-portrait" hidden><img class="evolved-art" alt="新形象预览"></div>
    <p role="status"></p>
    <button type="button" class="secondary-button" data-action="retry-image" hidden>重新处理图片</button>
    <button type="button" class="secondary-button" data-action="prepare" hidden>准备新形象的动作</button>
    <button type="button" class="story-button" data-action="apply" hidden>确认更换，重新成长</button>`;
  document.body.append(panel);
  const find = selector => panel.querySelector(selector);
  const file = find('input');
  const portrait = find('.growth-portrait');
  const image = portrait.querySelector('img');
  const notice = find('[role=status]');
  const retry = find('[data-action=retry-image]');
  const prepare = find('[data-action=prepare]');
  const apply = find('[data-action=apply]');
  const endpoint = '/api/pet-appearance';
  let current, timer, busy = false;
  async function request(route = '', options) {
    const response = await fetch(endpoint + route, options);
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '暂时没能完成，请稍后再试。');
    return data;
  }
  function render(data) {
    current = data;
    const processing = ['queued', 'processing'].includes(data.imageStatus);
    const binding = data.animation?.status === 'generating';
    const ready = data.animation?.status === 'ready';
    file.disabled = busy || processing || binding;
    portrait.hidden = !data.id || data.applied;
    if (!portrait.hidden) image.src = data.image;
    retry.hidden = data.imageStatus !== 'failed';
    prepare.hidden = !data.id || data.applied || binding || ready;
    apply.hidden = !ready || data.applied;
    notice.textContent = processing ? '正在处理图片…' : binding ? '正在准备新形象的动作…' :
      data.applied ? '这个形象已经换好啦。' : data.imageError || data.animation?.error || (ready ? '新形象和动作已经准备好。' : '');
    clearTimeout(timer);
    if ((processing || binding) && panel.open) timer = setTimeout(refresh, 2500);
  }
  async function refresh() {
    try { render(await request()); }
    catch (error) { notice.textContent = error.message; }
  }
  async function act(action, upload) {
    if (busy) return;
    busy = true;
    for (const control of [file, retry, prepare, apply]) control.disabled = true;
    clearTimeout(timer);
    try {
      const data = await request('/' + action, {
        method: 'POST',
        headers: { 'Content-Type': upload ? 'application/octet-stream' : 'application/json' },
        body: upload || JSON.stringify({ id: current?.id })
      });
      if (action === 'apply' && data.applied) { location.reload(); return; }
      busy = false;
      render(data);
    } catch (error) { notice.textContent = error.message; }
    finally {
      busy = false;
      file.disabled = ['queued', 'processing'].includes(current?.imageStatus) || current?.animation?.status === 'generating';
      for (const control of [retry, prepare, apply]) control.disabled = false;
    }
  }
  entry.onclick = () => { panel.showModal(); refresh(); };
  find('.close-button').onclick = () => panel.close();
  panel.addEventListener('close', () => clearTimeout(timer));
  file.onchange = () => {
    const upload = file.files[0];
    file.value = '';
    if (!upload) return;
    if (upload.size > 8 * 1024 * 1024) { notice.textContent = '请选择一张 8MB 以内的图片。'; return; }
    act('upload', upload);
  };
  retry.onclick = () => act('retry-image');
  prepare.onclick = () => act('prepare');
  apply.onclick = () => act('apply');
})();
