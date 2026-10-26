// 由本地外部模块初始化主题，遵守管理页禁止内联脚本的 CSP。
let saved
try { saved = localStorage.getItem('ofm-theme') } catch {
  // 存储不可用时仍可按系统偏好展示页面。
}
document.documentElement.dataset.theme = saved === 'dark' || saved === 'light'
  ? saved : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
