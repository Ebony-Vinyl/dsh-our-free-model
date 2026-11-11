@echo off
rem OFM standalone service self-start loop (crash auto-restart, 5s)
rem data dir: D:\ofm-data  (matches Hermes config key)
cd /d D:\一人公司的项目\omf-src\packages\standalone
:loop
node cli.mjs --port 18900 --data-dir D:\ofm-data < nul
echo [OFM] service exited at %date% %time%; restart in 5s... >> "%~dp0service.log"
ping -n 6 127.0.0.1 >nul 2>nul
goto loop
