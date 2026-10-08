' run-hidden.vbs - launch checkin.js with NO visible console window.
'
' Why: Task Scheduler with LogonType=InteractiveToken starts console apps with a
' visible console window (the black box). wscript.exe is a GUI-subsystem host, and
' WshShell.Run(cmd, 0, False) starts the child with SW_HIDE, so node runs fully in
' the background: no window, no interaction, nothing for the user to notice.
'
' Usage (exactly what the scheduled task runs):
'   wscript.exe //B //Nologo "E:\Temp\auto-checkin\run-hidden.vbs"
' Extra arguments are forwarded to checkin.js, e.g. run-hidden.vbs --force
'
' NOTE: this file is deliberately pure ASCII. Non-ASCII text in a .vbs would be
' decoded as ANSI by the Windows Script Host and can corrupt the script or the
' log line it writes. Keep the messages ASCII-only.
Option Explicit

Dim fso, sh, root, script, nodeExe, cmd, i, errNum, failed, why
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(root, "checkin.js")

' Resolve node.exe: WorkBuddy-managed runtime (any version folder) > system
' install > PATH lookup. The version folder is discovered at runtime on purpose:
' hard-coding it meant an upgraded managed Node silently fell through to a
' different runtime, or made the launcher fail once that folder was removed.
' 0) Bundled portable runtime shipped with the installer (highest priority).
If fso.FileExists(fso.BuildPath(root, "runtime\node.exe")) Then
  nodeExe = fso.BuildPath(root, "runtime\node.exe")
End If
If nodeExe = "" Then nodeExe = FindManagedNode(fso, sh)
If nodeExe = "" Then
  If fso.FileExists("C:\Program Files\node\node.exe") Then
    nodeExe = "C:\Program Files\node\node.exe"
  End If
End If
If nodeExe = "" Then nodeExe = "node.exe"   ' resolved via PATH, cannot be verified here

failed = False
why = ""

' Pre-flight checks. A failure here MUST leave a trace: wscript always exits with
' code 0, so otherwise the scheduled task would look successful while nothing ran
' (a silent failure, the worst kind for an unattended job).
If Not fso.FileExists(script) Then
  failed = True
  why = "checkin.js not found: " & script
Else
  cmd = """" & nodeExe & """ """ & script & """"
  For i = 0 To WScript.Arguments.Count - 1
    cmd = cmd & " " & WScript.Arguments(i)
  Next

  errNum = 0
  On Error Resume Next
  sh.CurrentDirectory = root
  If Err.Number <> 0 Then Err.Clear
  ' 0 = hidden window, False = do not wait for the child process
  sh.Run cmd, 0, False
  errNum = Err.Number
  why = Err.Description
  On Error GoTo 0
  If errNum <> 0 Then failed = True
End If

If failed Then
  Dim f, ts
  ts = Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & "T" & _
       Right("0" & Hour(Now), 2) & ":" & Right("0" & Minute(Now), 2) & ":" & Right("0" & Second(Now), 2)
  On Error Resume Next
  Set f = fso.OpenTextFile(fso.BuildPath(root, "checkin.log"), 8, True)
  If Err.Number = 0 Then
    f.WriteLine "[" & ts & "] [launcher] FAILED to start node: " & why & " (node=" & nodeExe & ")"
    f.Close
  End If
  On Error GoTo 0
End If

' Pick the highest-named version folder under
' %USERPROFILE%\.workbuddy\binaries\node\versions that contains node.exe.
' Name comparison is a simple "newest wins" heuristic (fine for 22.x / 24.x names).
' NOTE: the loop variable must NOT be named "sub" - it is a VBScript reserved
' word, and `Dim sub` makes the whole script fail to parse (silent failure).
Function FindManagedNode(fso, sh)
  Dim up, baseDir, parent, dirItem, exe, best, bestName
  FindManagedNode = ""
  up = sh.ExpandEnvironmentStrings("%USERPROFILE%")
  If up = "" Or up = "%USERPROFILE%" Then Exit Function
  baseDir = fso.BuildPath(up, ".workbuddy\binaries\node\versions")
  If Not fso.FolderExists(baseDir) Then Exit Function
  Set parent = fso.GetFolder(baseDir)
  best = ""
  bestName = ""
  For Each dirItem In parent.SubFolders
    exe = fso.BuildPath(dirItem.Path, "node.exe")
    If fso.FileExists(exe) Then
      If best = "" Or dirItem.Name > bestName Then
        best = exe
        bestName = dirItem.Name
      End If
    End If
  Next
  FindManagedNode = best
End Function
