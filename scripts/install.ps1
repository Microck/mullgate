$ErrorActionPreference = 'Stop'

$packageName = 'mullgate'
$packageSpec = if ($env:MULLGATE_VERSION) { "$packageName@$($env:MULLGATE_VERSION)" } else { $packageName }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'mullgate installer: Node.js 22+ is required, but `node` was not found.'
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'mullgate installer: npm is required, but `npm` was not found.'
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
  throw "mullgate installer: Node.js 22+ is required. Found $(node -v)."
}

Write-Host "Installing $packageSpec..."

try {
  npm install --global $packageSpec
  Write-Host ''
  Write-Host 'mullgate installed successfully.'
  Write-Host 'Run: mullgate --help'
  exit 0
} catch {
  $userPrefix = if ($env:MULLGATE_NPM_PREFIX) { $env:MULLGATE_NPM_PREFIX } else { Join-Path $HOME 'AppData\Local\mullgate' }
  $binPath = Join-Path $userPrefix 'mullgate.cmd'

  Write-Host ''
  Write-Host "Global install failed, retrying with a user prefix at $userPrefix."
  try {
    npm install --global --prefix $userPrefix $packageSpec
  } catch {
    throw 'mullgate installer: npm installation failed. If the package has not been published yet, install from the GitHub release .tgz asset or from a source checkout.'
  }

  Write-Host ''
  Write-Host 'mullgate installed successfully.'
  Write-Host "Binary path: $binPath"
  Write-Host 'If that directory is not on PATH yet, run the binary from that path or add the prefix to PATH.'
}
