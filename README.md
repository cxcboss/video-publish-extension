# Video Publish Extension

AI 驱动的浏览器扩展，支持自动发布视频到抖音和视频号平台。

## 功能特性

- **双平台支持** — 抖音、视频号一键发布
- **AI 智能生成** — 根据视频内容自动生成话题标签（最多5个）和描述文案
- **多 AI Provider** — 支持小米 MiMo、OpenAI GPT、Google Gemini、豆包、DeepSeek
- **定时发布** — 抖音原生定时发布对接，视频号自动延时
- **批量发布** — 选择目录自动加载全部视频，拖拽排序，批量发布
- **发布进度** — 实时显示当前步骤（AI 生成中 / 上传中 / 填写信息 / 发布中）
- **发布历史** — 本地服务记录每次发布，支持查看和删除

## 快速开始

### 1. 启动本地服务

```bash
cd local-server
npm install   # 首次运行需要安装依赖
node server.js
```

服务运行在 `http://localhost:3000`，提供视频文件读取和发布历史管理。

### 2. 加载 Chrome 扩展

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `chrome-extension` 文件夹

### 3. 配置 AI（可选）

点击扩展中的「AI 配置」展开设置：

| Provider | API 端点 | 默认模型 |
|----------|----------|----------|
| 小米 MiMo | `https://api.xiaomimimo.com/v1` | mimo-v2.5 |
| OpenAI | `https://api.openai.com/v1` | gpt-4o-mini |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | gemini-2.0-flash |
| 豆包 | `https://ark.cn-beijing.volces.com/api/v3` | doubao-seed-2-0-mini-260215 |
| DeepSeek | `https://api.deepseek.com/v1` | deepseek-chat |

填入 API Key 后点击「测试连接」验证是否可用。

### 4. 发布视频

1. 选择平台（抖音 / 视频号）
2. 输入或浏览选择视频目录
3. 开启「AI 生成文案和标签」并填写视频内容描述（可选）
4. 设置定时发布（可选）
5. 点击「发布」

## 目录结构

```
video-publish-extension/
├── chrome-extension/          # Chrome 扩展
│   ├── manifest.json          # 扩展配置
│   ├── popup/                 # 弹窗 UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── background/            # 后台服务
│   │   └── background.js      # AI 调用、发布流程控制
│   ├── content/               # 内容脚本
│   │   ├── douyin.js          # 抖音页面自动化
│   │   └── weixin.js          # 视频号页面自动化
│   └── icons/
├── local-server/              # 本地服务
│   ├── server.js              # Express 服务，视频文件读取 + 发布历史
│   └── package.json
├── start-mac.sh               # Mac 启动脚本
├── start-win.bat              # Windows 启动脚本
├── video-publisher-launcher.py # 跨平台 Python 启动器
└── README.md
```

## 页面元素参考（DOM 结构记录）

### 抖音创作者平台 (creator.douyin.com)

| 元素 | 选择器 / 说明 |
|------|---------------|
| 上传入口 | `input[type="file"][accept*="video"]`，兜底 `input[type="file"]` |
| 主编辑器（描述） | `[contenteditable="true"]`，排除 placeholder 含"话题/tag/搜索"的，取面积最大的 |
| 话题输入框 | `[contenteditable="true"]`，placeholder 含"话题/tag/搜索/#"，或 class 含 tag/topic |
| 定时发布开关 | 文本含"定时发布"/"定时"/"预约发布"的元素，向上遍历找 button/label/input/switch |
| 联合日期时间 input | `input[placeholder="日期和时间"]`，值格式 `YYYY-MM-DD HH:MM`，**日期和时间是同一个 input** |
| 发布按钮 | `button` 文本 === "发布"或"发表"，排除"高清"和"定时"相关按钮 |
| 上传完成检测 | `[contenteditable="true"], textarea, [class*="editor"], [class*="desc"]` 可见即就绪 |

### 视频号发布页面 (channels.weixin.qq.com)

**重要**：视频号使用 wujie 微前端，发布表单在 `<wujie-app class="wujie_iframe">` 的 **shadow DOM** 内，主文档不含表单元素。

