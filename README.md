# ReelHub

Android 短剧客户端。界面用 React，外壳用 Tauri 2。

## 安装

打上 `v*` 标签后，GitHub Actions 会编译 Android APK，并挂到对应的 Release 上。也可以在 Actions 里手动运行 **Release**，产物在该次运行的 Artifacts 里。

安装包按 CPU 架构分开：

| 架构 | 文件名 |
| --- | --- |
| arm64-v8a | `ReelHub_<版本>_arm64-v8a.apk`（绝大多数手机） |
| armeabi-v7a | `ReelHub_<版本>_armeabi-v7a.apk` |
| x86_64 | `ReelHub_<版本>_x86_64.apk`（模拟器） |

仓库地址：<https://github.com/ceoifung/ReelHub>

## 本地开发

需要 Node.js 22+、pnpm 10+、Rust 1.90+，以及 Android SDK / NDK。

```bash
pnpm install
pnpm dev
pnpm tauri android dev
pnpm tauri android build --apk
```

## 技术栈

| 层级 | 方案 |
| --- | --- |
| 外壳 | Rust、Tauri 2 |
| 界面 | React 19、TypeScript、Vite、Tailwind CSS |
| 播放 | hls.js |
| 网络 | reqwest、rustls |
