use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const CONNECTION_PROFILE_SERVICE: &str = "com.personal-companion.emilia";
const CONNECTION_PROFILE_ACCOUNT: &str = "connection-profile";
const FILE_ROOTS_ACCOUNT: &str = "device-file-roots";
const DEVICE_PERMISSIONS_ACCOUNT: &str = "device-permissions";
const DEVICE_CAPABILITIES: &[&str] = &[
    "device.info", "notification.show", "url.open", "clipboard.write", "clipboard.read",
    "files.roots", "files.list", "files.search", "files.read_text", "files.read_document",
    "files.read_binary", "screen.capture",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceFileEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: Option<u64>,
    modified_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceTextFile {
    path: String,
    text: String,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceBinaryFile {
    path: String,
    name: String,
    media_type: &'static str,
    size: usize,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfo {
    platform: &'static str,
    arch: &'static str,
    app_version: &'static str,
    hostname: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreServiceStatus {
    supported: bool,
    installed: bool,
    running: bool,
    task_state: String,
    pid: Option<u32>,
    bridge_listening: bool,
    control_listening: bool,
    log_path: String,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceServiceStatus {
    supported: bool,
    installed: bool,
    running: bool,
    task_state: String,
    pid: Option<u32>,
    service_listening: bool,
    gradio_listening: bool,
    gpt_weight: String,
    sovits_weight: String,
    last_output: String,
    log_path: String,
    error_log_path: String,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceDiagnosis {
    supported: bool,
    service_listening: bool,
    gradio_listening: bool,
    synthesis: String,
    detail: String,
}

fn app_log_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Logs"));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = None;
    base.map(|path| path.join("PersonalCompanion/logs/desktop-client.log"))
}

fn write_app_log(level: &str, message: &str) {
    let Some(path) = app_log_path() else { return };
    if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else { return };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let sanitized = message.replace(['\r', '\n'], " ");
    let _ = writeln!(file, "[{now}] [{level}] {}", sanitized.chars().take(4000).collect::<String>());
}

#[tauri::command]
fn device_get_info() -> DeviceInfo {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Desktop".to_string())
        .chars()
        .take(80)
        .collect();
    DeviceInfo {
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        app_version: env!("CARGO_PKG_VERSION"),
        hostname,
    }
}

#[tauri::command]
fn device_read_clipboard(app: AppHandle) -> Result<String, String> {
    app.clipboard().read_text().map_err(|error| format!("无法读取剪贴板：{error}"))
}

#[tauri::command]
fn device_write_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    if text.is_empty() || text.chars().count() > 20_000 {
        return Err("剪贴板文字长度不合规".to_string());
    }
    app.clipboard().write_text(text).map_err(|error| format!("无法写入剪贴板：{error}"))
}

#[tauri::command]
fn device_open_url(app: AppHandle, url: String) -> Result<(), String> {
    if url.len() > 2048 || !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只允许打开 http 或 https 网页".to_string());
    }
    app.opener().open_url(url, None::<&str>).map_err(|error| format!("无法打开网页：{error}"))
}

#[tauri::command]
fn device_show_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    if title.is_empty() || title.chars().count() > 80 || body.is_empty() || body.chars().count() > 500 {
        return Err("通知内容长度不合规".to_string());
    }
    app.notification().builder().title(title).body(body).show()
        .map_err(|error| format!("无法显示通知：{error}"))
}

#[tauri::command]
fn frontend_report_error(message: String) {
    let message = message.chars().take(4000).collect::<String>();
    write_app_log("frontend", &message);
    eprintln!("[desktop-frontend] {message}");
}

#[cfg(target_os = "windows")]
fn powershell_output(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("无法调用 Windows 服务管理器：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Starts the local voice stack from the desktop client, rather than requiring
/// a separate terminal ritual. The large model files remain in the configured
/// voice runtime directory; they are deliberately not duplicated inside the
/// desktop executable.
#[cfg(target_os = "windows")]
fn ensure_voice_stack() {
    if std::env::var("EMILIA_VOICE_AUTOSTART").ok().as_deref() == Some("false") {
        return;
    }
    let script = r#"
$voiceReady = [bool](Get-NetTCPConnection -LocalPort 9873 -State Listen -ErrorAction SilentlyContinue)
if (-not $voiceReady) { Start-ScheduledTask -TaskName 'Emilia Voice Service' -ErrorAction SilentlyContinue }
$engineReady = [bool](Get-NetTCPConnection -LocalPort 9872 -State Listen -ErrorAction SilentlyContinue)
$root = 'D:\EmiliaVoice\GPT-SoVITS'
$launcher = "$root\companion-voice-service\start-gpt-sovits-engine.cmd"
if (-not $engineReady -and (Test-Path $launcher)) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c',$launcher -WorkingDirectory $root -WindowStyle Hidden
} elseif (-not $engineReady) {
  $python = if (Test-Path "$root\.venv\Scripts\python.exe") { "$root\.venv\Scripts\python.exe" } else { '' }
  if ($python) { Start-Process -FilePath $python -ArgumentList 'webui.py','zh_CN' -WorkingDirectory $root -WindowStyle Hidden }
}
"#;
    let _ = powershell_output(script);
    write_app_log("voice", "voice stack auto-start requested");
}

#[cfg(target_os = "windows")]
fn redact_voice_detail(value: String) -> String {
    let mut result = value.replace("\r", " ").replace("\n", " ");
    for marker in ["VOICE_SERVICE_TOKEN=", "Bearer "] {
        if let Some(start) = result.find(marker) {
            let value_start = start + marker.len();
            let end = result[value_start..]
                .find(|character: char| character.is_whitespace() || character == '\"')
                .map(|offset| value_start + offset)
                .unwrap_or(result.len());
            result.replace_range(value_start..end, "<redacted>");
        }
    }
    result.chars().take(1200).collect()
}

#[tauri::command]
fn voice_service_status() -> Result<VoiceServiceStatus, String> {
    #[cfg(target_os = "windows")]
    {
        let root = PathBuf::from(r"D:\EmiliaVoice\GPT-SoVITS");
        let log_path = root.join("companion-voice-service/voice-service.log");
        let error_log_path = root.join("companion-voice-service/voice-service.err.log");
        let script = r#"[Console]::OutputEncoding = [Text.Encoding]::UTF8
$task = Get-ScheduledTask -TaskName 'Emilia Voice Service' -ErrorAction SilentlyContinue
$service = Get-NetTCPConnection -LocalPort 9873 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$gradio = [bool](Get-NetTCPConnection -LocalPort 9872 -State Listen -ErrorAction SilentlyContinue)
$cfg = @{}
$envPath = 'D:\EmiliaVoice\GPT-SoVITS\.env.voice'
if (Test-Path -LiteralPath $envPath) {
  Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^(VOICE_GPT_WEIGHT|VOICE_SOVITS_WEIGHT)=(.*)$') { $cfg[$matches[1]] = $matches[2] }
  }
}
$latest = Get-ChildItem 'D:\EmiliaVoice\voice-output' -Filter '*.wav' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
[pscustomobject]@{
  installed = [bool]$task
  running = [bool]$service
  taskState = if ($task) { [string]$task.State } else { 'Missing' }
  pid = if ($service) { [uint32]$service.OwningProcess } else { $null }
  serviceListening = [bool]$service
  gradioListening = $gradio
  gptWeight = [string]$cfg['VOICE_GPT_WEIGHT']
  sovitsWeight = [string]$cfg['VOICE_SOVITS_WEIGHT']
  lastOutput = if ($latest) { "$($latest.Name) · $($latest.LastWriteTime.ToString('HH:mm:ss'))" } else { '暂无生成文件' }
} | ConvertTo-Json -Compress"#;
        let raw = powershell_output(script)?;
        let value: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| format!("语音服务状态返回格式异常：{raw}"))?;
        let running = value["running"].as_bool().unwrap_or(false);
        let gradio = value["gradioListening"].as_bool().unwrap_or(false);
        return Ok(VoiceServiceStatus {
            supported: true,
            installed: value["installed"].as_bool().unwrap_or(false),
            running,
            task_state: value["taskState"].as_str().unwrap_or("Unknown").to_string(),
            pid: value["pid"].as_u64().map(|pid| pid as u32),
            service_listening: running,
            gradio_listening: gradio,
            gpt_weight: value["gptWeight"].as_str().unwrap_or("未读取").to_string(),
            sovits_weight: value["sovitsWeight"].as_str().unwrap_or("未读取").to_string(),
            last_output: value["lastOutput"].as_str().unwrap_or("暂无生成文件").to_string(),
            log_path: log_path.to_string_lossy().into_owned(),
            error_log_path: error_log_path.to_string_lossy().into_owned(),
            detail: if running && gradio { "本地语音服务与 GPT-SoVITS 都在监听".to_string() } else if running { "语音服务在线，但 GPT-SoVITS 未监听 9872".to_string() } else { "语音服务没有监听 9873".to_string() },
        });
    }
    #[cfg(not(target_os = "windows"))]
    Ok(VoiceServiceStatus {
        supported: false, installed: false, running: false, task_state: "Remote".to_string(), pid: None,
        service_listening: false, gradio_listening: false, gpt_weight: String::new(), sovits_weight: String::new(),
        last_output: String::new(), log_path: String::new(), error_log_path: String::new(),
        detail: "角色语音目前由托管 Core 的 Windows 设备运行".to_string(),
    })
}

#[tauri::command]
fn voice_service_control(action: String) -> Result<VoiceServiceStatus, String> {
    if !["start", "stop", "restart", "boot_stack"].contains(&action.as_str()) {
        return Err("不支持的语音服务操作".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let operation = match action.as_str() {
            "start" => "Start-ScheduledTask -TaskName 'Emilia Voice Service'",
            "stop" => "Stop-ScheduledTask -TaskName 'Emilia Voice Service'",
            "restart" => "Stop-ScheduledTask -TaskName 'Emilia Voice Service' -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 700; Start-ScheduledTask -TaskName 'Emilia Voice Service'",
            // The inference UI and bridge are one user-facing "voice stack".
            // The client launches both from the local runtime when needed.
            "boot_stack" => "Start-ScheduledTask -TaskName 'Emilia Voice Service' -ErrorAction SilentlyContinue; $root = 'D:\\EmiliaVoice\\GPT-SoVITS'; $launcher = \"$root\\companion-voice-service\\start-gpt-sovits-engine.cmd\"; if (-not (Get-NetTCPConnection -LocalPort 9872 -State Listen -ErrorAction SilentlyContinue) -and (Test-Path $launcher)) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c',$launcher -WorkingDirectory $root -WindowStyle Hidden }",
            _ => unreachable!(),
        };
        powershell_output(&format!("[Console]::OutputEncoding = [Text.Encoding]::UTF8; {operation}"))?;
        std::thread::sleep(std::time::Duration::from_millis(if action == "stop" { 350 } else if action == "boot_stack" { 3_000 } else { 1_400 }));
        write_app_log("voice", &format!("service action: {action}"));
        return voice_service_status();
    }
    #[cfg(not(target_os = "windows"))]
    Err("这台设备不托管角色语音服务".to_string())
}

#[tauri::command]
fn voice_service_diagnose() -> Result<VoiceDiagnosis, String> {
    #[cfg(target_os = "windows")]
    {
        ensure_voice_stack();
        // Cold loading the GPT and SoVITS weights can take around two minutes
        // on the Windows host. Keep the UI diagnosis aligned with its stated
        // two-and-a-half-minute budget instead of reporting a false failure.
        for _ in 0..150 {
            let ready = powershell_output("[bool](Get-NetTCPConnection -LocalPort 9872 -State Listen -ErrorAction SilentlyContinue)")
                .map(|value| value.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            if ready { break; }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        // The token is read and used only inside the local PowerShell process.
        // The result is a small diagnostic JSON object and never contains the token.
        let script = r#"[Console]::OutputEncoding = [Text.Encoding]::UTF8
$service = [bool](Get-NetTCPConnection -LocalPort 9873 -State Listen -ErrorAction SilentlyContinue)
$gradio = [bool](Get-NetTCPConnection -LocalPort 9872 -State Listen -ErrorAction SilentlyContinue)
$detail = ''
$state = '未运行'
if ($service) {
  try {
    $line = Get-Content 'D:\EmiliaVoice\GPT-SoVITS\.env.voice' | Where-Object { $_ -match '^VOICE_SERVICE_TOKEN=' } | Select-Object -First 1
    $token = ($line -replace '^VOICE_SERVICE_TOKEN=', '').Trim().Trim('"')
    $body = @{ text = 'おはよう'; preset = 'gentle' } | ConvertTo-Json -Compress
    # Windows PowerShell 5.1 otherwise serializes this Japanese diagnostic text
    # through the active legacy code page, turning it into question marks.
    $reply = Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:9873/v1/synthesize' -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -UseBasicParsing -TimeoutSec 150
    if ($reply.StatusCode -eq 200) { $state = '成功'; $detail = '已生成日语试听音频' } else { $state = "HTTP $($reply.StatusCode)" }
  } catch {
    $state = '失败'
    $status = $_.Exception.Response.StatusCode.value__
    $body = ''
    try { $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream()); $body = $reader.ReadToEnd() } catch {}
    if ($body) { $detail = $body } elseif ($status) { $detail = "HTTP $status" } else { $detail = $_.Exception.Message }
  }
}
[pscustomobject]@{ serviceListening = $service; gradioListening = $gradio; synthesis = $state; detail = $detail } | ConvertTo-Json -Compress"#;
        let raw = powershell_output(script)?;
        let value: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| format!("语音诊断返回格式异常：{raw}"))?;
        return Ok(VoiceDiagnosis {
            supported: true,
            service_listening: value["serviceListening"].as_bool().unwrap_or(false),
            gradio_listening: value["gradioListening"].as_bool().unwrap_or(false),
            synthesis: value["synthesis"].as_str().unwrap_or("失败").to_string(),
            detail: redact_voice_detail(value["detail"].as_str().unwrap_or("没有返回更多信息").to_string()),
        });
    }
    #[cfg(not(target_os = "windows"))]
    Ok(VoiceDiagnosis { supported: false, service_listening: false, gradio_listening: false, synthesis: "远端托管".to_string(), detail: "请在 Windows 的 Core 页面运行诊断".to_string() })
}

#[tauri::command]
fn voice_read_log(max_lines: usize) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let root = PathBuf::from(r"D:\EmiliaVoice\GPT-SoVITS\companion-voice-service");
        let paths = [
            root.join("engine-launch-diagnostic.log"),
            root.join("voice-service.err.log"),
            root.join("voice-service.log"),
        ];
        let mut lines = Vec::new();
        for path in paths {
            if let Ok(text) = fs::read_to_string(&path) {
                lines.extend(text.lines().rev().take(max_lines.clamp(10, 160)).map(str::to_string));
            }
        }
        if lines.is_empty() { return Ok("语音服务尚未写入可读取的日志".to_string()); }
        lines.reverse();
        return Ok(lines.into_iter().map(redact_voice_detail).collect::<Vec<_>>().join("\n"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = max_lines;
        Err("语音日志保存在托管 Core 的 Windows 设备上".to_string())
    }
}

#[tauri::command]
fn core_service_status() -> Result<CoreServiceStatus, String> {
    #[cfg(target_os = "windows")]
    {
        let log_path = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("PersonalCompanion/logs/product-core.log");
        let script = r#"[Console]::OutputEncoding = [Text.Encoding]::UTF8
$task = Get-ScheduledTask -TaskName 'Emilia Core Service' -ErrorAction SilentlyContinue
$process = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -like '*personal-companion*product-core*cli.ts*run*'
} | Select-Object -First 1
$bridge = [bool](Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
$control = [bool](Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue)
[pscustomobject]@{
  installed = [bool]$task
  running = [bool]$process
  taskState = if ($task) { [string]$task.State } else { 'Missing' }
  pid = if ($process) { [uint32]$process.ProcessId } else { $null }
  bridgeListening = $bridge
  controlListening = $control
} | ConvertTo-Json -Compress"#;
        let raw = powershell_output(script)?;
        let value: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| format!("Windows 服务状态返回格式异常：{raw}"))?;
        return Ok(CoreServiceStatus {
            supported: true,
            installed: value["installed"].as_bool().unwrap_or(false),
            running: value["running"].as_bool().unwrap_or(false),
            task_state: value["taskState"].as_str().unwrap_or("Unknown").to_string(),
            pid: value["pid"].as_u64().map(|pid| pid as u32),
            bridge_listening: value["bridgeListening"].as_bool().unwrap_or(false),
            control_listening: value["controlListening"].as_bool().unwrap_or(false),
            log_path: log_path.to_string_lossy().into_owned(),
            detail: "本机计划任务 · Emilia Core Service".to_string(),
        });
    }
    #[cfg(not(target_os = "windows"))]
    Ok(CoreServiceStatus {
        supported: false,
        installed: false,
        running: false,
        task_state: "Remote".to_string(),
        pid: None,
        bridge_listening: false,
        control_listening: false,
        log_path: String::new(),
        detail: "当前 Core 运行在另一台设备上，本机不接管它的系统进程".to_string(),
    })
}

#[tauri::command]
fn core_service_control(action: String) -> Result<CoreServiceStatus, String> {
    if !["start", "stop", "restart"].contains(&action.as_str()) {
        return Err("不支持的 Core 服务操作".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let operation = match action.as_str() {
            "start" => "Start-ScheduledTask -TaskName 'Emilia Core Service'",
            "stop" => "Stop-ScheduledTask -TaskName 'Emilia Core Service'",
            "restart" => "Stop-ScheduledTask -TaskName 'Emilia Core Service' -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600; Start-ScheduledTask -TaskName 'Emilia Core Service'",
            _ => unreachable!(),
        };
        let script = format!("[Console]::OutputEncoding = [Text.Encoding]::UTF8; {operation}");
        powershell_output(&script)?;
        std::thread::sleep(std::time::Duration::from_millis(if action == "stop" { 350 } else { 1200 }));
        write_app_log("core", &format!("service action: {action}"));
        return core_service_status();
    }
    #[cfg(not(target_os = "windows"))]
    Err("这台设备不托管 Core，不能管理远端系统进程".to_string())
}

#[tauri::command]
fn core_create_lan_connection_code() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        if !core_service_status()?.bridge_listening {
            return Err("Core 尚未启动，无法创建连接码".to_string());
        }
        let ip = powershell_output(r#"$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
if ($null -eq $route) { throw 'No default network route was found' }
$address = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1 -ExpandProperty IPAddress
if (-not $address) { throw 'No LAN IPv4 address was found' }
$address"#)?;
        let ip = ip.trim();
        let node = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
        let cli = PathBuf::from(r"C:\Users\zhyje\personal-companion\apps\product-core\src\cli.ts");
        if !node.is_file() || !cli.is_file() { return Err("Core connection-code tool is unavailable".to_string()); }
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let output = Command::new(node)
            .args(["--experimental-strip-types", cli.to_string_lossy().as_ref(), "connection-code", "--url", &format!("ws://{ip}:8765")])
            .current_dir(r"C:\Users\zhyje\personal-companion")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("无法生成连接码：{error}"))?;
        if !output.status.success() {
            return Err(redact_voice_detail(String::from_utf8_lossy(&output.stderr).into_owned()));
        }
        let payload: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| "Core 返回的连接码格式异常".to_string())?;
        let code = payload["code"].as_str().unwrap_or("").trim();
        if code.is_empty() { return Err("Core 没有生成连接码".to_string()); }
        write_app_log("connection", "generated a LAN connection code");
        return Ok(code.to_string());
    }
    #[cfg(not(target_os = "windows"))]
    Err("只有托管 Core 的 Windows 设备能生成局域网连接码".to_string())
}

