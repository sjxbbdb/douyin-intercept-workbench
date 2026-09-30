# Windows 构建存储位置

桌面端的 Electron、electron-builder 和 NSIS 会在构建或安装时产生大体积临时文件。桌面端的 `build`、`build:portable` 和 `build:nsis` 已通过 `desktop/scripts/build-with-d-temp.cjs` 将 `TEMP`、`TMP`、`ELECTRON_CACHE` 和 `ELECTRON_BUILDER_CACHE` 定向到：

```text
D:\DevTools\douyin-agent\
├─ temp\
├─ electron-cache\
└─ electron-builder-cache\
```

开发机还应把当前用户的 `TEMP` 和 `TMP` 设置为 `D:\DevTools\douyin-agent\temp`，这样运行安装包时产生的解压目录也不会回到 C 盘。修改环境变量后，需要重新打开终端、IDE 和 Codex 进程。

发行给其他用户的安装包仍会使用对方 Windows 的系统临时目录，这是安装器的系统行为；便携版可以减少安装器残留，但不能改变目标机器的临时目录规则。
