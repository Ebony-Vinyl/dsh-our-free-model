@echo off
title Our-Free-Model Standalone (127.0.0.1:18900)
rem Runner membersihkan lock basi lalu menjalankan node (dengan jendela ini).
call "%~dp0ofm-standalone-run.cmd"
echo.
echo [service stopped] press any key to close
pause >nul