#[tauri::command]
fn core_read_log(max_lines: usize) -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    let _ = max_lines;
    #[cfg(target_os = "windows")]
    {
        let path = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("PersonalCompanion/logs/product-core.log");
        let text = fs::read_to_string(&path).map_err(|error| format!("暂时无法读取 Core 日志：{error}"))?;
        let lines: Vec<&str> = text.lines().rev().take(max_lines.clamp(10, 300)).collect();
        return Ok(lines.into_iter().rev().collect::<Vec<_>>().join("\n"));
    }
    #[cfg(not(target_os = "windows"))]
    Err("Core 日志保存在托管 Core 的 Windows 设备上".to_string())
}

fn roots_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CONNECTION_PROFILE_SERVICE, FILE_ROOTS_ACCOUNT)
        .map_err(|error| format!("无法访问系统钥匙串：{error}"))
}

fn permissions_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CONNECTION_PROFILE_SERVICE, DEVICE_PERMISSIONS_ACCOUNT)
        .map_err(|error| format!("无法访问系统钥匙串：{error}"))
}

#[tauri::command]
fn device_get_permissions() -> Result<serde_json::Value, String> {
    let raw = match permissions_entry()?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => "{}".to_string(),
        Err(error) => return Err(format!("无法读取设备权限：{error}")),
    };
    let saved: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
    let mut permissions = serde_json::Map::new();
    for capability in DEVICE_CAPABILITIES {
        permissions.insert((*capability).to_string(), serde_json::Value::Bool(*capability == "device.info" || saved[*capability].as_bool().unwrap_or(false)));
    }
    Ok(serde_json::Value::Object(permissions))
}

