# PyInstaller onedir build for the trusted Electron extraResources bundle.
from pathlib import Path
from PyInstaller.building.build_main import Analysis, PYZ, EXE, COLLECT

root = Path(SPECPATH)
a = Analysis(
    [str(root / "sidecar.py")],
    pathex=[str(root)],
    binaries=[],
    datas=[],
    hiddenimports=[
        "cdp", "crawl", "douyin", "douyin_selectors", "dsh_ws", "live",
        "send_actions", "send_gate", "url_policy", "winfocus",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True,
          name="probe-agent", console=True)
coll = COLLECT(exe, a.binaries, a.datas, name="probe-agent")
