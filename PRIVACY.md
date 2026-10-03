# 隐私说明 / Privacy

**Kage 影读不收集任何数据，也没有自己的服务器。**

| 数据 | 存在哪里 | 发给谁 |
|---|---|---|
| 字幕、句子缓存 | 你本机浏览器（`chrome.storage.local`） | 不外发 |
| 生词本 | 你本机浏览器 | 不外发；导出 CSV 由你自己保存 |
| 跟读录音 | 只在内存里，关闭侧边栏即消失 | 不外发、不保存 |
| 点击查询的单词 | — | Jisho.org（公开词典 API） |
| AI 拆解的句子 / 单词 | — | 仅当你填了 API Key 时，发给**你自己选择**的模型服务商（Anthropic 或 OpenAI 兼容服务） |
| 「AI 优化断句」时的字幕文本 | — | 只有你点这个按钮时，才把这个视频的字幕文字发给你选择的模型服务商 |
| 手动调整的断句 | 你本机浏览器 | 不外发 |
| 「导出断句数据」的文件 | 下载到你电脑 | 由你决定是否发给别人 |
| API Key | 你本机浏览器 | 只用于直接调用你选择的服务商 |

插件申请的权限：
- `sidePanel` 侧边栏；`storage` / `unlimitedStorage` 本地缓存；`tabs` 识别当前 YouTube 标签页
- `youtube.com` 读取字幕、控制播放；`jisho.org` 查词；`api.anthropic.com` AI 拆解
- 可选：你在设置里填写的 OpenAI 兼容 Base URL（使用前会单独请求授权）

---

**Kage collects nothing and has no backend.** Captions, cache and your word list stay in your browser. Recordings live only in memory. Looked-up words go to Jisho.org; sentences go to an LLM provider only if you add your own API key.
