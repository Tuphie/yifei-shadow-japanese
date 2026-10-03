// Generates synthetic caption fixtures that mimic YouTube's json3 formats.
// Real captions collected via the in-panel "导出断句数据" button go in tests/fixtures/real/.
// Run: node tests/make-fixtures.js
const fs = require('fs');
const path = require('path');
const kuromoji = require('kuromoji');

const SCRIPTS = {
  vlog: [
    'みなさん、こんにちは。', '今日は東京で一日を過ごしてみたいと思います。', 'まずは朝ごはんを食べに行きましょう。',
    'ここは駅の近くにある小さなカフェです。', '実はこのお店、前から来てみたかったんですよね。', 'わあ、すごくいい匂いがします。',
    'じゃあ、注文してみますね。', 'すみません、このモーニングセットをください。', '飲み物はホットコーヒーでお願いします。',
    'パンがふわふわで、めちゃくちゃ美味しいです。', 'このジャム、手作りなんだって。', '次は電車に乗って浅草に向かいます。',
    '日曜日だから、人が多いですね。', '浅草に着きました。', 'やっぱり外国人の観光客がたくさんいますね。',
    'あの、雷門の前で写真を撮ってもいいですか。', 'ありがとうございます。', 'では、仲見世通りを歩いてみましょう。',
    'お土産屋さんがずらっと並んでいて、見ているだけで楽しいです。', '人形焼きを買ってみました。', '中にあんこが入っていて、甘くて美味しい。',
    'お昼はもんじゃ焼きを食べようと思っていたんですが、すごく並んでいたので諦めました。', 'その代わりに、近くのラーメン屋さんに入りました。',
    'スープがあっさりしていて、私はこういうラーメンが好きです。', '午後は少し疲れたので、公園で休憩します。', '今日は天気がよくて気持ちいいですね。',
    '最近、仕事が忙しくて、なかなか出かけられなかったんです。', 'だから、こういう一日は本当に大切だなと思います。',
    'さて、そろそろ夕方になってきました。', '最後に、東京タワーを見に行きたいと思います。', 'うわ、きれい。',
    '夜の東京タワーは何回見ても感動しますね。', '今日の動画はいかがでしたか。', 'もしよかったら、チャンネル登録をお願いします。',
    'それでは、また次の動画で会いましょう。', 'バイバイ。',
  ],
  talk: [
    'えっと、今日はですね、日本の会社の働き方について話したいと思います。', '日本では、残業が多いってよく言われますよね。',
    'でも、最近はちょっと変わってきているんです。', '例えば、リモートワークをする人が増えました。', '私の友達も、週に二回は家で仕事をしているそうです。',
    'それで、通勤の時間がなくなって、すごく楽になったって言ってました。', 'ただ、問題もあって。', '家だと、仕事とプライベートの区別がつきにくいんですよ。',
    '気がついたら、夜の十時まで働いていたとか。', 'そういう話もよく聞きます。', 'あと、会議が増えたっていう人もいますね。',
    'みなさんの国ではどうですか。', 'コメントで教えてくれたら嬉しいです。', 'じゃあ、次のテーマに行きましょうか。',
  ],
};

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const between = (a, b) => a + (b - a) * rnd();

function bunsetsu(tokens) {
  const out = [];
  for (const t of tokens) {
    const attach = out.length && (['助詞', '助動詞', '記号'].includes(t.pos) || t.pos_detail_1 === '非自立' || t.pos_detail_1 === '接尾');
    if (attach) out[out.length - 1].push(t); else out.push([t]);
  }
  return out;
}

