@echo off
setlocal
set ROOT=%~dp0
set VENV=%ROOT%.pyinstaller-venv
cd /d "%ROOT%"
if not exist "%VENV%\Scripts\python.exe" (
  py -3 -m venv "%VENV%" || exit /b 1
)
"%VENV%\Scripts\python.exe" -m pip install --disable-pip-version-check "pyinstaller==6.11.1" || exit /b 1
"%VENV%\Scripts\pyinstaller.exe" --clean --noconfirm --distpath "%ROOT%dist" --workpath "%ROOT%build" "%ROOT%probe_sidecar.spec" || exit /b 1
echo Built dist\probe-agent\probe-agent.exe
endlocal
