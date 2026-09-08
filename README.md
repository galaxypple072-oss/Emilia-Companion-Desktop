# Personal Companion

This repository starts with the highest-risk vertical slice: proving that a dedicated QQ
account can receive and proactively send private messages through NapCat/OneBot without an
LLM in the loop.

## Step 01: QQ proactive-message probe

The probe has no third-party JavaScript dependencies. It uses Node.js 24's built-in `fetch`,
`WebSocket`, TypeScript stripping, and test runner.

### Safety boundaries

- Use a dedicated QQ account, never your primary account, for the NapCat login.
- Restrict OneBot HTTP and WebSocket ports to the Product Core host with the Windows firewall.
- Configure a long random access token in NapCat WebUI.
- Put only your primary QQ in `ONEBOT_ALLOWED_QQ` for the first test.
- Never forward ports 3000 or 3001 through the router or expose them to the public internet.
- NapCat is an unofficial protocol-side integration. Account restrictions and breakage after
  QQ updates remain possible.

### 1. Current deployment: NapCatQQ Desktop on Windows

NapCatQQ Desktop and the dedicated QQ account run on a Windows x64 host. The Product Core runs
on the Mac and connects over the local network:

- OneBot HTTP server: Windows port `3000`
- OneBot WebSocket server: Windows port `3001`
- Windows firewall: allow only the Mac's private IPv4 address
- Both servers use the same random access token

The current Windows host is `192.168.3.41`; update `.env` and the firewall rule if DHCP changes
that address. The old Docker Compose files remain available as an alternative deployment path.

### 2. Import a NapCatQQ Desktop configuration

Copy the Desktop `bot.json` and a file containing the primary QQ number to a trusted temporary
location, then run:

```bash
pnpm napcat:import-desktop -- \
  --config /trusted/temp/bot.json \
  --owner-file /trusted/temp/owner-qq.txt \
  --host WINDOWS_PRIVATE_IP
```

This validates that HTTP and WebSocket use the same token and creates `.env` with permission
mode `0600`. The command refuses to overwrite an existing credential file. Delete the temporary
copies after a successful import.

In NapCatQQ Desktop, enable:

| Service | Windows port | Listener | Token |
| --- | --- | --- | --- |
| OneBot HTTP forward server | `3000` | `0.0.0.0` | random shared value |
| OneBot WebSocket forward server | `3001` | `0.0.0.0` | same value |

The broad listener is safe only while the Windows firewall remains scoped to the Product Core
host. Do not add an unrestricted inbound rule.

### 3. Verify NapCat login and API connectivity

```bash
pnpm qq:status
```

Expected result: JSON containing `connected: true`, the dedicated bot account's login
information, and OneBot status data.

### 4. Send the first proactive private message

No inbound QQ message is required before this command:

```bash
pnpm qq:send --to YOUR_PRIMARY_QQ --text "主动消息链路测试成功"
```

The command refuses recipients not listed in `ONEBOT_ALLOWED_QQ`.

### 5. Verify inbound events

Listen for one allowlisted private message and exit:

```bash
pnpm qq:listen --once
```

For a temporary echo test:

```bash
pnpm qq:listen --echo --once
```

Messages from non-allowlisted accounts are ignored and their QQ numbers are not logged.

### Tests

```bash
pnpm test
```

## Step 01 acceptance checklist

- [x] `qq:status` confirms the dedicated QQ account is logged in.
- [x] `qq:send` reaches the allowlisted primary QQ without a preceding inbound message.
- [x] A private message event reaches the Mac over WebSocket.
- [ ] `qq:listen --echo --once` sends a reply.
- [x] A non-allowlisted recipient is rejected locally.
- [x] Windows firewall limits HTTP and WebSocket access to the Product Core host.

The next milestone begins only after this checklist passes: persist outbound messages and
scheduled reminders in the Product Core.

## Product Core v0.1

The Product Core is a model-independent reliability layer. It stores inbound private messages
and all outbound work in SQLite before processing it. Delivery is at-least-once: interrupted
work is recovered on startup and transient failures use bounded exponential backoff.

On Windows, the default database location is:

```text
%LOCALAPPDATA%\PersonalCompanion\product-core.sqlite
```

Initialize and inspect the store:

```bash
npm run core:init
npm run core:status
```

Run the persistent worker:

```bash
npm run core:run
```

Queue an immediate proactive message or a durable reminder:

```bash
npm run core:send -- --text "主动消息"
npm run core:remind -- --in 10m --text "十分钟后提醒我"
npm run core:remind -- --at 2026-08-25T09:00:00+08:00 --text "早上好"
```

Inspect persisted inbound messages without printing the owner QQ number:

```bash
npm run core:inbox -- --limit 20
```

The Core writes logs under `%LOCALAPPDATA%\PersonalCompanion\logs` and rotates the active log
after it reaches 5 MB.

Register the Core to start when the dedicated Windows user logs on, restart after failures,
and continue while the device is on battery:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-core-task-windows.ps1
```

The task invokes the single `start-core-service.ps1` launcher under the current interactive user.
It does not store a Windows password; the launcher keeps a process-lifetime mutex, checks the
local bridge port before starting Node, and exits quietly when another Core already owns it.

For the target cross-platform layout—one Core, optional QQ/voice workers, many desktop clients,
and a single Host Agent per machine—see [运行模块规范](docs/runtime-architecture.md). The current
Windows all-in-one setup remains supported while those workers are extracted behind the same
encrypted Relay protocol.

The Windows voice worker is installed as one background task (not a terminal):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-voice-worker-task-windows.ps1
```

