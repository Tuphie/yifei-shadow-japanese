// Run with: npm install && npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const C = require('../extension/core.js');

const j3 = (rows) => ({ events: rows.map(([s, d, t]) => ({ tStartMs: s * 1000, dDurationMs: d * 1000, segs: [{ utf8: t }] })) });

test('manual captions merge into sentences and drop [music]', () => {
  const cues = C.parseJson3(j3([
    [0, 2.5, '皆さん、こんにちは。'], [2.6, 2, '今日は東京で'], [4.6, 2.4, '一日を過ごしてみました。'],
    [7.2, 1, '[音楽]'], [8.4, 3, '私は今、おなかが\nすごくすいています。'],
  ]));
  const s = C.buildSentences(cues, false);
  assert.deepStrictEqual(s.map((x) => x.text), ['皆さん、こんにちは。', '今日は東京で一日を過ごしてみました。', '私は今、おなかがすごくすいています。']);
  assert.strictEqual(s[1].start, 2.6);
  assert.strictEqual(s[1].end, 7);
});

test('translation cues attach by timing', () => {
  const s = C.buildSentences(C.parseJson3(j3([[0, 2, 'こんにちは。'], [2.2, 2, '元気'], [4.2, 2, 'ですか。']])), false);
  C.attachTranslation(s, C.parseJson3(j3([[0, 2, '你好。'], [2.2, 4, '你好吗？']])));
  assert.deepStrictEqual(s.map((x) => x.zh), ['你好。', '你好吗？']);
});

test('srt / vtt parsing', () => {
  const cues = C.parseSubtitleFile('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nこんにちは\n\n2\n00:00:04,000 --> 00:00:06,000\n<c>元気</c>ですか');
  assert.deepStrictEqual(cues, [{ start: 1, end: 3.5, text: 'こんにちは' }, { start: 4, end: 6, text: '元気ですか' }]);
});

test('furigana only covers the kanji part', () => {
  assert.deepStrictEqual(C.rubyParts('空いて', 'スイテ'), [{ base: '空', rt: 'す' }, { base: 'いて' }]);
  assert.deepStrictEqual(C.rubyParts('お腹', 'オナカ'), [{ base: 'お' }, { base: '腹', rt: 'なか' }]);
  assert.deepStrictEqual(C.rubyParts('こんにちは', 'コンニチハ'), [{ base: 'こんにちは' }]);
});

test('tokens group into learner-friendly words', (t, done) => {
  let kuromoji, wanakana;
  try { kuromoji = require('kuromoji'); wanakana = require('wanakana'); } catch (e) { t.skip('run npm install first'); return done(); }
  kuromoji.builder({ dicPath: path.join(__dirname, '../extension/dict') }).build((err, tk) => {
    assert.ifError(err);
    const g = C.groupTokens(tk.tokenize('私は今、おなかがすごくすいています。'));
    assert.deepStrictEqual(g.filter((w) => !w.isPunct).map((w) => w.surface), ['私', 'は', '今', 'おなか', 'が', 'すごく', 'すいています']);
    const v = g.find((w) => w.surface === 'すいています');
    assert.strictEqual(v.base, 'すく');
    assert.strictEqual(v.tokens.map((x) => C.tokenRomaji(x, wanakana)).join(''), 'suiteimasu');
    done();
  });
});