#[tauri::command]
fn device_save_permissions(permissions: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut normalized = serde_json::Map::new();
    for capability in DEVICE_CAPABILITIES {
        normalized.insert((*capability).to_string(), serde_json::Value::Bool(*capability == "device.info" || permissions[*capability].as_bool().unwrap_or(false)));
    }
    let value = serde_json::Value::Object(normalized);
    permissions_entry()?.set_password(&value.to_string()).map_err(|error| format!("无法保存设备权限：{error}"))?;
    Ok(value)
}

fn load_file_roots() -> Result<Vec<PathBuf>, String> {
    let raw = match roots_entry()?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取授权目录：{error}")),
    };
    let saved: Vec<String> = serde_json::from_str(&raw).map_err(|_| "授权目录配置损坏".to_string())?;
    let mut roots = Vec::new();
    for value in saved {
        let Ok(path) = fs::canonicalize(value) else { continue };
        if path.is_dir() && !roots.iter().any(|root: &PathBuf| path.starts_with(root)) {
            roots.push(path);
        }
    }
    Ok(roots)
}

fn save_file_roots(roots: &[PathBuf]) -> Result<(), String> {
    let values: Vec<String> = roots.iter().map(|path| path.to_string_lossy().into_owned()).collect();
    let raw = serde_json::to_string(&values).map_err(|error| format!("无法保存授权目录：{error}"))?;
    roots_entry()?.set_password(&raw).map_err(|error| format!("无法保存授权目录：{error}"))
}