It reads the already-configured Relay pairing profile from the project and the GPT-SoVITS token
only from the local voice runtime. It keeps `9873` on loopback and makes no firewall changes.

## Desktop Companion Bridge

The optional Companion Bridge lets desktop clients use the same agent, persona, long-term
memory, and Harness tools as QQ without exposing NapCat or provider credentials. Desktop
messages are stored in the shared conversation history, while delivery stays source-aware:
a Mac message is answered on the Mac and a QQ message is still answered on QQ.

On the Windows Core host, run PowerShell as administrator:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-companion-bridge-windows.ps1
```

The script creates a dedicated 256-bit bridge token, places it on the Windows clipboard,
updates `.env`, and opens TCP `8765` only for the private local subnet. Restart Product Core,
then open the Mac desktop pet, click `聊`, and enter:

```text
Core 地址: ws://WINDOWS_PRIVATE_IP:8765
访问 Token: the token copied by the Windows setup script
```

Plain `ws://` is intended only for a trusted LAN. A remotely reachable deployment must use
`wss://` behind TLS or a private overlay network; never forward the bridge or OneBot ports
directly through a home router.

### Mac device MCP capabilities

The Mac client advertises a fixed device-capability allowlist through the encrypted bridge. All
capabilities except basic device information are off by default. Open `聊 -> 设置 -> 本机设备能力`
to select file roots and enable individual read-only tools. Core can then list and search those
roots, read recognized text files, and parse PDF, DOCX, or XLSX documents. Documents are limited
to 8 MB and are end-to-end encrypted to the owner's Windows Core before local parsing.

Screen analysis is a separate switch and only runs after an explicit owner request. macOS may
request Screen Recording permission the first time; grant it to the desktop companion and restart
the client. Large document and screenshot results are split into authenticated encrypted frames,
so the public relay never receives plaintext content. No device tool exposes a shell, deletion,
overwrite, or access outside the roots chosen on the Mac.

For macOS privacy permissions, run the installed `/Applications/Emilia Companion.app` rather than
the raw executable under `apps/desktop-pet/bin`. The app bundle has the stable identifier
`com.personal-companion.emilia` and includes `NSScreenCaptureUsageDescription`. Development builds
are currently ad-hoc signed; screen-capture approval can be lost after rebuilding until an Apple
Development or Developer ID signing certificate is configured.

## Agent and persona layer

Normal owner messages can be answered through any OpenAI Chat Completions-compatible endpoint.
The model is optional: without `AGENT_API_KEY`, inbound messages and local commands continue to
work but no external model is called.

### Character evaluation lab

Character changes are evaluated in a separate SQLite database. Replies are shown as anonymous,
randomly ordered A/B pairs: deterministic metrics flag protocol and style failures, while the
owner's blind preference remains the primary decision signal and is never merged into an opaque
AI-generated score.

```bash
pnpm character-eval:init
pnpm character-eval:run -- --limit 10 --repetitions 2
pnpm character-eval:review
pnpm character-eval:report
pnpm character-eval:export
```

Open `http://127.0.0.1:8787` after starting the review command. Test cases live in
`eval/character/cases.jsonl`; prompt variants live in `eval/character/prompts`. Every run stores
the prompt hashes, model names, raw replies, hard metrics, randomized side mapping, owner choice,
reason tags, confidence, and optional notes. Use at least three generations per important case
before promoting a candidate because role-playing models are stochastic.

Example configuration for the current DeepSeek API:

```dotenv
AGENT_BASE_URL=https://api.deepseek.com
AGENT_API_KEY=store-this-only-in-.env
AGENT_MODEL=deepseek-v4-flash
AGENT_THINKING=disabled
AGENT_CONTEXT_MESSAGES=20
```

The API key is never written to SQLite or logs. The adapter receives only the persona prompt and
the bounded recent conversation. Deterministic commands bypass the model:

An optional role-playing model can handle only casual, venting, and emotional turns. Operational
requests and factual questions remain on the primary DeepSeek/Harness agent, so the character model
never receives tool authority. The current Qwen Character experiment uses:

```dotenv
ROLEPLAY_ENABLED=true
ROLEPLAY_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ROLEPLAY_API_KEY=store-this-only-in-.env
ROLEPLAY_MODEL=qwen-flash-character-2026-02-26
```

Configure it on Windows without printing the key, then run `npm run roleplay:verify` before restarting
the Core:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-roleplay-windows.ps1
npm run roleplay:verify
```

```text
/status
/quiet on
/quiet off
/interest add DeepSeek 和 AI Agent
/interests
/interest remove 兴趣编号
/discover on
/discover off
/discover status
/discover now
/location 上海
/location status
/location clear
/weather on
/weather off
/weather status
/weather now
/tasks
/todo 2h 整理项目资料
/done 任务编号
/snooze 任务编号 1h
/task cancel 任务编号
/remind 10m 提醒内容
/email 收件人 | 主题 | 正文
/contacts
/contact add 别名 邮箱
/contact remove 别名
/actions
/confirm 行动编号
/cancel 行动编号
/help
```

Email is a confirmation-gated action. A request creates a durable draft and returns a short
action id; SMTP delivery starts only after the owner sends `/confirm <id>`. `/cancel <id>`
cancels a pending draft, and `/actions` shows recent audit state. The action table provides
deduplication, restart recovery, bounded retries, and completion/failure receipts. The Harness
MCP tools can list saved contacts and create a `draft_email` for either a contact alias or one
explicit address; neither tool can bypass this confirmation gate.

On Windows, configure the provider without exposing the API key to terminal history or chat:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-agent-windows.ps1
```

The key prompt is hidden. Restart the `PersonalCompanionCore` scheduled task after changing the
agent configuration.
