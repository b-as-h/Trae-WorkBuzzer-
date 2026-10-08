' run-panel.vbs - start the check-in panel server with NO console window.
' Pure ASCII on purpose (WSH decodes .vbs as ANSI).
Option Explicit
Dim fso, sh, root, nodeExe, cmd, d, subs, f
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)

nodeExe = ""
' 0) Bundled portable runtime shipped with the installer (highest priority).
If fso.FileExists(fso.BuildPath(root, "runtime\node.exe")) Then
  nodeExe = fso.BuildPath(root, "runtime\node.exe")
End If
' 1) WorkBuddy managed node (any version folder)
If nodeExe = "" Then
d = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.workbuddy\binaries\node\versions"
If fso.FolderExists(d) Then
  Set subs = fso.GetFolder(d).SubFolders
  For Each f In subs
    If fso.FileExists(f.Path & "\node.exe") Then nodeExe = f.Path & "\node.exe"
  Next
End If
End If
' 2) common install locations
If nodeExe = "" Then
  d = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
  If fso.FileExists(d) Then nodeExe = d
End If
If nodeExe = "" Then
  d = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\node\node.exe"
  If fso.FileExists(d) Then nodeExe = d
End If
If nodeExe = "" Then
  d = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\nodejs\node.exe"
  If fso.FileExists(d) Then nodeExe = d
End If
' 3) PATH lookup
If nodeExe = "" Then nodeExe = "node.exe"

cmd = """" & nodeExe & """ """ & fso.BuildPath(root, "server.js") & """"
sh.CurrentDirectory = root
sh.Run cmd, 0, False
