@echo off
setlocal

pushd "%~dp0.." || (
  echo Failed to enter project directory.
  pause
  exit /b 1
)

set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=win-all"
if /i "%TARGET:~0,9%"=="--target=" set "TARGET=%TARGET:~9%"
if /i "%TARGET%"=="all" set "TARGET=win-all"

if /i "%TARGET%"=="win" goto run
if /i "%TARGET%"=="win-portable" goto run
if /i "%TARGET%"=="win-all" goto run

echo Usage: package-release.cmd [win^|win-portable^|win-all]
echo Default: win-all
popd
pause
exit /b 1

:run
echo Packaging Reina for %TARGET%...
call npm run package:release -- --target=%TARGET%
set "STATUS=%ERRORLEVEL%"
if not "%STATUS%"=="0" (
  echo Packaging failed with exit code %STATUS%.
) else (
  echo Packaging complete. Output: %CD%\release
)
popd
pause
exit /b %STATUS%
