@echo off
setlocal EnableExtensions
title Arynox AI Call Assistant - Web Launcher
cd /d "%~dp0"

echo ============================================================
echo  Arynox AI Call Assistant by Aryan Chavan
echo  Local web launcher - backend + frontend on localhost
echo ============================================================

set "ROOT=%~dp0"
set "GATEWAY=%ROOT%pc\pc-gateway"
set "DATA=%ROOT%data"

rem ---- temp redirects (the C: drive is usually full) ----
if exist "D:\Arynoxtech\.npm-tmp" (
  set "TEMP=D:\Arynoxtech\.npm-tmp"
  set "TMP=D:\Arynoxtech\.npm-tmp"
)

rem ---- data + secrets live on the D: drive with the repo ----
if not exist "%DATA%" mkdir "%DATA%"
set "AGENTCALL_RECORDING_ROOT=%DATA%\recordings"
set "AGENTCALL_PROVIDER_SETTINGS_FILE=%DATA%\provider-settings.json"
set "AGENTCALL_AGENT_ANSWERING_FILE=%DATA%\agent-answering.json"
set "AGENTCALL_ADB_HOME=%DATA%\adb"
set "AGENTCALL_CONTROLLER_SECRET_FILE=%DATA%\controller\controller.key"
set "AGENTCALL_REDACTION_SALT_FILE=%DATA%\controller\redaction-salt"

rem ---- local RPC socket (named pipe on Windows, file socket on Linux/macOS) ----
set "AGENTCALL_RPC_SOCKET=\\.\pipe\agentcall-gatewayd-desktop"

rem ---- optional: paste your Groq API key here, or save it in the app under Settings - Speech ----
rem set "GROQ_API_KEY=REPLACE_WITH_YOUR_KEY"
rem ---- optional: OpenCode Zen key (free models like big-pickle) for the AI conversation brain ----
rem set "OPENCODE_API_KEY=REPLACE_WITH_YOUR_KEY"

rem ---- mode selection ----
rem   simulator = no phone needed (virtual phone, works immediately)
rem   hardware  = real Android phone over USB (POCO M2 Pro, lineage_miatoll/gram, API 35)
rem   auto      = detected below: phone + matched-artifact.json -> hardware, otherwise simulator
if not defined AGENTCALL_MODE set "AGENTCALL_MODE=auto"

if /i "%AGENTCALL_MODE%"=="auto" (
  set "AGENTCALL_MODE=simulator"
  set "ARYNOX_PHONE_FOUND="
  for /f "usebackq tokens=1" %%d in (`adb devices 2^>nul ^| findstr /r "device$"`) do set "ARYNOX_PHONE_FOUND=1"
  if defined ARYNOX_PHONE_FOUND (
    if defined AGENTCALL_MATCHED_ARTIFACT_FILE (
      set "AGENTCALL_MODE=hardware"
    ) else if exist "%DATA%\matched-artifact.json" (
      set "AGENTCALL_MATCHED_ARTIFACT_FILE=%DATA%\matched-artifact.json"
      set "AGENTCALL_MODE=hardware"
    ) else (
      echo [!] Android device detected over USB, but no matched-artifact.json found.
      echo     Put the zero-touch manifest at "%DATA%\matched-artifact.json"
      echo     (or set AGENTCALL_MATCHED_ARTIFACT_FILE) to enable hardware mode.
      echo     Starting in simulator mode for now.
    )
  )
)

echo [*] Mode: %AGENTCALL_MODE%
if /i "%AGENTCALL_MODE%"=="hardware" (
  if not exist "%DATA%\controller" mkdir "%DATA%\controller"
  if not exist "%AGENTCALL_CONTROLLER_SECRET_FILE%" (
    powershell -NoProfile -Command "$b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Fill($b); [System.IO.File]::WriteAllBytes('%AGENTCALL_CONTROLLER_SECRET_FILE%', $b)"
  )
  if not exist "%AGENTCALL_REDACTION_SALT_FILE%" (
    powershell -NoProfile -Command "$r = [Convert]::ToBase64String((New-Object byte[] 32), 'None').TrimEnd('=').Replace('+','-').Replace('/','_'); [System.IO.File]::WriteAllText('%AGENTCALL_REDACTION_SALT_FILE%', $r)"
  )
)

echo [*] Starting backend gateway daemon (RPC socket) ...
start "Arynox Gateway Daemon" /D "%GATEWAY%" cmd /k "node src/gatewayd.js"

echo [*] Starting web frontend host ...
start "Arynox Web Host" /D "%GATEWAY%" cmd /k "node scripts/web-host.mjs"

timeout /t 3 /nobreak >nul
start "" "http://localhost:8456"

echo.
echo [*] Web app:  http://localhost:8456
echo [*] Gateway:  RPC socket  \\.\pipe\agentcall-gatewayd-desktop
echo.
echo [*] First time setup:
echo     1. In the app open Settings - Speech, pick Groq for STT and TTS,
echo        choose a model + voice, paste your Groq API key and save.
echo        Then close the "Arynox Gateway Daemon" window and run this file again.
echo     2. To make real calls: enable USB debugging on the phone, connect it,
echo        and follow the zero-touch bootstrap flow (requires the Android app
echo        built from the app/ folder and a matched-artifact.json).
echo.
echo [*] Close the two "Arynox ..." windows (or press Ctrl+C in them) to stop.
echo.
endlocal