@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
pushd "%PROJECT_ROOT%"
node --experimental-strip-types companion-voice-service\src\server.ts >> companion-voice-service\voice-service.log 2>> companion-voice-service\voice-service.err.log
popd
