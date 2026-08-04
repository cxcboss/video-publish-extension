# 版本发布准则

本文档定义本项目的版本号规则、发布流程与检查清单。发布前**必须**完整执行。

## 版本号规则

采用语义化版本 `主版本.次版本.修订版本`（X.Y.Z）：

| 变更类型 | 版本变化 | 示例 |
|----------|----------|------|
| 不兼容的重大改动 / 架构重构 | 主版本 +1 | 3.0.0 |
| 新功能 / 功能重构 | 次版本 +1 | 2.9.0 → 2.10.0 |
| Bug 修复 / 微小调整 | 修订版本 +1 | 2.9.0 → 2.9.1 |

发布前必须给对应版本写一条 `CHANGELOG.md` 记录，格式见 [CHANGELOG.md](../CHANGELOG.md)。

## 版本号同步点（发布前必须全部检查）

本项目有多个位置持有版本号，**遗漏任何一个都会导致各端版本不一致**：

| # | 文件 | 说明 |
|---|------|------|
| 1 | `chrome-extension/manifest.json` → `version` | 扩展版本（**主版本号来源**） |
| 2 | `win_app/assets/chrome-extension/manifest.json` | Windows 打包副本（随 #1 同步） |
| 3 | `win_app/pubspec.yaml` → `version` | Windows App 版本（`X.Y.Z+1`） |
| 4 | `.github/workflows/build-mac.yml` → `CFBundleVersion` / `CFBundleShortVersionString` | Mac App 打包版本 |
| 5 | `chrome-extension/popup/popup.html` | 已动态读取 manifest，无需修改 |

检查命令：

```bash
grep '"version"' chrome-extension/manifest.json win_app/assets/chrome-extension/manifest.json
grep '^version:' win_app/pubspec.yaml
grep 'CFBundleVersion' .github/workflows/build-mac.yml
```

## win_app/assets 同步（发布前必须执行）

`win_app/assets/` 是 Windows 打包时注入的扩展与本地服务副本，**不是自动生成的**，发布前必须手动同步：

```bash
# 扩展代码
cp chrome-extension/manifest.json win_app/assets/chrome-extension/manifest.json
cp chrome-extension/background/background.js win_app/assets/chrome-extension/background/background.js
cp chrome-extension/content/douyin.js win_app/assets/chrome-extension/content/douyin.js
cp chrome-extension/content/weixin.js win_app/assets/chrome-extension/content/weixin.js
cp chrome-extension/popup/popup.js win_app/assets/chrome-extension/popup/popup.js
cp chrome-extension/popup/popup.html win_app/assets/chrome-extension/popup/popup.html
cp chrome-extension/popup/popup.css win_app/assets/chrome-extension/popup/popup.css

# 本地服务
cp local-server/server.js win_app/assets/local-server/server.js
cp local-server/package.json win_app/assets/local-server/package.json
```

同步后验证一致性：

```bash
diff -q chrome-extension/background/background.js win_app/assets/chrome-extension/background/background.js
diff -q local-server/server.js win_app/assets/local-server/server.js
```

## 发布前检查清单

- [ ] 所有修改已自测（扩展在 Chrome 加载运行 / 本地服务 `node server.js`）
- [ ] JS 语法检查通过：`node --check <file>`（所有 `.js` 文件）
- [ ] JSON 文件有效：`manifest.json`、`package.json`
- [ ] `CHANGELOG.md` 已添加当前版本记录
- [ ] 版本号同步点（上文表格）全部更新
- [ ] `win_app/assets/` 已同步并 diff 验证
- [ ] 无敏感信息进入仓库（token、本地绝对路径、运行时数据）
- [ ] `git status` 干净（无 `.DS_Store`、日志、临时文件）

## 发布流程

```bash
# 1. 检查并暂存
git status
git add -A

# 2. 提交（消息格式：vX.Y.Z: 一句话描述）
git commit -m "v2.9.0: 失败重试功能重构，修复重试不生效问题"

# 3. 打标签并推送（推送触发 GitHub Actions 构建 Mac/Windows）
git tag v2.9.0
git push origin main --tags

# 4. 创建 GitHub Release（标题格式：vX.Y.Z: 描述）
gh release create v2.9.0 --repo cxcboss/video-publish-extension \
  --title "vX.Y.Z: 描述" --notes "$(cat RELEASE_NOTES.md)"

# 5. 确认 CI 构建成功
gh run list --repo cxcboss/video-publish-extension --limit 3
```

提交消息约定：`vX.Y.Z: 简短描述`（参考历史提交）。

## 回滚

- **代码回滚**：`git revert <commit>`（不要 amend 已推送的提交）
- **版本回滚**：发布新修订版本（如 2.9.1）修复，不删除已发布的 tag/Release
