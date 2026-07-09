# 视频发布助手 - 开发准则

## 版本号管理（严格遵守）

每次发布新版本时，必须同时更新以下两个文件中的版本号，保持完全一致：

1. `chrome-extension/manifest.json` → `"version": "x.x.x"`
2. `chrome-extension/popup/popup.html` → `<span class="version">vx.x.x</span>`

**发布流程：**
1. 修改代码
2. 同步更新 manifest.json 和 popup.html 的版本号
3. 提交代码
4. 推送到 GitHub
5. 创建 Release 并上传 chrome-extension.zip
6. 验证 zip 包内两个文件的版本号一致

缺少任何一处版本号更新都属于严重失误。
