@echo off
setlocal EnableExtensions

set "ROOT=D:\EmiliaVoice\GPT-SoVITS"
set "PYTHON=%ROOT%\.venv\Scripts\python.exe"
set "PATH=%ROOT%\.tools\ffmpeg;%PATH%"
set "PYTHONUTF8=1"
rem Gradio verifies its own localhost URL at startup.  A stale campus/proxy
rem variable can make that loopback request leave the machine and fail.
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "http_proxy="
set "https_proxy="
set "all_proxy="
set "NO_PROXY=localhost,127.0.0.1,::1,0.0.0.0"
set "no_proxy=localhost,127.0.0.1,::1,0.0.0.0"

if not exist "%PYTHON%" (
  echo [Emilia TTS] Training environment was not found at:
  echo %ROOT%
  pause
  exit /b 1
)

if not exist "%ROOT%\models-ready.json" (
  echo [Emilia TTS] Required model weights are not ready yet.
  echo Run tools\download-gpt-sovits-models.ps1 first.
  pause
  exit /b 1
)

if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
start "Emilia GPT-SoVITS" /D "%ROOT%" /min cmd /d /c ""%PYTHON%" webui.py 1>> "%ROOT%\logs\webui.log" 2>> "%ROOT%\logs\webui.err.log""

timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:9874"
endlocal
