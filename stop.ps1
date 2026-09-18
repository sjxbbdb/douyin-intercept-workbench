# 抖音截流工作台 - 停止脚本
param([string]$Workspace = $PSScriptRoot)
$env:REPLY_WORKSPACE = $Workspace
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -like "*$Workspace*" -and ($_.CommandLine -like "*reply_server*server.js*" -or $_.CommandLine -like "*reply_worker.js*" -or $_.CommandLine -like "*live_dm_worker.js*" -or $_.CommandLine -like "*pipeline.js*")
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }
Write-Host "已停止 $killed 个后台进程（工作台/worker/流水线）"
Write-Host "注意：专用 Chrome 未关闭，如需关闭请手动关闭该窗口（保持登录态下次可直接用）"
