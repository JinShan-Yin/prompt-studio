' NewRock silent launcher - runs the service without any console window
Option Explicit
Dim shell, fso, batPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
' This .vbs lives in the autostart folder; the silent .bat sits next to it
batPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "start-newrock-silent.bat")
' Window style 0 = hidden window; False = return immediately without waiting
shell.Run "cmd /c """ & batPath & """", 0, False
