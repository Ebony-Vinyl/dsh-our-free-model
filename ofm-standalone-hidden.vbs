Set sh = CreateObject("WScript.Shell")
' Path ke repo (ubah kalau pindah)
repo = "D:\Aset\dsh-ofm"
' Jalankan runner TANPA jendela (0 = hidden).
' Runner (ofm-standalone-run.cmd) yang membersihkan lock basi lalu start node.
sh.CurrentDirectory = repo
sh.Run "cmd /c " & Chr(34) & repo & "\ofm-standalone-run.cmd" & Chr(34), 0, False
