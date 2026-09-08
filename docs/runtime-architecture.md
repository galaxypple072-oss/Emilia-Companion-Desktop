# 运行模块规范（目标架构）

目标是让使用者只需要安装客户端、选择一台主机并完成一次配对；不需要理解端口、计划任务、Core、QQ 或 GPT-SoVITS 的启动顺序。

## 稳定角色

| 角色 | 数量 | 职责 | 可以运行的位置 |
| --- | ---: | --- | --- |
| Companion Core | 每个档案恰好一个活动实例 | 对话、记忆、任务、策略与能力调度 | Windows 或 macOS |
| Host Agent | 每台提供能力的主机一个 | 自启动、健康检查、日志、更新及 worker 管理 | Windows 或 macOS |
| Worker | 可选、可多个 | QQ、语音、以后可能的本地文件/设备能力 | 有对应资源的主机 |
| Desktop Client | 可多个 | 聊天、播放、立绘、设备控制 | Windows 或 macOS |
| Relay | 每个档案一个可达入口 | 只转发端到端加密帧，不保存聊天或音频 | 本机/服务器 |

Core 不再假定 QQ 和语音与它同机。Windows 仍然可以作为 QQ + GPT-SoVITS 主机，Mac 则可以作为 Core 主机；它们通过 Relay 的加密能力通道协作。

```text
Desktop Client ──┐
                ├── encrypted Relay ── Companion Core (Mac or Windows)
QQ Worker ───────┤                         │
Voice Worker ────┘                         └── schedules / memory / policy
```

Relay 看不到对话、音频或 worker 的能力声明。它只验证配对凭据和转发目标；Core 再依据能力清单决定是否调用某个 worker。

## 一致的生命周期

每个可运行模块都遵守以下约定：

1. 由 Host Agent 启动，而不是互相拉起或依赖桌面窗口。
2. 本地依赖仅监听 loopback；跨主机通信只走加密 Relay。
3. 模块先做 health check，再宣告自己的能力，断线后指数退避重连。
4. 一个模块有一个稳定 ID、一份自己的日志和一个可读的健康状态。
5. Core 对同一档案实行单主锁；切换主机前先停旧 Core，再启动新 Core。

现有 9872/9873 仍是 Windows Voice Worker 的内部端口，绝不成为 Mac 或客户端需要手填的地址。

## 已落地的第一层

`packages/companion-relay-protocol` 现在定义了统一的节点角色和严格能力声明：

- `core`：唯一的调度者；
- `client`：桌面端；
- `worker`：能力提供者；
- 初始能力：`voice.synthesize`、`qq.receive`、`qq.send`、`host.health`。

Worker 以 `runtime.announce` 在加密帧中声明能力；Core 会绑定声明 ID 和经认证的 Relay peer ID，防止一个已配对节点冒充另一个节点。该层已经兼容现有 client 协议，不改变当前语音和桌面端的工作方式。

早期 Relay 只认识 `core` 与 `client` 两种登录角色。新 Voice Worker 会先尝试 `worker`，若旧 Relay 拒绝该角色则自动以兼容 transport 重连；能力声明仍在加密帧内并由 Core 校验。升级 Relay 后会自动恢复原生 `worker` 角色，无需重新配对。

## 迁移次序

这不是一次性重写，顺序如下：

1. **能力通道（已完成）**：Relay 支持 worker；Core 记录并校验 worker 宣告。
2. **Host Agent**：把 Windows 的计划任务、隐藏窗口和多份启动脚本收成一个跨平台后台服务。它只暴露“启动 / 停止 / 修复 / 诊断”四个用户动作。
3. **Voice Worker（已实现，待部署）**：本地 `VoiceClient` 已抽象成 provider；远端 worker 优先、loopback 自动回退。Windows worker 只访问本机 9873，音频经 Relay 分块返回，不再要求 Core 与 9873 同机。
4. **QQ Worker**：QQ/NapCat 连接移出 Core，变成同一套 worker 协议的实现。
5. **Core 迁移向导**：加密导出档案、停旧 Core、启动新 Core、让 workers 自动重连；全过程有回滚点。

在第 3、4 步完成前，Windows 一体机仍可继续使用，避免为了架构调整破坏当前可用功能。

## 最终用户体验

- 第一次：安装桌面端，创建/扫描一次连接码；选择“这台电脑作为主机”或“连接已有主机”。
- Windows 资源机：安装 Host Agent 后，只勾选“提供 QQ”“提供 Emilia 语音”；无需看端口和任务计划程序。
- 日常：开机后 Host Agent 静默自愈，桌面端仅显示“Core / QQ / 语音”的绿色、黄色或红色状态，并提供一个“修复”按钮。
- 迁移 Core：在设置中选择新主机；不是改 IP、复制 `.env` 或手动重启多个进程。
