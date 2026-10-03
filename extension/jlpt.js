// Kage 影读 · JLPT level lookup (pure; data/jlpt.json is loaded by the caller)
// Levels are numbers: 5 = N5 (easiest) … 1 = N1 (hardest).
(function (root) {
  const toHira = (s) => String(s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const hasKanji = (s) => /[㐀-鿿々]/.test(s);
  const SKIP_POS = new Set(['助詞', '助動詞', '記号', 'フィラー', 'その他', '接頭詞', '感動詞', '連体詞']);

  function create(data) {
    const vocab = new Map();   // word → [[reading, level]]
    const byReading = new Map(); // kana-only entries: reading → level
    const kanjiByReading = new Map(); // kanji entries: reading → easiest level (居る → いる)
    for (const [w, packed] of Object.entries(data.v || {})) {
      const list = packed.split(';').map((x) => { const i = x.lastIndexOf(':'); return [x.slice(0, i), Number(x.slice(i + 1))]; });
      vocab.set(w, list);
      if (!hasKanji(w)) {
        const r = toHira(w);
        byReading.set(r, Math.max(byReading.get(r) || 0, ...list.map((x) => x[1])));
      } else {
        for (const [r, lv] of list) if (r) kanjiByReading.set(r, Math.max(kanjiByReading.get(r) || 0, lv));
      }
    }
    const kanji = new Map();
    const k = data.k || '';
    for (let i = 0; i + 1 < k.length; i += 2) kanji.set(k[i], Number(k[i + 1]));

    // → { level, src: 'list' | 'kanji' } or null
    function lookup(base, reading, pos) {
      const r = toHira(reading);
      let best = 0;
      const entries = vocab.get(base);
      const inflecting = pos === '形容詞' || pos === '副詞';
      if (entries) {
        const exact = entries.filter(([er]) => !er || er === r);
        best = Math.max(...(exact.length ? exact : entries).map((x) => x[1]));
        // an adjective is as easy as its easiest written form: 美味しい → おいしい (N5)
        if (inflecting && r && byReading.has(r)) best = Math.max(best, byReading.get(r));
      } else if (!hasKanji(base)) {
        const h = toHira(base);
        best = byReading.get(h) || 0;
        // verbs / adjectives written in kana: いる → 居る, なくなる → 無くなる
        if (!best && (pos === '動詞' || pos === '形容詞') && kanjiByReading.has(h)) best = kanjiByReading.get(h);
      } else {
        const hira = byReading.get(r);
        // kanji spelling of a kana entry (凄い → すごい) only when the reading is long enough to be unambiguous
        if (hira && r.length >= 3) best = hira;
      }
      if (best) return { level: best, src: 'list' };
      // estimate from the hardest kanji in the word
      if (hasKanji(base)) {
        let lv = 6;
        for (const ch of base) if (hasKanji(ch)) lv = Math.min(lv, kanji.get(ch) || 0);
        if (lv > 0 && lv < 6) return { level: lv, src: 'kanji' };
      }
      return null;
    }

    // word = a grouped word from KageCore.groupTokens
    function forWord(w) {
      if (!w || w.isPunct) return null;
      const head = w.tokens[0];
      if (SKIP_POS.has(head.pos)) return null;
      if (head.pos === '名詞' && /固有名詞|数|代名詞/.test(head.pos_detail_1 + head.pos_detail_2)) return null;
      if (head.pos === '名詞' && head.pos_detail_1 === '非自立') return null;
      if (/^[\d０-９.,]+$/.test(head.surface_form) || /^[A-Za-zＡ-Ｚａ-ｚ]+$/.test(head.surface_form)) return null;
      const base = head.basic_form && head.basic_form !== '*' ? head.basic_form : head.surface_form;
      const reading = head.reading && head.reading !== '*' ? head.reading : head.surface_form;
      if (head.pos === '動詞' && head.pos_detail_1 === '非自立') return null;
      const res = lookup(base, toHira(reading), head.pos);
      if (res) return res;
      if (/^[\u30a0-\u30ffー]+$/.test(base)) return null; // loanwords outside the list: not counted
      return { level: 0, src: 'none' }; // 0 = 级外 (not in any list)
    }

    // distribution over content words of a list of grouped-word arrays
    function profile(groupLists) {
      const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };
      let total = 0;
      for (const groups of groupLists) for (const w of groups) {
        const r = forWord(w);
        if (!r) continue;
        counts[r.level]++; total++;
      }
      // estimated level: the easiest level whose cumulative vocabulary covers ≥ 90 % of the
      // words that have a level (words outside every list are shown but not counted)
      const ranked = total - counts[0];
      let est = 1, cum = 0;
      const coverage = {};
      for (const lv of [5, 4, 3, 2, 1]) { cum += counts[lv]; coverage[lv] = ranked ? cum / ranked : 0; }
      for (const lv of [5, 4, 3, 2, 1]) if (coverage[lv] >= 0.9) { est = lv; break; }
      return { counts, total, ranked, estimate: ranked >= 10 ? est : null, coverage };
    }

    return { lookup, forWord, profile, size: vocab.size };
  }

  const api = { create, toHira };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KageJlpt = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
