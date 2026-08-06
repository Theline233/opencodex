[CmdletBinding()]
param(
  [ValidateSet("Deploy", "Rollback", "Status")]
  [string]$Action = "Deploy",
  [string]$ServerHost = "opencodex-tokyo.tail0dc240.ts.net",
  [string]$ServerUser = "ubuntu",
  [string]$KeyPath = $env:OPENCODEX_DEPLOY_KEY
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Find-CommandPath([string]$Name, [string[]]$Fallbacks) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in $Fallbacks) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw "$Name was not found. Install Git for Windows and Windows OpenSSH first."
}

$git = Find-CommandPath "git" @(
  (Join-Path $env:ProgramFiles "Git\cmd\git.exe"),
  (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd\git.exe")
)
$ssh = Find-CommandPath "ssh" @("$env:WINDIR\System32\OpenSSH\ssh.exe")
$scp = Find-CommandPath "scp" @("$env:WINDIR\System32\OpenSSH\scp.exe")

if (-not $KeyPath) {
  $keyCandidates = @(
    (Join-Path $PSScriptRoot "deploy-key.pem"),
    (Join-Path $HOME ".ssh\gs.pem"),
    (Join-Path $HOME "Downloads\gs.pem"),
    "D:\Downloads\gs.pem"
  )
  $KeyPath = $keyCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $KeyPath -or -not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
  throw "SSH key not found. Put deploy-key.pem in ops\tokyo or set OPENCODEX_DEPLOY_KEY."
}
$KeyPath = (Resolve-Path -LiteralPath $KeyPath).Path
$remote = "${ServerUser}@${ServerHost}"
$remoteCache = "/home/$ServerUser/.cache/opencodex-deploy"
$sshArgs = @("-i", $KeyPath, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15")

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Program"
  }
}

if ($Action -ne "Deploy") {
  $remoteAction = $Action.ToLowerInvariant()
  $remoteCommand = "tar -xOf '$remoteCache/latest.tar.gz' 'ops/tokyo/server-deploy.sh' | bash -s -- '$remoteAction'"
  Invoke-Checked $ssh ($sshArgs + @($remote, $remoteCommand))
  exit 0
}

$dirty = & $git -C $repoRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw "Could not read Git status." }
if ($dirty) {
  throw "The worktree is dirty. Commit changes before deploying."
}

$shortSha = (& $git -C $repoRoot rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $shortSha) { throw "Could not read the Git commit." }
$version = (Get-Content -Raw (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$release = "v$version-local.$shortSha"
$archive = Join-Path ([IO.Path]::GetTempPath()) "opencodex-$release-$([guid]::NewGuid().ToString('N')).tar.gz"

try {
  Write-Host "[1/5] Packaging Git commit $shortSha"
  Invoke-Checked $git @("-C", $repoRoot, "archive", "--format=tar.gz", "--output=$archive", "HEAD")
  $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()

  Write-Host "[2/5] Checking the server connection"
  Invoke-Checked $ssh ($sshArgs + @($remote, "mkdir -p '$remoteCache'"))

  Write-Host "[3/5] Uploading release $release"
  $remoteArchive = "$remoteCache/$release.tar.gz"
  Invoke-Checked $scp (@("-i", $KeyPath, "-o", "BatchMode=yes", $archive, "${remote}:$remoteArchive"))
  Invoke-Checked $ssh ($sshArgs + @($remote, "cp '$remoteArchive' '$remoteCache/latest.tar.gz'"))

  Write-Host "[4/5] Building, testing, and validating the 10101 canary"
  $remoteCommand = "tar -xOf '$remoteArchive' 'ops/tokyo/server-deploy.sh' | bash -s -- deploy '$release' '$remoteArchive' '$sha'"
  Invoke-Checked $ssh ($sshArgs + @($remote, $remoteCommand))

  Write-Host "[5/5] Deployment completed"
  Write-Host "Release: $release"
  Write-Host "Double-click rollback.cmd to roll back."
} finally {
  if (Test-Path -LiteralPath $archive -PathType Leaf) {
    Remove-Item -LiteralPath $archive -Force
  }
}
