# Pull live-book watch JSON from gn0meserver (Windows OpenSSH + agent).
$ErrorActionPreference = "Stop"
$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
$scp = "C:\Windows\System32\OpenSSH\scp.exe"
$key = Join-Path $env:USERPROFILE ".ssh\id_ed25519"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$hostName = "gizmo@192.168.68.59"
$remote = "/home/gizmo/meteora-farmer"
$out = Join-Path $root "data\live-book-watch.json"

New-Item -ItemType Directory -Force -Path (Join-Path $root "data") | Out-Null
& $scp -i $key -o BatchMode=yes -o IdentitiesOnly=yes `
  (Join-Path $root "deploy\watch-live-book.mjs") `
  "${hostName}:${remote}/deploy/watch-live-book.mjs" | Out-Null
& $ssh -i $key -o BatchMode=yes -o IdentitiesOnly=yes $hostName `
  "cd $remote && node deploy/watch-live-book.mjs" |
  Out-File -Encoding utf8 $out
Write-Output "WROTE $out"