fn roots_payload(roots: Vec<PathBuf>) -> serde_json::Value {
    serde_json::json!({ "roots": roots.into_iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>() })
}

#[tauri::command]
fn device_get_file_roots() -> Result<serde_json::Value, String> {
    load_file_roots().map(roots_payload)
}

#[tauri::command]
fn device_choose_file_roots() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"$shell = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder(0, '选择允许艾米莉亚读取的文件夹', 0, 0)
if ($null -ne $folder) { $folder.Self.Path }"#;
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-Command", script])
            .output()
            .map_err(|error| format!("无法打开目录选择器：{error}"))?;
        if !output.status.success() {
            return Err(format!("目录选择失败：{}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            return load_file_roots().map(roots_payload);
        }
        let selected = fs::canonicalize(&value).map_err(|error| format!("无法读取目录 {value}：{error}"))?;
        if !selected.is_dir() { return Err("选择的位置不是文件夹".to_string()); }
        let mut roots = load_file_roots()?;
        if !roots.iter().any(|root| selected.starts_with(root)) {
            roots.retain(|root| !root.starts_with(&selected));
            roots.push(selected);
        }
        save_file_roots(&roots)?;
        return Ok(roots_payload(roots));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("当前平台暂未实现目录选择器".to_string());

    #[cfg(target_os = "macos")]
    {
        let script = r#"set selectedFolders to choose folder with prompt "选择允许艾米莉亚读取的文件夹" with multiple selections allowed
set output to ""
repeat with selectedFolder in selectedFolders
  set output to output & POSIX path of selectedFolder & linefeed
end repeat
return output"#;
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .output()
            .map_err(|error| format!("无法打开目录选择器：{error}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            if detail.contains("-128") || detail.to_lowercase().contains("cancel") {
                return load_file_roots().map(roots_payload);
            }
            return Err(format!("目录选择失败：{}", detail.trim()));
        }
        let mut roots = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let value = line.trim();
            if value.is_empty() { continue; }
            let path = fs::canonicalize(value).map_err(|error| format!("无法读取目录 {value}：{error}"))?;
            if path.is_dir() && !roots.iter().any(|root: &PathBuf| path.starts_with(root)) {
                roots.push(path);
            }
        }
        if roots.is_empty() { return Err("没有选择任何目录".to_string()); }
        save_file_roots(&roots)?;
        Ok(roots_payload(roots))
    }
}

