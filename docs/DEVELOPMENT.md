# 开发规范

本文档描述项目的目录职责、核心架构、代码约定与开发流程。

## 目录结构

```
├── chrome-extension/          # Chrome 扩展（核心）
│   ├── manifest.json          # 扩展配置 + 版本号（主版本来源）
│   ├── background/            # MV3 Service Worker：发布流程编排、AI 调用、超时重试
│   ├── content/               # 页面自动化脚本（douyin.js / weixin.js）
│   ├── popup/                 # 侧边栏 UI（发布控制面板）
│   └── icons/
├── local-server/              # Node.js 本地服务（Express）
│   └── server.js              # 视频文件读取 + 发布历史
├── mac-app/                   # Mac 桌面工具（Swift/SwiftUI）
├── win_app/                   # Windows 桌面工具（Flutter）
│   └── assets/                # ⚠️ 扩展/服务的打包副本（发布时手动同步，见 RELEASING.md）
├── docs/                      # 文档
│   ├── DEVELOPMENT.md         # 本文档
│   └── RELEASING.md           # 版本发布准则
├── .github/workflows/         # CI/CD（push 自动构建 Mac/Windows）
├── CHANGELOG.md               # 更新日志
└── README.md
```

## 核心架构

### 发布流程（background ↔ content 消息协议）

```
popup ──startPublishFlow──> background ──(创建标签页)──> 平台发布页
                                │  tabs.onUpdated(complete) → sendPublishCommand
                                │  ──startPublish──> content 脚本执行发布
                                │  <──publishStage── 阶段上报（见下）
                                │  <──douyinPublishDone / weixinPublishDone── 完成上报
                                └──progressUpdate──> popup 进度显示
```

### 阶段机（失败重试核心，v2.9.0 起）

内容脚本在关键节点上报阶段，background 据此管理超时与重试：

| 阶段 | 含义 | 超时行为 |
|------|------|----------|
| `loading` | 页面加载 | 停滞超时 → 安全重试 |
| `uploading` | 上传视频（带文件大小） | 停滞超时 → 安全重试（上传超时按大小自适应） |
| `filling` | 填写表单 | 停滞超时 → 安全重试 |
| `clicked` | **已点击发布按钮** | **安全边界：绝不自动重试**，延长验证等待 |
| `verifying` | 验证发布结果 | 同上；仍无结果 → 记录「结果未知」 |
| `done/failed` | 完成 | 通过完成消息上报 |

**铁律**：`clicked` 之后禁止自动重试（视频可能已发出，重试 = 重复发布）。
内容脚本收到 abort 信号时若 `clickedPublish = true`，必须拒绝中止。

### 发布结果三态

| 状态 | 含义 | 历史页显示 |
|------|------|-----------|
| `success` | 已验证发布成功 | 绿色「已发」 |
| `failed` | 明确失败（页面报错/停滞超时） | 红色「失败」 |
| `unknown` | 已点击发布但结果不明 | 紫色「结果未知」 |

## 代码约定

- 扩展为 MV3，background 是 Service Worker（无 DOM，长任务注意 SW 休眠与定时器丢失）
- 消息协议新增 action 时，同时更新 background 的 `onMessage` 与发送方
- 用户可控文本（视频文件名）进入 `innerHTML` / `onclick` 前必须转义
- 内容脚本与 background 之间的完成信号必须携带 `videoIndex` 供校验
- 不引入外部依赖；扩展内 AI 调用直接在 background 实现（多 Provider 配置见 `getAIProviderConfig`）

## 本地开发

```bash
# 本地服务
cd local-server && npm install && node server.js

# 扩展调试
# chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 chrome-extension/

# 语法检查
node --check chrome-extension/background/background.js
node --check chrome-extension/content/douyin.js
node --check chrome-extension/content/weixin.js
node --check chrome-extension/popup/popup.js
node --check local-server/server.js
```

## 提交约定

- 提交消息：`vX.Y.Z: 简短描述`（版本发布提交），日常修复可用 `fix: 描述`
- 发布流程见 [RELEASING.md](RELEASING.md)
