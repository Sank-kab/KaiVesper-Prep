Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

If sh.Run("cmd /c where node >nul 2>&1", 0, True) <> 0 Then
  MsgBox "Node.js 18+ is required to run KaiVesper Prep." & vbCrLf & vbCrLf & "Download Node.js LTS from: https://nodejs.org" & vbCrLf & "Then restart and double-click this launcher again.", vbExclamation, "KaiVesper Prep"
  WScript.Quit 1
End If

Function CheckServerState()
  ' Returns: 0 = down, 1 = old version, 2 = current version (apiVersion:2)
  CheckServerState = 0
  On Error Resume Next
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  http.SetTimeouts 300, 300, 300, 300
  http.Open "GET", "http://127.0.0.1:47822/api/env", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then
      If InStr(http.ResponseText, """apiVersion"":2") > 0 Then
        CheckServerState = 2
      Else
        CheckServerState = 1
      End If
    End If
  End If
  Err.Clear
  On Error GoTo 0
End Function

Sub StopOldServer()
  On Error Resume Next
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  http.SetTimeouts 300, 300, 300, 300
  http.Open "POST", "http://127.0.0.1:47822/api/shutdown", False
  http.Send "{}"
  Err.Clear
  On Error GoTo 0
  WScript.Sleep 600
End Sub

state = CheckServerState()
If state = 1 Then
  StopOldServer
  state = 0
End If

If state <> 2 Then
  sh.Run "cmd /c cd /d """ & dir & """ && node server.cjs", 0, False
  For i = 1 To 25
    WScript.Sleep 200
    If CheckServerState() = 2 Then Exit For
  Next
End If

edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe")
If Not fso.FileExists(edge) Then edge = sh.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe")

If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=http://127.0.0.1:47822 --window-size=1060,840", 1, False
Else
  sh.Run "http://127.0.0.1:47822", 1, False
End If
