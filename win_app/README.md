# win_app — Windows 桌面工具

「视频发布助手」的 Windows 桌面端（Flutter），提供：

- 一键启动本地服务（`local-server`）
- 安装/释放 Chrome 扩展（从 `assets/chrome-extension/` 复制）
- 环境依赖自动安装（Node.js）
- 系统托盘 + 开机自启
- 版本检查更新（GitHub Releases）

## 目录说明

| 路径 | 说明 |
|------|------|
| `lib/main.dart` | 主程序 |
| `assets/chrome-extension/` | 扩展打包副本（**发布时从根目录同步**，见 [docs/RELEASING.md](../docs/RELEASING.md)） |
| `assets/local-server/` | 本地服务打包副本（同上） |
| `test/widget_test.dart` | 测试 |

## 构建

```bash
flutter pub get
flutter build windows --release
```

## 版本

版本号在 `pubspec.yaml`（`X.Y.Z+1`），与扩展版本保持一致，发布时按 [docs/RELEASING.md](../docs/RELEASING.md) 同步。

## 维护注意

- `assets/` 下的文件不是自动生成的，发布前必须手动同步并 diff 验证
- 打包副本的清单：
  - `assets/chrome-extension/`：manifest.json、background.js、douyin.js、weixin.js、popup 三件套、icons
  - `assets/local-server/`：server.js、package.json
