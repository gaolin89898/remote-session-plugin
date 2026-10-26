<#
  setup.ps1 — prepare two isolated DSH instances for dsh-remote-session dual-instance testing.

  What it does (idempotent):
    1. locate the dsh CLI (env DSH_CLI, else npx cache / global npm);
    2. create two temp DSH_HOMEs:  %USERPROFILE%\.dsh-remote-a  /  .dsh-remote-b
       (never touches the real ~/.dsh, its profiles, sessions or storages);
    3. inside each HOME, initialise profile remote-a / remote-b and install this plugin
       (file: by default, or link: with -Mode link for live editing);
    4. make sure @deepseek-ai/dsh-web-app is in each profile's dsh.profile.bundles
       (resolved from the CLI's own node_modules — nothing extra to install);
    5. copy 2 real session directories per HOME from ~/.dsh/sessions (sessions only,
       no storages); A and B get disjoint sessions so cross-viewing is meaningful;
    6. write a HOME-level cordis.patch.yml giving each instance its own instanceId /
       instanceName (relay token is NEVER written to disk — pass DSH_RELAY_TOKEN at run time);
    7. print the two start commands.

  Usage:
    powershell -ExecutionPolicy Bypass -File test\setup.ps1
    powershell ... -File test\setup.ps1 -Mode link          # symlink the plugin (live edits)
    powershell ... -File test\setup.ps1 -RefreshSessions    # re-copy the 2 sessions
    test\setup.cmd                                          # same, execution-policy safe
#>
[CmdletBinding()]
param(
  [string]$PluginPath = (Split-Path -Parent $PSScriptRoot),
  [string]$ProfileA   = 'remote-a',
  [string]$ProfileB   = 'remote-b',
  [string]$HomeA      = (Join-Path $env:USERPROFILE '.dsh-remote-a'),
  [string]$HomeB      = (Join-Path $env:USERPROFILE '.dsh-remote-b'),
  [int]$Sessions      = 2,
  [ValidateSet('file', 'link')][string]$Mode = 'file',
  [switch]$RefreshSessions,
  [switch]$SkipSessions,
  [string]$Cli
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

function Write-Step([string]$Message) { Write-Host "[setup] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "[ ok ] $Message"  -ForegroundColor Green }
function Write-Warn2([string]$Message){ Write-Host "[warn] $Message"  -ForegroundColor Yellow }

# ---------------------------------------------------------------- CLI / node
function Find-DshCli {
  if ($Cli -and (Test-Path $Cli)) { return (Resolve-Path $Cli).Path }
  if ($env:DSH_CLI -and (Test-Path $env:DSH_CLI)) { return (Resolve-Path $env:DSH_CLI).Path }
  $probe = @(
    (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js'),
    (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'),
    (Join-Path $env:USERPROFILE 'AppData\Local\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js')
  )
  foreach ($pattern in $probe) {
    $hit = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  throw "dsh CLI not found. Set DSH_CLI=<...\@deepseek-ai\dsh\lib\bin.js> or pass -Cli."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH.' }
$cli = Find-DshCli
$cliVersion = (& node $cli --version) 2>&1 | Select-Object -First 1
Write-Ok "node      : $((& node --version))"
Write-Ok "dsh CLI   : $cli  (version $cliVersion)"

# ---------------------------------------------------------------- plugin check
$PluginPath = (Resolve-Path $PluginPath).Path
$manifestPath = Join-Path $PluginPath 'package.json'
if (-not (Test-Path $manifestPath)) { throw "no package.json under $PluginPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$pkgName  = $manifest.name
$patchRel = $manifest.dsh.bundle.patch
if (-not $patchRel) { throw "$pkgName has no dsh.bundle.patch — the CLI will not mount it automatically." }
Write-Ok "plugin    : $pkgName@$($manifest.version)  <- $PluginPath"
foreach ($rel in @($manifest.main, 'lib/client.js')) {
  if ($rel -and -not (Test-Path (Join-Path $PluginPath $rel))) {
    Write-Warn2 "$pkgName is missing $rel — install still works, but the instance will not boot until the file exists."
  }
}

function Invoke-Dsh {
  param([string]$DshHome, [string[]]$DshArgs)
  $prevHome = $env:DSH_HOME
  $prevEap  = $ErrorActionPreference
  $env:DSH_HOME = $DshHome
  try {
    # Windows PowerShell 5.1 turns any native stderr write into a terminating
    # NativeCommandError when $ErrorActionPreference is 'Stop'. Relax it for the
    # duration of the CLI call and print the merged stream ourselves.
    $ErrorActionPreference = 'SilentlyContinue'
    $output = & node $cli @DshArgs 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($output) { foreach ($line in $output) { Write-Host ([string]$line) } }
    return $code
  } finally {
    $ErrorActionPreference = $prevEap
    $env:DSH_HOME = $prevHome
  }
}

# Adds '@deepseek-ai/dsh-web-app' right after @deepseek-ai/dsh-base in the bundle list.
$ensureWebAppJs = @'
const fs = require('fs');
const p = process.argv[1];
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const dsh = j.dsh && j.dsh.profile;
if (!dsh || !Array.isArray(dsh.bundles)) { console.error('no dsh.profile.bundles in ' + p); process.exit(2); }
if (dsh.bundles.includes('@deepseek-ai/dsh-web-app')) { console.log('bundles ok: ' + dsh.bundles.join(',')); process.exit(0); }
const at = Math.max(0, dsh.bundles.indexOf('@deepseek-ai/dsh-base')) + 1 || 1;
dsh.bundles.splice(at, 0, '@deepseek-ai/dsh-web-app');
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
console.log('bundles fixed: ' + dsh.bundles.join(','));
'@

function Initialize-Instance {
  param([string]$Name, [string]$DshHome, [string]$InstanceId, [string]$InstanceLabel)

  Write-Step "instance $Name : DSH_HOME=$DshHome"
  New-Item -ItemType Directory -Force -Path $DshHome | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $DshHome 'sessions') | Out-Null

  $spec = if ($Mode -eq 'link') { "link:$PluginPath" } else { "file:$PluginPath" }
  Write-Step "plugin add $spec  (profile $Name)"
  $code = Invoke-Dsh -DshHome $DshHome -DshArgs @('plugin', '--profile', $Name, 'add', $spec)
  if ($code -ne 0) {
    # Known non-zero causes that still leave a usable install:
    #   ERR_PNPM_IGNORED_BUILDS (optional native deps), version gate (official packages).
    $profileDir = Join-Path $DshHome "profiles\$Name"
    if (Test-Path (Join-Path $profileDir 'node_modules')) {
      Write-Warn2 "plugin add exited $code but $profileDir/node_modules exists — continuing (see test\README.md §troubleshooting)."
    } else {
      throw "plugin add failed for $Name (exit $code) and nothing was installed."
    }
  }
  $profilePkg = Join-Path $DshHome "profiles\$Name\package.json"
  if (-not (Test-Path $profilePkg)) { throw "profile $Name was not created under $DshHome\profiles." }
  & node -e $ensureWebAppJs $profilePkg
  if ($LASTEXITCODE -ne 0) { throw "could not patch $profilePkg bundle list." }

  $hasPluginBundle = (Get-Content $profilePkg -Raw | ConvertFrom-Json).dsh.profile.bundles -contains $pkgName
  if (-not $hasPluginBundle) {
    Write-Warn2 "profile $Name bundle list does not contain $pkgName — the CLI may have aborted before reconciling bundles."
    Write-Warn2 "Manually add `"$pkgName`" to dsh.profile.bundles in $profilePkg, or re-run this script."
  } else { Write-Ok "bundle list contains $pkgName" }

  # Home-level patch: per-instance identity for the relay. Token stays out of files.
  if ($pkgName -eq 'dsh-remote-session') {
    $homePatch = @"
# generated by test/setup.ps1 — instance identity for the relay.
# Token is intentionally NOT stored here; export DSH_RELAY_TOKEN at run time.
- id: remote-session
  name: 'dsh-remote-session'
  config:
    instanceId: '$InstanceId'
    instanceName: '$InstanceLabel'
"@
    $homePatchPath = Join-Path $DshHome 'cordis.patch.yml'
    [System.IO.File]::WriteAllText($homePatchPath, ($homePatch -replace "`r`n", "`n"))
    Write-Ok "home patch: $DshHome\cordis.patch.yml (instanceId=$InstanceId)"
  } else {
    Write-Warn2 "skipping home-level patch (plugin is $pkgName, not dsh-remote-session)."
  }

  Write-Ok "profile $Name ready at $DshHome\profiles\$Name"
}

# ---------------------------------------------------------------- sessions copy
function Copy-RealSessions {
  param([string]$DshHome, [int]$Skip, [int]$Count)
  $realRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
  if (-not (Test-Path $realRoot)) { Write-Warn2 "no real sessions at $realRoot"; return }
  $target = Join-Path $DshHome 'sessions'
  $destSlugs = Get-ChildItem -Path $target -Directory -ErrorAction SilentlyContinue
  if (-not $RefreshSessions -and $destSlugs) {
    $n = (Get-ChildItem -Path $target -Directory | ForEach-Object { Get-ChildItem $_.FullName -Directory }).Count
    Write-Ok "sessions already present in $target ($n session dirs) — keeping (use -RefreshSessions to redo)."
    return
  }
  if ($RefreshSessions -and $destSlugs) { Get-ChildItem -Path $target -Directory | Remove-Item -Recurse -Force }
  $all = Get-ChildItem -Path $realRoot -Directory |
    ForEach-Object { Get-ChildItem -Path $_.FullName -Directory } |
    Sort-Object LastWriteTime -Descending
  $pick = @($all | Select-Object -Skip $Skip -First $Count)
  if ($pick.Count -lt $Count) { $pick = @($all | Select-Object -First $Count) }
  foreach ($session in $pick) {
    $slug = $session.Parent.Name
    $destDir = Join-Path $target $slug
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Copy-Item -Path $session.FullName -Destination (Join-Path $destDir $session.Name) -Recurse -Force
    Write-Ok "session copied: $slug\$($session.Name)"
  }
  if ($pick.Count -eq 0) { Write-Warn2 'no session directories found to copy.' }
}

# ---------------------------------------------------------------- main
Write-Step "Preparing instance A"
Initialize-Instance -Name $ProfileA -DshHome $HomeA -InstanceId 'remote-a' -InstanceLabel 'Remote A (test)'
Write-Step "Preparing instance B"
Initialize-Instance -Name $ProfileB -DshHome $HomeB -InstanceId 'remote-b' -InstanceLabel 'Remote B (test)'

if ($SkipSessions) {
  Write-Warn2 '-SkipSessions: not copying any real session directories.'
} else {
  Write-Step "Copying real sessions (sessions only, no storages)"
  Copy-RealSessions -DshHome $HomeA -Skip 0          -Count $Sessions
  Copy-RealSessions -DshHome $HomeB -Skip $Sessions  -Count $Sessions
}

$logs = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

Write-Host ''
Write-Ok 'both instances prepared.'
Write-Host ''
Write-Host 'Start (two terminals):' -ForegroundColor Cyan
Write-Host '  test\run-a.cmd        -> http://127.0.0.1:3111'
Write-Host '  test\run-b.cmd        -> http://127.0.0.1:3112'
Write-Host ''
Write-Host 'Then verify:' -ForegroundColor Cyan
Write-Host '  node test\verify.mjs              # instances already running'
Write-Host '  node test\verify.mjs --spawn      # start both, verify, stop'
Write-Host ''
Write-Host 'Relay token (never stored in the repo):' -ForegroundColor Cyan
Write-Host '  set DSH_RELAY_TOKEN=<token>   before run-a.cmd / run-b.cmd / verify.mjs --spawn'
Write-Host '  (fetch it read-only: ssh <host> "cat /etc/dsh-relay/token")'
Write-Host ''
Write-Host 'Stop everything:' -ForegroundColor Cyan
Write-Host '  test\stop.cmd'
Write-Host ''
Write-Host "Homes: $HomeA  |  $HomeB   (delete with: rmdir /s /q `"$HomeA`" `"$HomeB`")"
