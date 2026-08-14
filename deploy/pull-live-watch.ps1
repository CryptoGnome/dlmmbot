# Pull live-book watch JSON from the server (Windows OpenSSH + agent).
# Runs the *deployed* watch script on the server (imports deploy/lib/*).
# Never SCP into the live repo working tree — that blocks auto-deploy pulls.
#
# Configure via env vars (no defaults on purpose — operator-specific):
#   LIVE_SSH_HOST     user@host of the server running the bot (e.g. ops@10.0.0.5)
#   LIVE_REMOTE_PATH  absolute repo path on the server (e.g. /home/ops/dlmmbot)
#   LIVE_SSH_KEY      optional private key path (default: ~/.ssh/id_ed25519)
$ErrorActionPreference = "Stop"

$hostName = $env:LIVE_SSH_HOST
$remote = $env:LIVE_REMOTE_PATH
if (-not $hostName -or -not $remote) {
  Write-Error "Set LIVE_SSH_HOST (user@host) and LIVE_REMOTE_PATH (repo path on the server) before running this script."
  exit 1
}

$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
$key = if ($env:LIVE_SSH_KEY) { $env:LIVE_SSH_KEY } else { Join-Path $env:USERPROFILE ".ssh\id_ed25519" }
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$out = Join-Path $root "data\live-book-watch.json"

New-Item -ItemType Directory -Force -Path (Join-Path $root "data") | Out-Null
& $ssh -i $key -o BatchMode=yes -o IdentitiesOnly=yes $hostName `
  "cd $remote && FARMER_ROOT=$remote node deploy/watch-live-book.mjs" |
  Out-File -Encoding utf8 $out
Write-Output "WROTE $out"
