' Launches StreamGrabber without a console window. Quit from the app's Quit button.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If Not fso.FolderExists(dir & "\node_modules") Then
  sh.Run "cmd /c """ & dir & "\StreamGrabber.cmd""", 1, False
Else
  sh.Run "node ""server.js""", 0, False
End If
