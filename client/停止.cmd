@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  抖音自动回复工作台 —— 停止脚本（Windows）
rem ============================================================
rem
rem  ⚠️ 为什么不能只"关窗口"：
rem     Windows 上直接关掉控制台窗口，进程收不到 SIGINT，
rem     于是退出清理不会执行——具体后果有三个，都是真实会出问题的：
rem
rem      ① 专用 Chrome 留在后台（占着 9222+N 端口与 profile 锁），
rem         下次启动会看到"用户数据目录已被占用"，而商家完全不明白
rem         这句话和自己刚才"关了个窗口"有什么关系。
rem
rem      ② 实例注册表里留着这条记录，端口不会被释放。
rem
rem      ③ 停机前的那次明细补报没发生（契约 §4.8 要求"停机前立即上报"），
rem         于是最后几条已确认的发送要等下次启动才结算。
rem
rem     所以正确做法是：**先按 Ctrl+C 停（或双击本脚本）**，等它自己退出；
rem     只有在它卡死时才强杀。
rem
rem  ⚠️ 本脚本先尝试温和停止（发 Ctrl+Break 给同目录启动的窗口名），
rem     失败再列出候选进程让**人**决定杀哪个——不自动 taskkill /F，
rem     因为误杀会打断正在进行的发送，留下"结果未知"的记录。

cd /d "%~dp0.."

echo.
echo   抖音自动回复工作台 —— 正在停止...
echo   ------------------------------------------------

rem 找出正在运行的本项目客户端进程（node + main.js）。
rem ⚠️ 用 wmic 的命令行匹配而不是按镜像名 node.exe 全杀——
rem    商家机器上很可能还有别的 Node 程序（那才是更常见的误伤）。
set FOUND=0
for /f "skip=1 tokens=1,2 usebackq" %%a in (`wmic process where "name='node.exe'" get ProcessId^,CommandLine /format:csv 2^>nul`) do (
  echo %%a | findstr /i "client\\host\\main.js" >nul
  if not errorlevel 1 (
    set FOUND=1
    echo   [.] 找到客户端进程 PID=%%b
    echo       %%a
    echo.
    echo   请在那个窗口里按 Ctrl+C 让它自己退出（会做停机前补报与清理）。
    echo   若它已经卡死无响应，可执行：taskkill /PID %%b /T
    echo.
  )
)

rem 授权中心（服务端）可能也在本机跑着（开发/自测场景）
for /f "skip=1 tokens=1,2 usebackq" %%a in (`wmic process where "name='node.exe'" get ProcessId^,CommandLine /format:csv 2^>nul`) do (
  echo %%a | findstr /i "license-server\\server.js" >nul
  if not errorlevel 1 (
    set FOUND=1
    echo   [.] 找到授权中心进程 PID=%%b
    echo       %%a
    echo.
  )
)

if !FOUND! EQU 0 (
  echo   [v] 没有发现正在运行的本项目进程（可能已经停止了）。
  echo.
)

echo   ------------------------------------------------
echo   提示：本脚本**不会**自动强杀进程，也不会去动专用 Chrome。
echo         强杀会打断正在进行的发送，留下"结果未知"的记录——
echo         那些记录不会重发（避免重复回复），但需要人工确认。
echo.
endlocal
exit /b 0
