@echo off
rem ============================================================
rem  Our-Free-Model standalone runner (127.0.0.1:18900)
rem
rem  Membersihkan service.lock yang BASI (ditinggalkan proses
rem  yang sudah mati) sebelum start. Tanpa ini, autostart gagal
rem  setelah reboot karena service.mjs memakai openSync(...,'wx')
rem  yang error EEXIST kalau file lock masih ada.
rem
rem  Dipakai oleh:
rem    - ofm-standalone-hidden.vbs  (autostart, tanpa jendela)
rem    - ofm-standalone.cmd         (manual, dengan jendela)
rem ============================================================
setlocal EnableExtensions EnableDelayedExpansion

set "REPO=%~dp0"
set "LOCK=%USERPROFILE%\.our-free-model\service.lock"

rem Pakai path absolut supaya tidak bergantung PATH (mis. saat dipanggil
rem dari Git Bash, `find` bisa jadi GNU find, bukan find.exe Windows).
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
set "TASKLIST=%SystemRoot%\System32\tasklist.exe"
set "FIND=%SystemRoot%\System32\find.exe"

if exist "%LOCK%" (
  set "OLDPID="
  for /f "usebackq tokens=2 delims=:,}" %%p in ("%LOCK%") do set "OLDPID=%%p"
  if defined OLDPID (
    rem Lock dianggap sah HANYA kalau PID-nya masih hidup DAN itu node.exe.
    rem (Cocokkan nama image, bukan pesan "No tasks" yang bisa terlokalisasi.)
    "%TASKLIST%" /FI "PID eq !OLDPID!" /NH 2>nul | "%FIND%" /i "node.exe" >nul
    if not errorlevel 1 (
      rem Service sudah jalan -> jangan start instance kedua.
      exit /b 0
    )
    rem PID mati, atau PID dipakai ulang oleh proses lain -> hapus lock basi.
    del /f /q "%LOCK%" >nul 2>nul
  )
)

cd /d "%REPO%"
"%NODE%" packages\standalone\cli.mjs --port 18900
