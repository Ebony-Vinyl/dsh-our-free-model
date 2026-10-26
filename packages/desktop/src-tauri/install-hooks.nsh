; Node 及完整许可证随安装包分发；进程检查交给 Tauri 的标准安装器。
; 不按名称强杀进程、不删除其它服务的锁、不覆盖已有配置。
!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$PROFILE\.our-free-model"
!macroend
