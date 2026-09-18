# 抖音截流工作台 - 启动脚本（Windows PowerShell）
# 作用：启动本地服务(8090) + 回复分发 worker，并用独立浏览器配置(9222)打开已登录的抖音页面
param(
  [string]$Workspace = $PSScriptRoot,
  [string]$ChromePath = "",
  [string]$NodePath = "",
  [int]$UiPort = 8090,
  [int]$DebugPort = 9222
)

function Test-PortOpen([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}
function Start-HiddenNode([string]$ScriptPath) {
  Start-Process -FilePath $NodePath -ArgumentList @($ScriptPath) -WorkingDirectory $Workspace -WindowStyle Hidden | Out-Null
}
function Test-NodeScriptRunning([string]$Pattern) {
  return [bool](Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -eq $NodePath -and $_.CommandLine -like "*$Pattern*"
  })
}

if (-not $NodePath) {
  $NodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $NodePath) { $NodePath = Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe" }
}
if (-not $ChromePath) {
  $ChromePath = Join-Path ${env:ProgramFiles} "Google\Chrome\Application\chrome.exe"
  if (-not (Test-Path $ChromePath)) { $ChromePath = Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe" }
  if (-not (Test-Path $ChromePath)) { $ChromePath = Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe" }
}

if (-not (Test-Path $NodePath)) { throw "未找到 Node.js，请先安装 Node.js 20+：$NodePath" }
if (-not (Test-Path $ChromePath)) { throw "未找到 Google Chrome：$ChromePath" }

$env:REPLY_WORKSPACE = $Workspace
$env:REPLY_DEBUG_PORT = [string]$DebugPort
$env:REPLY_UI_PORT = [string]$UiPort

# 1) 本地工作台服务
if (-not (Test-NodeScriptRunning "reply_server\\server.js")) {
  Start-HiddenNode (Join-Path $Workspace "reply_server\server.js")
  Write-Host "[1/3] 工作台服务已启动"
} else { Write-Host "[1/3] 工作台服务已在运行" }

# 2) 回复分发 worker（处理确认队列）
if (-not (Test-NodeScriptRunning "reply_worker.js")) {
  Start-HiddenNode (Join-Path $Workspace "reply_worker.js")
  Write-Host "[2/3] 回复分发 worker 已启动"
} else { Write-Host "[2/3] 回复分发 worker 已在运行" }

# 3) Chrome（独立配置目录，需自行登录抖音）
if (-not (Test-PortOpen $DebugPort)) {
  $chromeArgs = @(
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=$(Join-Path $Workspace 'dy-main')",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1500,950",
    "https://www.douyin.com/"
  )
  Start-Process -FilePath $ChromePath -ArgumentList $chromeArgs | Out-Null
  Write-Host "[3/3] 已打开专用 Chrome（首次请自行登录抖音）"
} else { Write-Host "[3/3] Chrome 调试端口已就绪" }

Start-Sleep -Milliseconds 1200
Start-Process "http://127.0.0.1:$UiPort/"
Write-Host ""
Write-Host "工作台已打开：http://127.0.0.1:$UiPort/"
Write-Host "停止：运行 停止.cmd 或 stop.ps1"
