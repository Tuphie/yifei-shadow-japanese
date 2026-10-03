# 参与贡献 / Contributing

欢迎提 Issue 和 PR！

## 代码结构

```
extension/
  manifest.json   MV3 配置
  inject.js       运行在 YouTube 页面主环境：读取字幕轨；必要时借用播放器自己请求字幕时带的 pot 令牌
  content.js      跟读引擎（自动停顿 / 单句循环 / 单句播放），通过 chrome.runtime 与侧边栏通信
  sidepanel.*     侧边栏界面：句子卡片、查词、录音、AI 拆解、生词本、设置
  core.js         纯函数：字幕解析、切句、翻译对齐、注音对齐、分词合并（Node 可直接测试）
  lib/ dict/      kuromoji.js 与 IPADIC 词典、WanaKana
  mic.html/js     首次麦克风授权页（侧边栏不能直接弹权限框）
tests/            core.js 单元测试（node --test）
scripts/build.sh  打包 Release zip
```

数据流：`inject.js`（页面）⇄ `window.postMessage` ⇄ `content.js`（内容脚本）⇄ `chrome.runtime` ⇄ `sidepanel.js`

## 本地开发

1. `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/`
2. 改代码后点扩展卡片上的刷新按钮，再刷新 YouTube 页面
3. 侧边栏调试：在侧边栏里右键 → 检查
4. `npm install && npm test` 跑单元测试

## 约定

- 不引入构建工具和框架，保持"加载文件夹即可运行"
- 不加任何遥测或第三方统计
- 新的外部请求需要在 `PRIVACY.md` 里说明
- 切句、注音逻辑改动请在 `tests/core.test.js` 加用例
- 提交信息中英文均可，说清楚改了什么、为什么

## 发布

1. 修改 `extension/manifest.json` 和 `package.json` 的版本号
2. `npm run build` 生成 `dist/kage-v<版本>.zip`
3. 在 GitHub 新建 Release，tag 为 `v<版本>`，上传 zip
