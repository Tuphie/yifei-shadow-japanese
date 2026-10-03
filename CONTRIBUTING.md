# 参与贡献 / Contributing

欢迎提 Issue 和 PR！

## 代码结构

```
extension/
  manifest.json   MV3 配置
  inject.js       运行在 YouTube 页面主环境：读取字幕轨；必要时借用播放器自己请求字幕时带的 pot 令牌
  content.js      跟读引擎（自动停顿 / 单句循环 / 单句播放），通过 chrome.runtime 与侧边栏通信
  sidepanel.*     侧边栏界面：句子卡片、查词、录音、AI 拆解、生词本、设置
  core.js         纯函数：字幕解析、翻译对齐、注音对齐、分词合并
  segment.js      断句引擎：词级时间轴 → 断点打分 → 动态规划；手动拆分 / 合并；AI 标点映射
  jlpt.js         JLPT 等级查询与视频难度统计
  data/jlpt.json  离线等级词表（CC BY-SA 4.0，见 data/NOTICE-jlpt.md）
  lib/ dict/      kuromoji.js 与 IPADIC 词典、WanaKana
  mic.html/js     首次麦克风授权页（侧边栏不能直接弹权限框）
tests/            单元测试（node --test）
  fixtures/       断句评测用的字幕：*.gold.json 是正确断句；real/ 放用户反馈的真实样本
  make-fixtures.js  生成合成测试字幕（模拟 YouTube json3 的人工字幕和自动字幕格式）
  eval-seg.js     断句评测：npm run bench
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
- 改断句逻辑后跑 `npm run bench`，F1 不能低于 `tests/segment.test.js` 里的下限；提高了就把下限也调上去
- 收到用户导出的 `kage-seg-*.json`：人工标注正确断句后放进 `tests/fixtures/real/`
- 注音、分词逻辑改动请在 `tests/core.test.js` 加用例
- 提交信息中英文均可，说清楚改了什么、为什么

## 发布

发布是自动的（`.github/workflows/release.yml`）：

1. 修改 `extension/manifest.json` 和 `package.json` 的版本号
2. 在 `CHANGELOG.md` 顶部加一节 `## v<版本>`，写这一版的更新内容
3. 提交后打标签并推送：`git tag v<版本> && git push origin v<版本>`

GitHub Actions 会检查标签和 manifest 版本一致、跑测试、打包 zip，然后用 CHANGELOG 里对应的一节作为说明发布 Release。
