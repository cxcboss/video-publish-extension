# 视频发布助手

AI 驱动的浏览器扩展 + 桌面管理工具，支持自动发布视频到抖音和视频号平台。

## 功能特性

- **双平台发布** — 抖音、视频号一键发布
- **AI 智能生成** — 根据视频内容自动生成话题标签和描述文案
- **多 AI Provider** — 小米 MiMo、OpenAI、Gemini、豆包、DeepSeek
- **定时发布** — 抖音原生定时发布，视频号自动延时
- **批量发布** — 目录自动加载，拖拽排序，队列发布
- **星图任务** — 抖音小游戏自动关联星图任务
- **超时重试** — 阶段感知的可靠重试（v2.9.0 重构），点击发布后自动防重复
- **断点恢复** — 发布中断后一键恢复未完成队列（v2.10.0）
- **失败重发** — 历史页一键把失败视频送回插件队列（v2.10.0）

## 文档

| 文档 | 说明 |
|------|------|
| [更新日志](CHANGELOG.md) | 各版本变更记录 |
| [版本发布准则](docs/RELEASING.md) | 版本号规则、发布流程、检查清单 |
| [开发规范](docs/DEVELOPMENT.md) | 目录职责、核心架构、代码约定 |

## 项目结构

```
video-publish-extension/
├── chrome-extension/          # Chrome 浏览器扩展
│   ├── manifest.json
│   ├── popup/                 # 弹窗 UI（发布控制面板）
│   ├── background/            # 后台服务（AI 调用、发布流程、超时重试、状态持久化）
│   ├── content/               # 页面自动化脚本
│   │   ├── douyin.js          # 抖音创作者平台
│   │   └── weixin.js          # 视频号发布平台
│   ├── shared/                # 三端共用纯函数（含单元测试覆盖）
│   └── icons/
├── local-server/              # Node.js 本地服务
│   ├── server.js              # Express，视频文件读取 + 发布历史 + 重发队列
│   └── package.json
├── tests/                     # node:test 测试（纯函数 + 服务 API/安全）
├── mac-app/                   # Mac 原生桌面工具（Swift/SwiftUI）
│   ├── Package.swift
│   └── Sources/
├── win_app/                   # Windows 桌面工具（Flutter）
│   ├── lib/main.dart
│   └── assets/                # 打包副本（发布时同步）
├── docs/                      # 项目文档
└── .github/workflows/         # CI/CD（测试 + 自动构建）
```

## 快速开始

### 方式一：桌面 App（推荐）

1. 下载对应平台的桌面工具（Mac / Windows）
2. 打开 App → 点击「安装环境」（安装 Node.js 依赖）
3. 点击「安装插件」→ 按教程在 Chrome 加载扩展
4. 点击「启动服务」

### 方式二：手动安装

```bash
# 1. 启动本地服务
cd local-server && npm install && node server.js

# 2. Chrome 加载扩展
#    chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 chrome-extension/
```

## AI 配置

扩展内点击「AI 配置」展开设置：

| Provider | 端点 | 默认模型 |
|----------|------|----------|
| 小米 MiMo | `api.xiaomimimo.com` | mimo-v2.5 |
| OpenAI | `api.openai.com` | gpt-4o-mini |
| Gemini | `generativelanguage.googleapis.com` | gemini-2.0-flash |
| 豆包 | `ark.cn-beijing.volces.com` | doubao-seed-2-0-mini-260215 |
| DeepSeek | `api.deepseek.com` | deepseek-chat |

## 文件命名规则

| 格式 | 行为 |
|------|------|
| `游戏名-视频描述.mp4` | AI 生成文案 |
| `123-xxx.mp4` | 跳过 AI，使用默认话题 |
| `小游戏-任务名.mp4` | 抖音自动关联星图任务 |
| `原创-xxx.mp4` | 跳过活动选择 |

## DOM 元素参考

### 抖音创作者平台

| 元素 | 选择器 |
|------|--------|
| 上传入口 | `input[type="file"][accept*="video"]` |
| 主编辑器 | `[contenteditable="true"]`，排除"话题/tag"，取面积最大 |
| 话题输入框 | `[contenteditable="true"]`，placeholder 含"话题/tag/#" |
| 定时发布 | 文本"定时发布"，向上遍历找 switch/button |
| 日期时间 | `input[placeholder*="日期"]`，格式 `YYYY-MM-DD HH:MM` |
| 发布按钮 | `button` 文本"发布"/"发表" |
| 星图任务按钮 | 文本"请选择星图任务"，需先滚动页面触发懒加载 |

### 视频号（wujie shadow DOM）

| 元素 | 选择器 |
|------|--------|
| shadow 根 | `document.querySelector('wujie-app').shadowRoot` |
| 活动按钮 | `.activity-display-wrap`，默认"不参与活动" |
| 活动搜索 | `.activity-filter-wrap` 内的 input |
| 活动选项 | `.activity-item` / `.option-item` → `SPAN.name` |
| 发布按钮 | shadow 内 `button` 文本"发表" |

## 本地服务 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/api/videos?path=` | 视频列表 |
| GET | `/api/video/file?path=` | 视频文件（Range） |
| GET | `/api/directories?path=` | 子目录列表 |
| GET | `/api/publish-history?limit=&offset=` | 发布历史（分页） |
| POST | `/api/publish-record` | 新增记录 |
| DELETE | `/api/publish-record/:id` | 删除记录 |
| GET | `/api/retry-queue` | 重发队列 |
| POST | `/api/retry-queue` | 加入重发队列（幂等） |
| DELETE | `/api/retry-queue` | 清空重发队列 |

### 安全说明

本地服务运行在 localhost，但浏览器内任意网页都可向其发起请求。服务内置三层防护：

1. **Host 校验** — 仅接受回环地址（`localhost`/`127.0.0.1`/`::1`），阻断 DNS rebinding；
2. **Origin 白名单** — 仅放行扩展（`chrome-extension://`）、抖音/视频号创作者平台、本机页面；
3. **Sec-Fetch-Site 校验** — 无 Origin 的跨站请求（媒体/图片标签等）一律拒绝。

### 端口配置

默认端口 `3000`。可通过环境变量 `PORT` 启动其他端口（`PORT=3001 node server.js`），
并在扩展侧面板的「本地服务端口」输入框填写相同端口（保存于扩展存储，自动同步各端）。

### 选择器覆盖（平台改版应急）

平台改版导致自动化失效时，可向 `chrome.storage.local` 写入 `selectorOverrides` 应急，
无需改代码。支持的覆盖项（douyin / weixin 各自为独立对象）：

| 平台 | 键 | 说明 |
|------|-----|------|
| douyin | `uploadInputSelectors` | 上传入口选择器数组 |
| douyin | `publishButtonTextsP1` / `publishButtonTextsP2` | 发布按钮文本（优先级 1/2） |
| douyin | `tagInputKeywords` | 话题输入框识别关键词 |
| douyin | `starTaskBtnTexts` | 星图任务入口按钮文本 |
| weixin | `publishButtonTextsP1` / `publishButtonTextsP2` | 发布按钮文本 |
| weixin | `activityItemSelectors` | 活动选项选择器数组 |

## 许可证

MIT License
