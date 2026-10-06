# dsh-conversation-screenshot — dsh 会话截图插件

dsh 插件：在 dsh Web 界面里把「用户与模型的对话」渲染成一张 PNG 长图并写入系统剪贴板；浏览器拒绝剪贴板写入时自动回退为 PNG 下载。

纯前端实现：克隆已加载的对话 DOM，读取浏览器自身的布局（盒子 + 逐字符光标矩形），直接绘制到一张 canvas 上，不依赖任何第三方渲染库。跟随 dsh 主题（深色/浅色）与中英文界面语言。

## 功能

- **整段长截图**：输入框工具栏右侧的相机按钮。截取当前会话已加载的全部对话。
  - 若会话顶部还有未加载的历史（出现「加载更早」按钮），会自动反复点击拉全历史后再截图；dsh 拉取失败时持续重试，确实拉不动则如实提示「仅含已加载的对话轮次」。
  - 内容超过浏览器画布上限（约 16000px 边长 / 44M 像素）时自动降采样，并用提示语说明实际缩放倍数。
- **单轮截图**：每条已完成回复下方操作行（悬停可见）里的相机按钮。截取**这一轮问答**——从该轮的用户提问气泡开始，到该轮回复结束（含用量/时间行），不混入相邻轮次。

## 截图范围

只截**当前打开会话**的对话区（含用户气泡、模型回复、工具调用行、文件卡片、用量行），不包含侧栏、输入框和其他会话。

## 安装

本地目录安装（推荐，便于改代码即时生效——dsh 以符号链接方式引用）：

```bash
dsh plugin --profile web add /path/to/dsh-plugin/screenshot
```

删除：

```bash
dsh plugin --profile web remove dsh-conversation-screenshot
```

安装后刷新 dsh Web 页面即可。插件名：`dsh-conversation-screenshot`。

## 使用

1. 打开任意会话；
2. 截整段：点输入框工具栏的相机按钮，等待「已复制长截图」提示；
3. 截单轮：鼠标悬停到目标回复，点该轮操作行里的相机按钮，等待「已复制本轮截图」提示；
4. 到任意支持粘贴图片的地方（聊天窗口、文档、画图工具）Ctrl+V 粘贴。

## 已知限制

- dsh 自身拉取历史偶发崩溃（控制台可见 `session-controller event feed subscriber failed`），插件会持续重试并在确实无法继续时诚实降级为部分截图。
- SVG 不参与绘制（界面图标不会出现在截图里，通常反而更干净）；若对话中出现 KaTeX 数学公式等 SVG 内容会缺失。

## 文件结构

```
├── client.js         # 全部逻辑：Canvas 绘制、历史分页、单轮定位、两个 UI 入口
├── index.js          # Host 侧占位
├── package.json      # 插件清单（client 注入项、exports）
├── cordis.patch.yml  # 服务注册补丁
├── icon.svg
└── locale/           # 插件管理器里的标题/描述翻译
    ├── en.json
    └── zh.json
```

## 开发

改 `client.js` 后刷新页面即可生效；若改动 `package.json`（如 inject 列表），dsh 服务端会重算 bundle revision。调试时注意浏览器 HTTP 缓存可能滞留旧 bundle——清缓存或改清单字段强制刷新。

验证方式：`chromium --remote-debugging-port=9222` 打开页面，用 CDP `Input.dispatchMouseEvent` 派发受信任点击，再 `navigator.clipboard.read()` 读回 PNG 检查尺寸与内容。

## 许可证

[CC0 1.0（公有领域贡献）](./LICENSE)——作者已尽可能放弃全部版权，可任意使用、修改、分发，无需署名。