fn allowed_path(input: &str, expect_directory: Option<bool>) -> Result<PathBuf, String> {
    if input.is_empty() || input.len() > 2000 { return Err("路径格式不正确".to_string()); }
    let path = fs::canonicalize(input).map_err(|_| "文件或目录不存在".to_string())?;
    let roots = load_file_roots()?;
    if roots.is_empty() { return Err("请先在客户端选择允许访问的文件夹".to_string()); }
    if !roots.iter().any(|root| path.starts_with(root)) { return Err("路径不在本机授权目录内".to_string()); }
    if expect_directory == Some(true) && !path.is_dir() { return Err("路径不是文件夹".to_string()); }
    if expect_directory == Some(false) && !path.is_file() { return Err("路径不是文件".to_string()); }
    Ok(path)
}

fn file_entry(path: &Path, metadata: &fs::Metadata) -> DeviceFileEntry {
    DeviceFileEntry {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        kind: if metadata.is_dir() { "directory" } else { "file" },
        size: metadata.is_file().then_some(metadata.len()),
        modified_at: metadata.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok()).map(|value| value.as_millis() as u64),
    }
}

#[tauri::command]
fn device_list_directory(path: String) -> Result<Vec<DeviceFileEntry>, String> {
    let directory = allowed_path(&path, Some(true))?;
    let mut entries = Vec::new();
    let children = fs::read_dir(directory).map_err(|error| format!("无法读取目录：{error}"))?;
    for child in children.take(300) {
        let Ok(child) = child else { continue };
        let Ok(kind) = child.file_type() else { continue };
        if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) { continue; }
        let Ok(metadata) = child.metadata() else { continue };
        entries.push(file_entry(&child.path(), &metadata));
    }
    entries.sort_by(|left, right| left.kind.cmp(right.kind).then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase())));
    Ok(entries)
}

