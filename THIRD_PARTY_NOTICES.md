# Third-party notices

Kage 影读 bundles the following open-source components inside `extension/`.

| Component | Version | License | Location |
|---|---|---|---|
| [kuromoji.js](https://github.com/takuyaa/kuromoji.js) | 0.1.2 | Apache License 2.0 | `extension/lib/kuromoji.js`, license in `extension/lib/LICENSE-kuromoji.txt` |
| mecab-ipadic 2.7.0-20070801 (dictionary data shipped with kuromoji.js) | — | NAIST / ICOT terms | `extension/dict/`, full notice in `extension/dict/NOTICE-ipadic.md` |
| [WanaKana](https://github.com/WaniKani/WanaKana) | 5.3.1 | MIT | `extension/lib/wanakana.min.js`, license in `extension/lib/LICENSE-wanakana.txt` |

## Modification to kuromoji.js

`extension/lib/kuromoji.js` is the upstream browser build with one change in
`BrowserDictionaryLoader.loadArrayBuffer`: if the downloaded dictionary file does
not start with the gzip magic bytes (`1f 8b`), it is assumed the browser already
decompressed it and the buffer is used as-is. Chrome extensions sometimes serve
`.gz` files with `Content-Encoding: gzip`, which otherwise breaks loading.

## External services (not bundled)

- **Jisho.org API** — dictionary lookups (`https://jisho.org/api/v1/search/words`). Data from JMdict/EDRDG, CC BY-SA.
- **YouTube** — caption tracks are read from the page the user is already watching.
- **Anthropic / OpenAI-compatible APIs** — only when the user supplies their own API key.
