Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c ""Start Workbench.bat"" > console.log 2>&1", 0, False
WScript.Sleep 3000
WshShell.Run "http://127.0.0.1:3100"
Set WshShell = Nothing
