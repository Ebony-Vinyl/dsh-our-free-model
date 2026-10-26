// 编译进程序，在实际服务页面的每次文档加载时挂载。
(function() {
  if (document.getElementById('ofm-titlebar')) return;
  const api = window.__TAURI__?.window;
  if (!api?.getCurrentWindow) return;
  const win = api.getCurrentWindow();
  const titlebar = document.createElement('div');
  titlebar.id = 'ofm-titlebar';
  titlebar.innerHTML = `
    <div class="ofm-tb-title">OUR FREE MODEL</div>
    <div class="ofm-tb-actions">
      <button class="ofm-tb-btn minimize" title="最小化" aria-label="最小化"><svg viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg></button>
      <button class="ofm-tb-btn maximize" title="最大化" aria-label="最大化"><svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/></svg></button>
      <button class="ofm-tb-btn close" title="隐藏到托盘" aria-label="隐藏到托盘"><svg viewBox="0 0 12 12"><path d="M3,3 L9,9 M9,3 L3,9" stroke="currentColor" stroke-width="1"/></svg></button>
    </div>`;
  document.body.prepend(titlebar);
  const run = action => { void action().catch(() => { titlebar.title = '窗口操作失败，请使用系统托盘菜单'; }); };
  titlebar.querySelector('.minimize').addEventListener('click', () => run(() => win.minimize()));
  titlebar.querySelector('.maximize').addEventListener('click', () => run(async () => {
    if (await win.isMaximized()) await win.unmaximize(); else await win.maximize();
  }));
  titlebar.querySelector('.close').addEventListener('click', () => run(() => win.hide()));
  titlebar.addEventListener('mousedown', event => {
    if (event.button === 0 && !event.target.closest('button')) run(() => win.startDragging());
  });
  titlebar.addEventListener('dblclick', event => {
    if (!event.target.closest('button')) titlebar.querySelector('.maximize').click();
  });
})();
