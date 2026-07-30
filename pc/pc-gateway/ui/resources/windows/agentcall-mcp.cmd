@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if not defined AGENTCALL_RPC_SOCKET set "AGENTCALL_RPC_SOCKET=\\.\pipe\agentcall-gatewayd-desktop"
"%~dp0..\..\AgentCall Desktop.exe" "%~dp0..\gateway\src\mcp-server.js" %*
exit /b %errorlevel%