| 元素 | 选择器 / 说明 |
|------|---------------|
| shadow 根节点 | `document.querySelector('wujie-app').shadowRoot` |
| 上传入口 | shadow 内 `input[type="file"]` |
| 描述输入框 | shadow 内 `[contenteditable="true"]`，面积最大且排除标签输入框 |
| 话题输入框 | shadow 内 `[contenteditable="true"]`，placeholder 含"话题/tag/#" |
| **活动按钮** | shadow 内 `.activity-display-wrap` 或 `.activity-display`，默认显示"不参与活动" |
| **活动下拉面板** | shadow 内 `.activity-filter-wrap`（隐藏时 0x0） |
| **活动搜索框** | `.activity-filter-wrap` 内的 `input`，或 shadow 内所有可见 input |
| **活动选项列表** | `.activity-filter-wrap` → `.activity-item` / `.option-item` → `SPAN.name` |
| 活动标签文字 | shadow 内 `DIV` class `label`，文本 "活动" |
| 定时发布 | shadow 内 `input[type="radio"]` 文本"定时"，选中后展开时间选择器 |
| 原创声明 | shadow 内 `input[type="checkbox"]`，文本含"声明原创" |
| 发布按钮 | shadow 内 `button` 文本"发表" |

### 视频号活动选择流程

```
1. wujie-app.shadowRoot.querySelector('.activity-display-wrap').click()
2. 等待 2000ms（下拉面板动画）
3. 在 .activity-filter-wrap 内找到 input 搜索框
4. 逐字输入活动名称（每字 120ms 延迟模拟真人输入）
5. 等待 3000ms 搜索结果加载
6. 在搜索结果中找 .activity-item 或 .option-item 包含活动名称
7. 点击匹配项
8. 等待 2000ms
9. 验证 .activity-display 文本已变化（不再显示"不参与活动"）
```

## 文件命名规则

| 文件名格式 | 行为 |
|-----------|------|
| `游戏名-视频描述.mp4` | 使用 AI 生成文案 |
| `123-xxx.mp4` | 跳过 AI，使用默认话题 |
| `原创-xxx.mp4` | 跳过活动选择 |
| `test video.mp4` | 跳过 AI，使用默认话题 |

## 支持的视频格式

`.mp4` `.mov` `.avi` `.mkv` `.flv` `.wmv` `.webm`

## API 接口

本地服务提供以下接口：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/api/videos?path=` | 获取目录下的视频列表 |
| GET | `/api/video/file?path=` | 获取视频文件（支持 Range 请求） |
| GET | `/api/video/info?path=` | 获取视频文件信息 |
| GET | `/api/directories?path=` | 获取子目录列表 |
| GET | `/api/publish-history` | 获取发布历史 |
| POST | `/api/publish-record` | 新增发布记录 |
| DELETE | `/api/publish-record/:id` | 删除发布记录 |
| GET | `/` | 发布历史页面 |

## 更新日志

### v1.8.0 (2026-07-01)

**抖音定时发布修复**
- 修复日期和时间互相覆盖的 bug：抖音页面的"日期和时间"是同一个 `<input type="text">` 元素，之前分两次设置导致互相覆盖，最终只剩时间。现在一次性设完整 `YYYY-MM-DD HH:MM` 字符串
- 用 `new Date()` 解析时间字符串存在时区偏移问题，改用手动 split 解析

**标签页管理**
- 发布完成后自动关闭发布页面，避免标签页累积
- 最后一个视频发布完成后关闭标签页并打开发布记录页
- 修复视频号最后一个视频标签页不关闭的 bug（`targetTabId` 在 `finishAllPublish` 之前被置 null）

**抖音发布记录**
- 发布完成后自动保存记录到发布历史页面（和视频号统一）

**视频号优化**
- 修复 `parseVideoName` 正则：活动名含 `-` 时截断问题（`小游戏-新年-活动.mp4` 现在正确匹配）
- 页面加载等待优化
- 定时发布后等待时间缩短

### v1.7.0

主题色改回绿色，中文名"AI 视频发布助手"

### v1.6.0

主题色改红色

### v1.5.0

主题色改回绿色

### v1.4.0

主题色蓝色，GitHub Releases 更新机制

### v1.3.0

深色/浅色模式，发布按钮绿色，自定义图标

### v1.2.0

发布进度条，发布/停止合并，定时发布对接，自动更新

### v1.1.0

AI 多 Provider 支持，批量发布

### v1.0.0

初始版本，双平台发布支持

## 许可证

MIT License