#[tauri::command]
fn device_search_files(root: String, query: String, max_results: usize) -> Result<Vec<DeviceFileEntry>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() || needle.chars().count() > 200 { return Err("搜索词格式不正确".to_string()); }
    let roots = if root.trim().is_empty() { load_file_roots()? } else { vec![allowed_path(&root, Some(true))?] };
    if roots.is_empty() { return Err("请先在客户端选择允许访问的文件夹".to_string()); }
    let limit = max_results.clamp(1, 100);
    let mut results = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = roots.into_iter().map(|path| (path, 0)).collect();
    let mut visited = 0usize;
    while let Some((directory, depth)) = stack.pop() {
        if depth > 8 || visited >= 10_000 || results.len() >= limit { continue; }
        let Ok(children) = fs::read_dir(directory) else { continue };
        for child in children {
            if visited >= 10_000 || results.len() >= limit { break; }
            visited += 1;
            let Ok(child) = child else { continue };
            let Ok(kind) = child.file_type() else { continue };
            if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) { continue; }
            let path = child.path();
            if child.file_name().to_string_lossy().to_lowercase().contains(&needle) {
                if let Ok(metadata) = child.metadata() { results.push(file_entry(&path, &metadata)); }
            }
            if kind.is_dir() { stack.push((path, depth + 1)); }
        }
    }
    Ok(results)
}

#[tauri::command]
fn device_read_text_file(path: String, max_chars: usize) -> Result<DeviceTextFile, String> {
    let path = allowed_path(&path, Some(false))?;
    let extension = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    const TEXT_EXTENSIONS: &[&str] = &["txt", "md", "json", "jsonl", "csv", "tsv", "xml", "yaml", "yml", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "html", "htm", "py", "java", "c", "h", "cpp", "hpp", "rs", "go", "sql", "log", "ini", "toml"];
    if !TEXT_EXTENSIONS.contains(&extension.as_str()) { return Err("只允许读取常见文本和代码文件".to_string()); }
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取文件：{error}"))?;
    if metadata.len() > 2 * 1024 * 1024 { return Err("文本文件超过 2 MB 限制".to_string()); }
    let text = fs::read_to_string(&path).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())?;
    let limit = max_chars.clamp(1000, 50_000);
    let truncated = text.chars().count() > limit;
    let content: String = text.chars().take(limit).collect();
    Ok(DeviceTextFile { path: path.to_string_lossy().into_owned(), text: content, truncated })
}

#[tauri::command]
fn device_read_document(path: String) -> Result<DeviceBinaryFile, String> {
    let path = allowed_path(&path, Some(false))?;
    let extension = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    if !["pdf", "docx", "xlsx"].contains(&extension.as_str()) { return Err("仅支持 PDF、DOCX 和 XLSX 文档".to_string()); }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取文档：{error}"))?;
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 { return Err("文档必须小于 8 MB".to_string()); }
    Ok(DeviceBinaryFile {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        media_type: "application/octet-stream",
        size: bytes.len(),
        data: BASE64.encode(bytes),
    })
}