function build(name, lines, tk) {
  const gold = [];          // [{start,text}]
  const words = [];         // ASR words {t, text}
  const cues = [];          // manual cue pieces {t,end,text,punctText}
  let t = 1.0;
  for (const line of lines) {
    const bs = bunsetsu(tk.tokenize(line));
    gold.push({ start: +t.toFixed(3), text: line });
    bs.forEach((b, bi) => {
      const surf = b.map((x) => x.surface_form).join('');
      const plain = surf.replace(/[。、！？]/g, '');
      // ASR chunks: sometimes whole bunsetsu, sometimes split into morphemes
      const chunks = rnd() < 0.5 ? [plain] : b.map((x) => x.surface_form.replace(/[。、！？]/g, '')).filter(Boolean);
      for (const c of chunks) { if (!c) continue; words.push({ t: +t.toFixed(3), text: c }); t += c.length * between(0.1, 0.15); }
      cues.push({ t: 0, text: plain, punctText: surf });
      cues[cues.length - 1].t = +(t - plain.length * 0.125).toFixed(3); cues[cues.length - 1].end = +t.toFixed(3);
      if (/、$/.test(surf)) t += between(0.12, 0.35);
      else if (bi < bs.length - 1 && rnd() < 0.1) t += between(0.3, 0.6); // hesitation
    });
    t += rnd() < 0.4 ? between(0.03, 0.2) : between(0.3, 1.0);   // gap between sentences
    cues[cues.length - 1].sentEnd = true;
  }

  // ---- ASR json3: rolling windows of 6–14 words, ignoring sentence boundaries
  const asr = { wireMagic: 'pb3', events: [{ tStartMs: 0, dDurationMs: Math.round(t * 1000), id: 1, wpWinPosId: 1, wsWinStyleId: 1 }] };
  for (let i = 0; i < words.length;) {
    const n = Math.floor(between(6, 15));
    const ws = words.slice(i, i + n);
    const start = Math.round(ws[0].t * 1000);
    const next = words[i + n] ? Math.round(words[i + n].t * 1000) : Math.round(t * 1000);
    if (i > 0) asr.events.push({ tStartMs: start, dDurationMs: 50, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] });
    asr.events.push({ tStartMs: start, dDurationMs: next - start + 1500, wWinId: 1, segs: ws.map((w, k) => (k === 0 ? { utf8: w.text, acAsrConf: 0 } : { utf8: w.text, tOffsetMs: Math.round(w.t * 1000) - start, acAsrConf: 0 })) });
    i += n;
  }

  // ---- manual json3: lines of ≤16 chars broken at bunsetsu boundaries
  function manual(withPunct) {
    const ev = [];
    let cur = null;
    const flush = () => { if (cur) ev.push({ tStartMs: Math.round(cur.t * 1000), dDurationMs: Math.round((cur.end - cur.t + 0.25) * 1000), segs: [{ utf8: cur.text }] }); cur = null; };
    for (const c of cues) {
      const piece = withPunct ? c.punctText : c.text;
      if (cur && (cur.text + piece).length > 16) flush();
      if (!cur) cur = { t: c.t, end: c.end, text: '' };
      cur.text += (cur.text && !withPunct && cur.sentEndPrev ? '　' : '') + piece;
      cur.end = c.end; cur.sentEndPrev = c.sentEnd;
      if (withPunct && c.sentEnd && rnd() < 0.3) flush();
    }
    flush();
    return { wireMagic: 'pb3', events: ev };
  }

  const dir = path.join(__dirname, 'fixtures');
  fs.writeFileSync(path.join(dir, `${name}.asr.json`), JSON.stringify(asr));
  fs.writeFileSync(path.join(dir, `${name}.manual.json`), JSON.stringify(manual(false)));
  fs.writeFileSync(path.join(dir, `${name}.manual-punct.json`), JSON.stringify(manual(true)));
  fs.writeFileSync(path.join(dir, `${name}.gold.json`), JSON.stringify(gold, null, 1));
}

kuromoji.builder({ dicPath: path.join(__dirname, '../extension/dict') }).build((err, tk) => {
  if (err) throw err;
  for (const [name, lines] of Object.entries(SCRIPTS)) build(name, lines, tk);
  console.log('fixtures written');
});
