@echo off
setlocal EnableExtensions

rem This file is intentionally non-interactive: it is safe for Task Scheduler
rem and for the desktop client to launch without a terminal window.
set "ROOT=D:\EmiliaVoice\GPT-SoVITS"
set "PYTHON=%ROOT%\.venv\Scripts\python.exe"
set "LOG_DIR=%ROOT%\logs"
set "PATH=%ROOT%\.tools\ffmpeg;%PATH%"
set "PYTHONUTF8=1"
rem The Companion bridge calls the TTS-inference Gradio API on this fixed
rem loopback port. This is deliberately not webui.py: that is only the
rem management UI on 9874 and starts the real inference process after a click.
set "infer_ttswebui=9872"
set "is_share=False"
set "_CUDA_VISIBLE_DEVICES=0"
set "is_half=True"
set "cnhubert_base_path=GPT_SoVITS\pretrained_models\chinese-hubert-base"
set "bert_path=GPT_SoVITS\pretrained_models\chinese-roberta-wwm-ext-large"

rem Gradio checks its own loopback URL during boot. A stale proxy setting can
rem send that request off-machine and make the engine appear to fail.
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "http_proxy="
set "https_proxy="
set "all_proxy="
set "NO_PROXY=localhost,127.0.0.1,::1,0.0.0.0"
set "no_proxy=localhost,127.0.0.1,::1,0.0.0.0"

if not exist "%PYTHON%" (
  echo [Emilia GPT-SoVITS] Python environment not found: %PYTHON%
  exit /b 1
)

if exist "%ROOT%\.env.voice" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ROOT%\.env.voice") do (
    if /I "%%A"=="VOICE_GPT_WEIGHT" set "gpt_path=%%B"
    if /I "%%A"=="VOICE_SOVITS_WEIGHT" set "sovits_path=%%B"
  )
)

if not defined gpt_path (
  echo [Emilia GPT-SoVITS] VOICE_GPT_WEIGHT is missing from .env.voice
  exit /b 1
)
if not defined sovits_path (
  echo [Emilia GPT-SoVITS] VOICE_SOVITS_WEIGHT is missing from .env.voice
  exit /b 1
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
cd /d "%ROOT%"
"%PYTHON%" -s GPT_SoVITS\inference_webui.py zh_CN 1>> "%LOG_DIR%\emilia-inference.log" 2>> "%LOG_DIR%\emilia-inference.err.log"
exit /b %errorlevel%