#[tauri::command]
fn device_read_binary_file(path: String) -> Result<DeviceBinaryFile, String> {
    let path = allowed_path(&path, Some(false))?;
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取文件：{error}"))?;
    if !metadata.is_file() {
        return Err("只能发送普通文件".to_string());
    }
    if metadata.len() == 0 || metadata.len() > 20 * 1024 * 1024 {
        return Err("文件必须大于 0 B 且不超过 20 MB".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取文件：{error}"))?;
    Ok(DeviceBinaryFile {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        media_type: "application/octet-stream",
        size: bytes.len(),
        data: BASE64.encode(bytes),
    })
}

#[tauri::command]
fn device_read_image_preview(path: String) -> Result<DeviceBinaryFile, String> {
    let path = allowed_path(&path, Some(false))?;
    let extension = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    let media_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err("仅支持预览 PNG、JPEG、GIF 和 WebP 图片".to_string()),
    };
    let bytes = fs::read(&path).map_err(|error| format!("无法读取图片：{error}"))?;
    if bytes.is_empty() || bytes.len() > 12 * 1024 * 1024 {
        return Err("图片必须小于 12 MB".to_string());
    }
    Ok(DeviceBinaryFile {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        media_type,
        size: bytes.len(),
        data: BASE64.encode(bytes),
    })
}

#[tauri::command]
fn device_reveal_path(path: String) -> Result<(), String> {
    let path = allowed_path(&path, None)?;
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/open").arg("-R").arg(&path).status()
            .map_err(|error| format!("无法打开 Finder：{error}"))?;
        if !status.success() { return Err("Finder 无法显示这个文件".to_string()); }
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let status = Command::new("explorer.exe").arg(format!("/select,{}", path.display())).status()
            .map_err(|error| format!("无法打开资源管理器：{error}"))?;
        if !status.success() { return Err("资源管理器无法显示这个文件".to_string()); }
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("当前平台暂不支持在文件管理器中显示".to_string())
}

#[tauri::command]
fn device_capture_screen() -> Result<DeviceBinaryFile, String> {
    #[cfg(target_os = "windows")]
    {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let path = std::env::temp_dir().join(format!("emilia-screen-{}-{nonce}.png", std::process::id()));
        let escaped_path = path.to_string_lossy().replace('\'', "''");
        let script = format!(r#"Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$image = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($image)
try {{
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $image.Save('{escaped_path}', [System.Drawing.Imaging.ImageFormat]::Png)
}} finally {{
  $graphics.Dispose()
  $image.Dispose()
}}"#);
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|error| format!("无法调用系统截图：{error}"))?;
        if !output.status.success() {
            return Err(format!("截图失败：{}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        let bytes = fs::read(&path).map_err(|error| format!("无法读取截图：{error}"));
        let _ = fs::remove_file(&path);
        let bytes = bytes?;
        if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 { return Err("截图大小超过 20 MB 限制".to_string()); }
        return Ok(DeviceBinaryFile {
            path: "screen://virtual-desktop".to_string(),
            name: "Windows 截图.png".to_string(),
            media_type: "image/png",
            size: bytes.len(),
            data: BASE64.encode(bytes),
        });
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("当前平台暂未实现截图".to_string());

    #[cfg(target_os = "macos")]
    {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let path = std::env::temp_dir().join(format!("emilia-screen-{}-{nonce}.jpg", std::process::id()));
        let output = Command::new("/usr/sbin/screencapture")
            .args(["-x", "-C", "-t", "jpg"])
            .arg(&path)
            .output()
            .map_err(|error| format!("无法调用系统截图：{error}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(format!("截图失败，请在系统设置中允许屏幕录制：{}", detail.trim()));
        }
        let bytes = fs::read(&path).map_err(|error| format!("无法读取截图：{error}"));
        let _ = fs::remove_file(&path);
        let bytes = bytes?;
        if bytes.is_empty() || bytes.len() > 12 * 1024 * 1024 { return Err("截图大小超过 12 MB 限制".to_string()); }
        Ok(DeviceBinaryFile {
            path: "screen://main".to_string(),
            name: "Mac 截图.jpg".to_string(),
            media_type: "image/jpeg",
            size: bytes.len(),
            data: BASE64.encode(bytes),
        })
    }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[tauri::command]
fn device_screen_permission_status() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        return CGPreflightScreenCaptureAccess();
    }
    #[cfg(target_os = "windows")]
    return true;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    false
}

#[tauri::command]
fn device_request_screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        return CGRequestScreenCaptureAccess();
    }
    #[cfg(target_os = "windows")]
    return true;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    false
}

fn place_at_bottom_right(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.primary_monitor()? else {
        return Ok(());
    };

    let work_area = monitor.work_area();
    let window_size = window.outer_size()?;
    let margin = (12.0 * monitor.scale_factor()).round() as i32;
    let x = work_area.position.x + work_area.size.width as i32 - window_size.width as i32 - margin;
    let y = work_area.position.y + work_area.size.height as i32 - window_size.height as i32 - margin;

    window.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}

fn resize_at_bottom_right(window: &tauri::WebviewWindow, width: f64, height: f64) -> tauri::Result<()> {
    let monitor = window.current_monitor()?.or(window.primary_monitor()?);
    let Some(monitor) = monitor else {
        window.set_size(LogicalSize::new(width, height))?;
        return Ok(());
    };

    let scale = monitor.scale_factor();
    let work_area = monitor.work_area();
    let physical_width = (width * scale).round() as i32;
    let physical_height = (height * scale).round() as i32;
    let margin = (12.0 * scale).round() as i32;
    let x = work_area.position.x + work_area.size.width as i32 - physical_width - margin;
    let y = work_area.position.y + work_area.size.height as i32 - physical_height - margin;

    window.set_size(LogicalSize::new(width, height))?;
    window.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}

#[tauri::command]
fn set_chat_expanded(window: tauri::WebviewWindow, expanded: bool) -> tauri::Result<()> {
    let (width, height) = if expanded { (746.0, 460.0) } else { (340.0, 360.0) };
    resize_at_bottom_right(&window, width, height)
}

#[tauri::command]
fn set_wardrobe_expanded(window: tauri::WebviewWindow, expanded: bool) -> tauri::Result<()> {
    let (width, height) = if expanded { (646.0, 360.0) } else { (340.0, 360.0) };
    resize_at_bottom_right(&window, width, height)
}

#[tauri::command]
fn show_main_window(app: AppHandle, page: Option<String>) -> tauri::Result<()> {
    const PAGES: &[&str] = &["chat", "tasks", "files", "devices", "core", "memory", "proactive", "appearance", "settings"];
    let page = page.filter(|value| PAGES.contains(&value.as_str())).unwrap_or_else(|| "chat".to_string());
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        if window.is_minimized()? { window.unminimize()?; }
        window.set_focus()?;
        window.emit("companion:navigate", &page)?;
    } else {
        WebviewWindowBuilder::new(&app, "main", WebviewUrl::App(format!("main.html?page={page}").into()))
            .title("Emilia Companion")
            .inner_size(1180.0, 760.0)
            .min_inner_size(960.0, 640.0)
            .center()
            .build()?;
    }
    Ok(())
}

#[tauri::command]
fn hide_main_window(app: AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide()?;
    }
    Ok(())
}

fn connection_profile_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CONNECTION_PROFILE_SERVICE, CONNECTION_PROFILE_ACCOUNT)
        .map_err(|error| format!("无法访问系统钥匙串：{error}"))
}

