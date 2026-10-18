#!/bin/bash
# 修复签名 / 绕过 Gatekeeper —— Our Free Model (macOS)
# 双击本文件，在弹出的终端里输入本机登录密码（sudo）即可。
set -e

APPS=(
  "/Applications/Our Free Model.app"
  "$HOME/Applications/Our Free Model.app"
)
found=0
for app in "${APPS[@]}"; do
  if [ -d "$app" ]; then
    found=1
    echo "▶ 正在处理：$app"
    echo "  如提示 Password，请输入本机登录密码（输入时屏幕不显示字符）。"
    sudo xattr -rd com.apple.quarantine "$app" 2>/dev/null || xattr -rd com.apple.quarantine "$app" 2>/dev/null || true
    sudo codesign --force --deep --sign - "$app" >/dev/null 2>&1 || true
    echo "  ✓ 已移除隔离属性并重新 ad-hoc 签名。"
  fi
done

if [ "$found" -eq 0 ]; then
  echo "✗ 未找到 Our Free Model.app。"
  echo "  请先把 dmg 里的 Our Free Model.app 拖到「应用程序」文件夹，再运行本脚本。"
fi
echo "现在可以从访达打开 Our Free Model 了。"
read -r -p "按回车退出…" _
