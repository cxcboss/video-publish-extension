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

## 许可证

MIT License
