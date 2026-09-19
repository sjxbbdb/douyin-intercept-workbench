@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  抖音自动回复工作台 —— 客户端启动脚本（Windows）
rem ============================================================
rem
rem  ⚠️ 本脚本承担三件"必须在启动前做完"的检查，缺一个都会让商家
rem     看到一堆看不懂的报错：
rem
rem    ① Node 版本自检。项目硬要求 >= 22.5（服务端用到 22.5 引入的
rem       node:sqlite；客户端用到内置的 fetch/AbortSignal 等）。
rem       版本不够时**必须给出人话提示**，不能直接把栈丢给商家。
rem
rem    ② 依赖自检。唯一依赖是 ws。分发方式推荐随包内置
rem       node_modules/ws，使商家"解压即用"；若缺失，这里要明确
rem       告诉他去找谁，而不是让 node 抛 MODULE_NOT_FOUND。
rem
rem    ③ 登录令牌。本地控制台绑 127.0.0.1 且要求会话令牌（旧代码
rem       绑 0.0.0.0 + 零鉴权，导致局域网内任何人可代替商家发评论，
rem       见 AGENTS.md §2.13）。令牌由客户端启动时写到实例目录下的
rem       ui-token.txt，这里读出来拼进 URL 供浏览器打开——
rem       **不要**把带令牌的 URL 打进日志或截图分享出去。
rem
rem  ⚠️ 路径一律相对本脚本所在目录解析，禁止写死盘符
rem     （旧代码的 D-1 缺陷就是写死 D:\deep seek\ 导致换机器跑不通）。

cd /d "%~dp0.."

echo.
echo   抖音自动回复工作台 —— 正在启动...
echo   ------------------------------------------------

rem ---------- ① Node 版本自检 ----------
where node >nul 2>nul
if errorlevel 1 (
  echo   [x] 没有找到 Node.js。
  echo.
  echo       这个程序需要 Node.js 22.5 或更高版本。
  echo       请安装后重新运行：https://nodejs.org/
  echo       安装时保持默认选项即可（会自动加入 PATH）。
  echo.
  pause
  exit /b 1
)

for /f "tokens=* usebackq" %%v in (`node -e "process.stdout.write(process.versions.node)"`) do set NODE_VER=%%v
for /f "tokens=1,2 delims=." %%a in ("!NODE_VER!") do (
  set NODE_MAJOR=%%a
  set NODE_MINOR=%%b
)

set VER_OK=0
if !NODE_MAJOR! GTR 22 set VER_OK=1
if !NODE_MAJOR! EQU 22 if !NODE_MINOR! GEQ 5 set VER_OK=1

if !VER_OK! EQU 0 (
  echo   [x] Node.js 版本过低：当前 !NODE_VER!，需要 22.5 或更高。
  echo.
  echo       请到 https://nodejs.org/ 下载 LTS 版本覆盖安装。
  echo.
  pause
  exit /b 1
)
echo   [v] Node.js !NODE_VER!

rem ---------- ② 依赖自检 ----------
node -e "require.resolve('ws')" >nul 2>nul
if errorlevel 1 (
  echo   [x] 缺少运行库 ws。
  echo.
  echo       正常分发包里应当自带 node_modules 目录。
  echo       若你是从源码目录运行，请先执行：npm install --omit=dev
  echo       若你是商家，请联系提供本程序的人重新获取完整压缩包。
  echo.
  pause
  exit /b 1
)
echo   [v] 运行库齐全

rem ---------- 实例标识 ----------
rem 多账号时每个账号一个实例目录（数据与专用 Chrome 配置互相隔离）。
if "%REPLY_INSTANCE_ID%"=="" set REPLY_INSTANCE_ID=default
set INSTANCE_DIR=instances\!REPLY_INSTANCE_ID!
set TOKEN_FILE=!INSTANCE_DIR!\ui-token.txt

rem ---------- ③ 启动客户端 ----------
echo   [.] 正在启动本地控制台...
start "抖音自动回复工作台" /min cmd /c "node client\host\main.js"

rem 等令牌文件出现（最多 30 秒）。首次启动要下载/解压依赖时会更慢。
set WAITED=0
:wait_token
if exist "!TOKEN_FILE!" goto token_ready
set /a WAITED+=1
if !WAITED! GEQ 60 goto token_timeout
rem ping 用作 sleep（timeout 命令在无控制台环境会报错）
ping -n 2 127.0.0.1 >nul
goto wait_token

:token_timeout
echo.
echo   [!] 本地控制台在 30 秒内没有就绪。
echo.
echo       请查看那个最小化的窗口里的提示（标题：抖音自动回复工作台）。
echo       常见原因：
echo         · 端口 8090 被占用：设置 REPLY_UI_PORT=另一个端口 后重试
echo         · 授权中心地址不对：设置 REPLY_LICENSE_URL 后重试
echo         · 专用 Chrome 无法启动：检查是否已装 Chrome
echo.
pause
exit /b 1

:token_ready
set /p UI_TOKEN=<"!TOKEN_FILE!"

rem 端口与实例目录从实例配置读取（客户端启动时可能已写入覆盖值）
set UI_PORT=8090
if exist "!INSTANCE_DIR!\client-config.json" (
  for /f "usebackq tokens=2 delims=:," %%p in (`findstr /i "\"uiPort\"" "!INSTANCE_DIR!\client-config.json"`) do (
    set RAW=%%p
    set RAW=!RAW: =!
    if not "!RAW!"=="" set UI_PORT=!RAW!
  )
)
if not "%REPLY_UI_PORT%"=="" set UI_PORT=%REPLY_UI_PORT%

echo   [v] 本地控制台已就绪
echo.
echo   正在打开界面...
echo.
echo   ⚠️ 界面地址里带着访问令牌，请不要把这个完整地址截图或转发给别人——
echo      拿到它的人可以在你的电脑上代替你发送评论与私信。
echo.

start "" "http://127.0.0.1:!UI_PORT!/?token=!UI_TOKEN!"

echo   界面已打开。关闭那个最小化的窗口即可停止程序。
echo.
endlocal
exit /b 0
