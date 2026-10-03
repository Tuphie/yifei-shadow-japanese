// Run with: npm install && npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Seg = require('../extension/segment.js');
const C = require('../extension/core.js');
const Jlpt = require('../extension/jlpt.js');

let tk = null;
test.before(() => new Promise((resolve) => {
  try {
    require('kuromoji').builder({ dicPath: path.join(__dirname, '../extension/dict') }).build((err, t) => { tk = t; resolve(); });
  } catch (e) { resolve(); }
}));

const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));

// Minimum boundary F1 per caption type. Raise these when segmentation improves; never lower them.
const FLOOR = { 'manual-punct': 0.95, manual: 0.85, asr: 0.8 };

for (const name of ['vlog', 'talk']) {
  for (const kind of Object.keys(FLOOR)) {
    test(`segmentation benchmark: ${name}.${kind} ≥ ${FLOOR[kind]}`, (t) => {
      if (!tk) return t.skip('run npm install first');
      const out = Seg.segment(Seg.unitsFromJson3(fx(`${name}.${kind}.json`)), tk);
      const r = Seg.boundaryF1Text(out, fx(`${name}.gold.json`));
      assert.ok(r.f1 >= FLOOR[kind], `F1 ${r.f1.toFixed(3)} (P ${r.precision.toFixed(2)} R ${r.recall.toFixed(2)})`);
    });
  }
}

test('ASR words get one timeline without rolling duplicates', () => {
  const json = { events: [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'こんにちは' }, { utf8: '今日は', tOffsetMs: 900 }] },
    { tStartMs: 1500, dDurationMs: 50, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'いい' }, { utf8: '天気', tOffsetMs: 300 }] },
    { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'いい' }] }, // duplicate window
  ] };
  const p = Seg.unitsFromJson3(json);
  assert.strictEqual(p.isAsr, true);
  assert.deepStrictEqual(p.units.map((u) => u.text), ['こんにちは', '今日は', 'いい', '天気']);
  assert.deepStrictEqual(p.units.map((u) => u.t), [0, 0.9, 1.5, 1.8]);
});

test('manual cues split at spaces and sentence punctuation', () => {
  const p = Seg.unitsFromJson3({ events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'はい　じゃあ行きましょう。次は駅です' }] }] });
  assert.deepStrictEqual(p.units.map((u) => u.text), ['はい', 'じゃあ行きましょう。', '次は駅です']);
  assert.strictEqual(p.units[1].sepBefore, 'space');
  assert.ok(Math.abs(p.units[2].end - 4) < 1e-9);
});

test('split and merge keep text and timing consistent', () => {
  const s = { start: 10, end: 14, text: 'おはようございます今日は晴れ', marks: [[0, 10], [9, 12]] };
  const [a, b] = Seg.splitSentence(s, 9);
  assert.strictEqual(a.text + b.text, s.text);
  assert.strictEqual(a.end, 12);
  assert.strictEqual(b.start, 12);
  const m = Seg.mergeSentences(a, b);
  assert.strictEqual(m.text, s.text);
  assert.strictEqual(m.start, 10);
  assert.strictEqual(m.end, 14);
  // split inside a unit interpolates time
  const [c] = Seg.splitSentence({ start: 0, end: 4, text: 'あいうえ', marks: [[0, 0]] }, 2);
  assert.strictEqual(c.end, 2);
});

test('AI punctuation is accepted only when the text is unchanged', () => {
  const text = 'こんにちは今日はいい天気ですね散歩しましょう';
  const ok = Seg.mapPunctuation(text, 'こんにちは。今日はいい天気ですね。散歩しましょう。');
  assert.deepStrictEqual([...ok], [5, 15, 22]);
  assert.strictEqual(Seg.mapPunctuation(text, 'こんにちは。今日はいい天気ですね。散歩しよう。'), null);
});

test('AI punctuation steers segmentation', (t) => {
  if (!tk) return t.skip('run npm install first');
  const json = { events: [{ tStartMs: 0, dDurationMs: 6000, segs: [{ utf8: 'これは' }, { utf8: '本', tOffsetMs: 600 }, { utf8: 'です', tOffsetMs: 900 }, { utf8: 'あれは', tOffsetMs: 1300 }, { utf8: 'ペン', tOffsetMs: 1900 }, { utf8: 'です', tOffsetMs: 2300 }] }] };
  const parsed = Seg.unitsFromJson3(json);
  const text = Seg.plainText(parsed, tk);
  const punct = Seg.mapPunctuation(text, 'これは本です。あれはペンです。');
  const out = Seg.segment(parsed, tk, { punct });
  assert.deepStrictEqual(out.map((x) => x.text), ['これは本です', 'あれはペンです']);
});

test('JLPT lookup picks the reading and the easiest written form', () => {
  const J = Jlpt.create(require('../extension/data/jlpt.json'));
  assert.strictEqual(J.lookup('一日', 'いちにち').level, 5);
  assert.strictEqual(J.lookup('一日', 'いちじつ').level, 1);
  assert.strictEqual(J.lookup('空く', 'すく', '動詞').level, 3);
  assert.strictEqual(J.lookup('美味しい', 'おいしい', '形容詞').level, 5);
  assert.strictEqual(J.lookup('いる', 'いる', '動詞').level, 5);
  assert.strictEqual(J.lookup('浅草', 'あさくさ').src, 'kanji');
});

test('video difficulty profile', (t) => {
  if (!tk) return t.skip('run npm install first');
  const J = Jlpt.create(require('../extension/data/jlpt.json'));
  const groups = fx('vlog.gold.json').map((x) => C.groupTokens(tk.tokenize(x.text)));
  const p = J.profile(groups);
  assert.ok(p.total > 100);
  assert.ok(p.estimate >= 2 && p.estimate <= 4, 'estimate N' + p.estimate);
  assert.ok(p.coverage[1] === 1);
});
