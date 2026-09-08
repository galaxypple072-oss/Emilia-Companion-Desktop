#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$PROJECT_DIR/apps/desktop-pet"
STANDALONE_BINARY="$DESKTOP_DIR/bin/personal-companion-desktop"
RELEASE_BINARY="$DESKTOP_DIR/src-tauri/target/release/personal-companion-desktop"
INSTALLED_APP="/Applications/Emilia Companion.app"
VITE_PID=""

# Finder launches .command files with a smaller PATH than an interactive shell.
# This Mac currently has Node 24 under /usr/local and an older Homebrew Node under
# /opt/homebrew, so prefer /usr/local instead of accepting whichever one Finder sees first.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"

pause_on_error() {
  local exit_code="${1:-1}"
  echo
  echo "启动失败。上面的提示通常会说明缺少什么。"
  read -r -p "按回车键关闭这个窗口..." _
  exit "$exit_code"
}

cleanup() {
  if [[ -n "$VITE_PID" ]] && kill -0 "$VITE_PID" 2>/dev/null; then
    kill "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR" || pause_on_error 1

echo "========================================"
echo "  Emilia 桌面端一键启动"
echo "========================================"
echo

if [[ -d "$INSTALLED_APP" && "${EMILIA_DESKTOP_DEV:-0}" != "1" ]]; then
  echo "正在启动已安装的 Emilia Companion..."
  open "$INSTALLED_APP"
  exit $?
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 24 或更高版本："
  echo "https://nodejs.org/"
  pause_on_error 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "当前 Node.js 版本是 $(node --version)，本项目需要 Node.js 24 或更高版本。"
  pause_on_error 1
fi

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  echo "未找到 pnpm 或 corepack。请先执行：npm install -g pnpm"
  pause_on_error 1
fi

if [[ ! -d "$PROJECT_DIR/node_modules" || ! -d "$DESKTOP_DIR/node_modules" ]]; then
  echo "首次启动：正在安装项目依赖..."
  "${PNPM[@]}" install --frozen-lockfile
  INSTALL_EXIT=$?
  if [[ "$INSTALL_EXIT" -ne 0 ]]; then
    pause_on_error "$INSTALL_EXIT"
  fi
  echo
fi

if [[ -x "$STANDALONE_BINARY" && "${EMILIA_DESKTOP_DEV:-0}" != "1" ]]; then
  echo "正在启动桌宠..."
  "$STANDALONE_BINARY"
  STANDALONE_EXIT=$?
  if [[ "$STANDALONE_EXIT" -ne 0 ]]; then
    pause_on_error "$STANDALONE_EXIT"
  fi
  exit 0
fi

if command -v cargo >/dev/null 2>&1 && [[ "${EMILIA_DESKTOP_DEV:-0}" == "1" ]]; then
  echo "正在启动桌宠..."
  echo "关闭桌宠后，本窗口会自动结束。"
  echo
  "${PNPM[@]}" desktop:dev
  DESKTOP_EXIT=$?
  if [[ "$DESKTOP_EXIT" -ne 0 ]]; then
    pause_on_error "$DESKTOP_EXIT"
  fi
  exit 0
fi

if [[ ! -x "$STANDALONE_BINARY" && ! -x "$RELEASE_BINARY" ]]; then
  echo "没有找到独立桌面运行器。"
  echo "请先安装 Rust：https://rustup.rs/"
  echo "然后执行 pnpm --dir apps/desktop-pet tauri build --no-bundle"
  pause_on_error 1
fi

echo "正在启动刚编译的 release 运行器..."
"$RELEASE_BINARY"
RELEASE_EXIT=$?
if [[ "$RELEASE_EXIT" -ne 0 ]]; then
  pause_on_error "$RELEASE_EXIT"
fi
