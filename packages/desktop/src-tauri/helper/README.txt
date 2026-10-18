Our Free Model — macOS 非官方社区构建

本安装包未经 Apple 签名与公证，首次打开会被 Gatekeeper 拦截
（提示“已损坏”或“无法打开”），这不是文件损坏，只是没有签名。

三种打开方式（任选其一）：
1) 访达中右键（Control 点按）Our Free Model.app →“打开”→ 再次确认。
2) 双击本 dmg 里的「修复签名.command」，在终端输入登录密码（sudo），
   脚本会自动移除隔离属性并重新签名。
   （若双击被拦截，先右键 → 打开 一次即可。）
3) 终端手动执行：
   sudo xattr -rd com.apple.quarantine '/Applications/Our Free Model.app'
   或：xattr -cr /Applications/Our\ Free\ Model.app
4) 系统设置 → 隐私与安全性 →“仍要打开”。
