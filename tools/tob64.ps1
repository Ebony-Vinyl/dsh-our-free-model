param([string]$Sizes)
foreach ($f in 'src\store.js','src\stream.js') {
  $item = Get-Item $f
  $b = [Convert]::ToBase64String([IO.File]::ReadAllBytes($item.FullName))
  $out = 'w_' + $item.BaseName + '.b64'
  Set-Content -Path $out -Value $b -NoNewline
  # pecah jadi potongan 20000 karakter
  $i = 0
  $n = 0
  while ($i -lt $b.Length) {
    $len = [Math]::Min(20000, $b.Length - $i)
    $part = 'p_' + $item.BaseName + '_' + ('{0:D2}' -f $n) + '.txt'
    Set-Content -Path $part -Value $b.Substring($i, $len) -NoNewline
    $i += $len
    $n += 1
  }
  Write-Output ($item.BaseName + ': b64=' + $b.Length + ' parts=' + $n)
}
