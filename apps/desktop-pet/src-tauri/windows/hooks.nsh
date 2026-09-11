!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing Emilia Core background service..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\core-runtime\scripts\install-bundled-core-windows.ps1" -RuntimeRoot "$INSTDIR\core-runtime"'
  Pop $0
  ${If} $0 != 0
    IfSilent core_hook_done 0
    MessageBox MB_ICONEXCLAMATION "Emilia Companion 已安装，但 Core 后台服务启动失败。请从应用的 Core 页面查看诊断。"
  ${EndIf}
  core_hook_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName $\'Emilia Host Agent$\' -ErrorAction SilentlyContinue; Stop-ScheduledTask -TaskName $\'Emilia Core Service$\' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $\'Emilia Host Agent$\' -Confirm:$false -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $\'Emilia Core Service$\' -Confirm:$false -ErrorAction SilentlyContinue"'
  Pop $0
!macroend
