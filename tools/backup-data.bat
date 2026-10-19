@echo off
set TS=%DATE:~10,4%%DATE:~4,2%%DATE:~7,2%-%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%
set TS=%TS: =0%
cp -r "%USERPROFILE%\.our-free-model" "%USERPROFILE%\.our-free-model.backup-%TS%"
echo Backup created: %USERPROFILE%\.our-free-model.backup-%TS%