#[tauri::command]
fn load_connection_profile() -> Result<Option<String>, String> {
    match connection_profile_entry()?.get_password() {
        Ok(profile) => Ok(Some(profile)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取系统钥匙串：{error}")),
    }
}

#[tauri::command]
fn save_connection_profile(profile_json: String) -> Result<(), String> {
    if profile_json.len() > 16 * 1024 {
        return Err("连接配置过大".to_string());
    }
    let profile: serde_json::Value = serde_json::from_str(&profile_json)
        .map_err(|_| "连接配置不是有效 JSON".to_string())?;
    if !profile.is_object() {
        return Err("连接配置格式错误".to_string());
    }
    connection_profile_entry()?
        .set_password(&profile_json)
        .map_err(|error| format!("无法写入系统钥匙串：{error}"))
}

pub fn import_connection_profile_json(profile_json: String) -> Result<(), String> {
    save_connection_profile(profile_json)
}

pub fn connection_profile_status_json() -> String {
    match load_connection_profile() {
        Ok(Some(raw)) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(profile) => serde_json::json!({
                "present": true,
                "validJson": true,
                "mode": profile["mode"].as_str().unwrap_or(""),
                "urlPresent": profile["url"].as_str().is_some_and(|value| !value.is_empty()),
                "tokenPresent": profile["token"].as_str().is_some_and(|value| !value.is_empty()),
                "name": profile["name"].as_str().unwrap_or(""),
            }).to_string(),
            Err(_) => serde_json::json!({ "present": true, "validJson": false }).to_string(),
        },
        Ok(None) => serde_json::json!({ "present": false }).to_string(),
        Err(error) => serde_json::json!({ "present": false, "error": error }).to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_page_load(|webview, payload| {
            write_app_log("page", &format!("window={} event={:?} url={}", webview.label(), payload.event(), payload.url()));
            let _ = webview.eval("globalThis.__TAURI__?.core?.invoke?.('frontend_report_error',{message:'[probe] native API available'}).catch(()=>{})");
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            set_chat_expanded,
            set_wardrobe_expanded,
            show_main_window,
            hide_main_window,
            load_connection_profile,
            save_connection_profile,
            device_get_info,
            device_read_clipboard,
            device_write_clipboard,
            device_open_url,
            device_show_notification,
            frontend_report_error,
            core_service_status,
            core_service_control,
            core_create_lan_connection_code,
            core_read_log,
            voice_service_status,
            voice_service_control,
            voice_service_diagnose,
            voice_read_log,
            device_get_file_roots,
            device_get_permissions,
            device_save_permissions,
            device_choose_file_roots,
            device_list_directory,
            device_search_files,
            device_read_text_file,
            device_read_document,
            device_read_binary_file,
            device_read_image_preview,
            device_reveal_path,
            device_capture_screen,
            device_screen_permission_status,
            device_request_screen_permission,
        ])
        .setup(|app| {
            write_app_log("lifecycle", "desktop client started");
            #[cfg(target_os = "windows")]
            ensure_voice_stack();
            if let Some(window) = app.get_webview_window("pet") {
                place_at_bottom_right(&window)?;
                window.show()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the desktop companion");
}
