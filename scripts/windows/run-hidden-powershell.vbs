Option Explicit

' Run one PowerShell launcher without creating a console window.  WScript is a
' GUI host, so this remains reliable when Windows Terminal is configured as the
' system default terminal application.
If WScript.Arguments.Count <> 1 Then
  WScript.Quit 87
End If

Dim shell, launcherPath, command
launcherPath = WScript.Arguments(0)
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Chr(34) & Replace(launcherPath, Chr(34), Chr(34) & Chr(34)) & Chr(34)
WScript.Quit shell.Run(command, 0, True)
