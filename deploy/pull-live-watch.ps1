# Pull live-book watch JSON from gn0meserver (Windows OpenSSH + agent).
# Never SCP into the live repo working tree — that creates untracked files
# which block `git pull --ff-only` in auto-deploy.
$ErrorActionPreference = "Stop"
$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
$scp = "C:\Windows\System32\OpenSSH\scp.exe"
$key = Join-Path $env:USERPROFILE ".ssh\id_ed25519"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$hostName = "gizmo@192.168.68.59"
$remote = "/home/gizmo/meteora-farmer"
$remoteTmp = "/tmp/meteora-farmer-watch-live-book.mjs"
$out = Join-Path $root "data\live-book-watch.json"

New-Item -ItemType Directory -Force -Path (Join-Path $root "data") | Out-Null
& $scp -i $key -o BatchMode=yes -o IdentitiesOnly=yes `
  (Join-Path $root "deploy\watch-live-book.mjs") `
  "${hostName}:${remoteTmp}" | Out-Null
& $ssh -i $key -o BatchMode=yes -o IdentitiesOnly=yes $hostName `
  "cd $remote && FARMER_ROOT=$remote node $remoteTmp" |
  Out-File -Encoding utf8 $out
Write-Output "WROTE $out"
