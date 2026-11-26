Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

If sh.Run("cmd /c where node >nul 2>&1", 0, True) <> 0 Then
  MsgBox "Node.js 18+ is required to run KaiVesper Prep." & vbCrLf & vbCrLf & "Download Node.js LTS from: https://nodejs.org" & vbCrLf & "Then restart and double-click this launcher again.", vbExclamation, "KaiVesper Prep"
  WScript.Quit 1
End If

Function IsServerUp()
  IsServerUp = False
  On Error Resume Next
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  http.SetTimeouts 300, 300, 300, 300
  http.Open "GET", "http://127.0.0.1:47822/api/env", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then IsServerUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

If Not IsServerUp() Then
  sh.Run "cmd /c cd /d """ & dir & """ && node server.cjs", 0, False
  For i = 1 To 25
    WScript.Sleep 200
    If IsServerUp() Then Exit For
  Next
End If

edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe")
If Not fso.FileExists(edge) Then edge = sh.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe")

If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=http://127.0.0.1:47822 --window-size=1060,840", 1, False
Else
  sh.Run "http://127.0.0.1:47822", 1, False
End If
