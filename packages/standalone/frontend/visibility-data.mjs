export function visibilityCopy(locale) {
  return String(locale).toLowerCase().startsWith('en') ? {
    hideFree: 'Hide anonymous and Kilo free models',
    hideEac: 'Hide EAC models',
    hide: 'Hide model',
    show: 'Show model',
    hidden: 'Hidden by preference',
    groupHidden: 'Turn off group hiding first',
    saved: 'Model visibility saved',
  } : {
    hideFree: '隐藏匿名与 Kilo 免费模型',
    hideEac: '隐藏 EAC 模型',
    hide: '隐藏模型',
    show: '显示模型',
    hidden: '已按偏好隐藏',
    groupHidden: '请先关闭整组隐藏',
    saved: '模型显示设置已保存',
  }
}
