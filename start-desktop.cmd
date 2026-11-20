@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem --- parse args ---
set "MODE=auto"
set "RESTART="
:argloop
if "%~1"=="" goto args_done
if /i "%~1"=="--rebuild"  set "MODE=rebuild" & shift & goto argloop
if /i "%~1"=="-r"         set "MODE=rebuild" & shift & goto argloop
if /i "%~1"=="--no-build" set "MODE=skip"    & shift & goto argloop
if /i "%~1"=="-n"         set "MODE=skip"    & shift & goto argloop
if /i "%~1"=="--restart"  set "RESTART=1"    & shift & goto argloop
if /i "%~1"=="--update-test" set "REINA_UPDATE_TEST=1" & shift & goto argloop
if /i "%~1"=="-u"         set "REINA_UPDATE_TEST=1" & shift & goto argloop
if /i "%~1"=="--help"     goto help
if /i "%~1"=="-h"         goto help
echo Unknown argument: %~1
echo.
goto help
:args_done

rem --- logs ---
set "LOG_DIR=%~dp0.logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "BUILD_STAMP=%LOG_DIR%\.last-build-ok"

rem rotate: keep newest 10 app logs
for /f "skip=10 delims=" %%F in ('dir /b /o-d "%LOG_DIR%\reina-app-*.log" 2^>nul') do (
  del "%LOG_DIR%\%%F" >nul 2>&1
)

for /f "delims=" %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%I"
set "APP_LOG=%LOG_DIR%\reina-app-!STAMP!.log"
set "REINA_DESKTOP_LOG=!APP_LOG!"

rem --- already-running? ---
set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
set "RUNNING="
rem NOTE: no pipes inside these for /f powershell commands — the ^| escape is
rem mangled when this script is itself launched from PowerShell, which made
rem the kill branch silently no-op. .Where()/.ForEach() need no pipe char.
for /f %%R in ('powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue).Where({ $_.Path -eq '%ELECTRON_EXE%' }).Count"') do set "RUNNING=%%R"
if not "!RUNNING!"=="" if not "!RUNNING!"=="0" (
  if defined RESTART (
    echo Stopping !RUNNING! running Reina instance^(s^)...
    powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue).Where({ $_.Path -eq '%ELECTRON_EXE%' }).ForEach({ Stop-Process -Id $_.Id -Force })"
  ) else (
    echo Reina Desktop is already running ^(!RUNNING! process^(es^)^).
    echo.
    echo   Close it first, or re-run with --restart to kill and replace it.
    echo.
    pause
    exit /b 0
  )
)

rem --- npm check ---
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm not found on PATH.
  pause
  exit /b 1
)

rem --- decide whether to build ---
set "SHOULD_BUILD=0"
if /i "!MODE!"=="rebuild" (
  set "SHOULD_BUILD=1"
) else if /i "!MODE!"=="skip" (
  set "SHOULD_BUILD=0"
  rem --no-build explicitly asks for the last compiled output; tell the
  rem stale-dist gate in dev.cjs to warn instead of refusing to launch.
  set "REINA_ALLOW_STALE=1"
) else (
  if not exist "!BUILD_STAMP!" (
    set "SHOULD_BUILD=1"
  ) else (
    for /f %%S in ('powershell -NoProfile -Command "$stamp=(Get-Item '!BUILD_STAMP!').LastWriteTime; if (@(Get-ChildItem -Path 'packages\*\src','apps\desktop\src' -Recurse -File -Include *.ts,*.tsx,*.cjs,*.mjs,*.js,*.css,*.html -ErrorAction SilentlyContinue).Where({ $_.LastWriteTime -gt $stamp }, 'First', 1).Count) { 'yes' } else { 'no' }"') do set "CHANGED=%%S"
    if /i "!CHANGED!"=="yes" set "SHOULD_BUILD=1"
  )
)

if "!SHOULD_BUILD!"=="1" (
  echo Building...
  call npm run build:desktop
  if errorlevel 1 (
    echo.
    echo Build failed.
    pause
    exit /b 1
  )
  rem touch the stamp so next run knows when the last successful build was
  type nul > "!BUILD_STAMP!"
) else (
  echo No source changes since last build; skipping rebuild ^(use --rebuild to force^).
)

echo.
echo Starting Reina Desktop...
echo   App log: !APP_LOG!
echo.
call npm run dev --workspace=@reina/desktop
set "EXITCODE=!errorlevel!"

if not "!EXITCODE!"=="0" (
  echo.
  echo Reina Desktop exited with code !EXITCODE!.
  pause
)
exit /b !EXITCODE!

:help
echo Usage: start-desktop.cmd [options]
echo.
echo   (no args)         Auto: rebuild only if source files changed since last build
echo   --rebuild, -r     Force a full rebuild before launching
echo   --no-build, -n    Skip build entirely (use last compiled output)
echo   --restart         Kill any already-running Reina before starting
echo   --update-test, -u Force the auto-updater against the public GitHub feed
echo                     (fakes an old version so a published release shows as an
echo                     update) — exercises check/download without editing files
echo   --help, -h        Show this help
echo.
echo Environment:
echo   REINA_CDP_PORT   Chrome DevTools Protocol port (default 9333)
echo                     Set to 0 to disable, e.g. set REINA_CDP_PORT=0
echo.
exit /b 0
