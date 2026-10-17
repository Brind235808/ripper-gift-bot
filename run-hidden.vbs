' RipperGiftBot silent launcher for Windows Task Scheduler (no console window).
' Task Scheduler action:  wscript.exe  "<this file path>"
' Auto-detects node.exe (Program Files / Program Files (x86) / PATH).
Option Explicit
Dim sh, fso, dir, node, candidates, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

node = "node.exe"
candidates = Array( _
  "C:\Program Files\nodejs\node.exe", _
  "C:\Program Files (x86)\nodejs\node.exe", _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\node\node.exe"), _
  sh.ExpandEnvironmentStrings("%ProgramData%\nvm\node.exe") )
For i = 0 To UBound(candidates)
  If fso.FileExists(candidates(i)) Then node = """" & candidates(i) & """" : Exit For
Next

' 0 = hidden window, True = wait for exit
sh.Run node & " src\discover.js >> logs\scheduled.log 2>&1", 0, True
