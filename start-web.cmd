@echo off
cd /d "%~dp0"
if not exist "apps\web\dist\main.js" (
  echo [build] first run, building...
  call pnpm build || goto :fail
)
echo [web] starting at http://127.0.0.1:8787
start "" http://127.0.0.1:8787
node apps\web\dist\main.js
goto :eof
:fail
echo [web] build failed - run "pnpm build" manually to see errors
pause
