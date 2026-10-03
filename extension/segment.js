// Kage 影读 · sentence segmentation (pure; used by the side panel and by tests)
//
// Pipeline:
//   json3 caption events ──► units (words for ASR, punctuation-split cues for manual)
//   units + tokenizer   ──► score every boundary between units
//   dynamic programming ──► best overall segmentation for shadowing
(function (root) {
  const SEG_VERSION = 2;
  const CJK = '\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef';
  const SENT_END_CHAR = /[。！？!?♪]$/;
  const BRACKET_ONLY = /^[\[［(（【♪].*[\]］)）】♪]$/;
  const FINAL_AUX = new Set(['ます', 'です', 'た', 'だ', 'ない', 'ん', 'う', 'よう', 'まい', 'ぬ']);
  const CONJ_PARTICLE = new Set(['て', 'で', 'けど', 'けれど', 'けれども', 'から', 'ので', 'し', 'が', 'のに', 'ながら', 'たら', 'ば']);
  const OPENERS = /^(じゃあ|じゃ(?![なけ])|でも|それで|それから|そして|まず|さて|では|ちなみに|だから|なので|ところで|実は|えっと|えーと|それでは|ですから|だけど|けど(?=[、 ]))/;

  function clean(t) {
    return String(t || '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(new RegExp('([' + CJK + '])\\s+(?=[' + CJK + '])', 'g'), '$1')
      .replace(/​/g, '')
      .trim();
  }
  const join = (a, b) => (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? a + ' ' + b : a + b);

  // ---------- 1. units ----------
  // unit: { t, end, text, kind: 'word'|'cue', firstInEvent }
  function unitsFromJson3(json) {
    const events = ((json && json.events) || []).filter((e) => e.segs && e.segs.length);
    const isAsr = events.some((e) => e.segs.some((s) => s.tOffsetMs != null)) ||
      events.some((e) => e.aAppend);
    return isAsr ? asrUnits(events) : manualUnits(events);
  }

  function asrUnits(events) {
    const units = [];
    for (const e of events) {
      const base = (e.tStartMs || 0) / 1000;
      const evEnd = base + (e.dDurationMs || 0) / 1000;
      let first = true;
      for (const s of e.segs) {
        const text = clean(s.utf8);
        if (!text) continue;
        const t = base + (s.tOffsetMs || 0) / 1000;
        const last = units[units.length - 1];
        // rolling-window duplicates or out-of-order words
        if (last && (t < last.t - 0.05 || (Math.abs(t - last.t) < 0.02 && text === last.text))) continue;
        if (BRACKET_ONLY.test(text)) { if (last) last.hardBreak = true; continue; }
        units.push({ t, end: evEnd, text, kind: 'word', firstInEvent: first });
        first = false;
      }
    }
    for (let i = 0; i < units.length; i++) {
      const u = units[i], n = units[i + 1];
      const est = Math.max(0.25, u.text.length * 0.13);
      u.end = n ? Math.min(n.t, u.t + est) : Math.min(u.end, u.t + est + 0.6);
      if (u.end <= u.t) u.end = u.t + Math.min(0.2, n ? n.t - u.t : 0.2);
    }
    return { isAsr: true, units };
  }

  function manualUnits(events) {
    const cues = [];
    for (const e of events) {
      const raw = e.segs.map((s) => s.utf8 || '').join('').replace(/\u200b/g, '').trim();
      if (!raw) continue;
      const start = (e.tStartMs || 0) / 1000;
      cues.push({ start, end: start + (e.dDurationMs || 0) / 1000, raw });
    }
    cues.sort((a, b) => a.start - b.start);
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
      if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.3;
    }
    const units = [];
    for (const c of cues) {
      if (BRACKET_ONLY.test(c.raw)) { const l = units[units.length - 1]; if (l) l.hardBreak = true; continue; }
      // Inside a cue, a space between Japanese words usually separates sentences, a line break
      // sometimes does, and 。！？ always does. Each piece becomes its own unit; the cue's time
      // is shared out by character count.
      const pieces = [];
      c.raw.split(/(\n|[ 　]+)/).forEach((chunk) => {
        if (chunk === '\n') { pieces.sep = 'newline'; return; }
        if (/^[ 　]+$/.test(chunk)) { pieces.sep = 'space'; return; }
        const parts = chunk.match(/[^。！？!?]+[。！？!?」』]*|[。！？!?」』]+/g) || [];
        parts.forEach((p, k) => { pieces.push({ text: p.trim(), sep: k === 0 ? pieces.sep : null }); pieces.sep = null; });
      });
      const list = pieces.filter((p) => p.text);
      // ASCII words split by spaces ("YouTube channel") are not sentence breaks
      for (let k = 1; k < list.length; k++) {
        if (list[k].sep === 'space' && /[A-Za-z0-9]$/.test(list[k - 1].text) && /^[A-Za-z0-9]/.test(list[k].text)) {
          list[k - 1].text += ' ' + list[k].text; list.splice(k, 1); k--;
        }
      }
      const total = list.reduce((n, p) => n + p.text.length, 0) || 1;
      let t = c.start;
      list.forEach((p, k) => {
        const d = (c.end - c.start) * (p.text.length / total);
        units.push({ t, end: t + d, text: p.text, kind: 'cue', firstInEvent: k === 0, sepBefore: p.sep });
        t += d;
      });
    }
    return { isAsr: false, units };
  }

  // same entry point for imported .srt/.vtt cues
  function unitsFromCues(cues) {
    return manualUnits(cues.map((c) => ({ tStartMs: c.start * 1000, dDurationMs: (c.end - c.start) * 1000, segs: [{ utf8: c.text }] })));
  }

  // ---------- 2. boundary scores ----------
  function tokenIndex(text, tokenizer) {
    if (!tokenizer) return null;
    const toks = tokenizer.tokenize(text);
    const startAt = new Map(), endAt = new Map();
    let pos = 0;
    toks.forEach((t, i) => {
      const at = text.indexOf(t.surface_form, pos);
      const s = at >= 0 ? at : pos;
      t._s = s; t._e = s + t.surface_form.length; pos = t._e;
      startAt.set(t._s, i); endAt.set(t._e, i);
    });
    return { toks, startAt, endAt };
  }

  function boundaryScore(prevText, following, gap, ti, c, isAsr, firstInEvent, hardBreak, sepBefore) {
    let s = -2.5; // every boundary has a cost; signals must earn it
    const why = [];
    if (hardBreak) { s += 8; why.push('hard'); }
    if (SENT_END_CHAR.test(prevText)) { s += 6.5; why.push('。'); }
    else if (/[、,…]$/.test(prevText)) { s += 1.2; why.push('、'); }
    else if (/[」』]$/.test(prevText)) { s += 1.5; }
    const g = Math.max(0, Math.min(gap, 2));
    s += g * 4; if (g > 0.15) why.push('gap ' + gap.toFixed(2));
    if (isAsr && firstInEvent) s += 0.3;
    if (sepBefore === 'space') { s += 3.5; why.push('空格'); }
    else if (sepBefore === 'newline') { s += 0.8; }

    if (ti) {
      const prevI = ti.endAt.get(c), nextI = ti.startAt.get(c);
      if (prevI == null || nextI == null) { s -= 20; why.push('mid-word'); }
      else {
        const p = ti.toks[prevI], n = ti.toks[nextI];
        const pBase = p.basic_form, pPos = p.pos, pD1 = p.pos_detail_1;
        if (pPos === '助動詞' && FINAL_AUX.has(pBase) && (p.conjugated_form === '基本形' || p.conjugated_form === '*' || /^(です|ます|た|だ|ん)$/.test(p.surface_form))) { s += 3; why.push('終止'); }
        if (pPos === '助詞' && /終助詞/.test(pD1) && !(n.pos === '助詞' || n.pos === '助動詞')) { s += 3.2; why.push('終助詞'); }
        if (pPos === '動詞' && /^命令/.test(p.conjugated_form)) { s += 3; why.push('命令'); }
        if (pPos === '感動詞' || pPos === 'フィラー') { s += 1.5; }
        if (pPos === '助詞' && pD1 === '接続助詞' && CONJ_PARTICLE.has(p.surface_form)) { s += 1.3; why.push('接続'); }
        if (pPos === '動詞' && p.conjugated_form === '基本形' && n.pos !== '名詞' && n.pos !== '助詞' && n.pos !== '助動詞') { s += 1.5; why.push('動詞終止'); }
        if (pPos === '形容詞' && p.conjugated_form === '基本形' && n.pos !== '名詞' && n.pos !== '助詞' && n.pos !== '助動詞') { s += 1.2; }
        // things a Japanese sentence does not end with
        if (pPos === '助詞' && pD1 === '格助詞' && !/^(と|って)$/.test(p.surface_form)) { s -= 4; why.push('格助詞+'); }
        if (pPos === '助詞' && pD1 === '係助詞') { s -= 3; }
        if (pPos === '助詞' && pD1 === '連体化') { s -= 5; }
        if (pPos === '接頭詞' || pPos === '連体詞') { s -= 5; }
        if (pPos === '動詞' && p.conjugated_form === '連用形' && !(n.pos === '動詞' || n.pos === '助動詞')) { s -= 0.5; }
        // things a sentence does not start with
        const opener = OPENERS.test(following);
        if (!opener && (n.pos === '助詞' || n.pos === '助動詞')) { s -= 7; why.push('+助詞'); }
        if (!opener && (n.pos_detail_1 === '接尾' || n.pos_detail_1 === '非自立')) { s -= 5; why.push('+非自立'); }
        if (n.pos === '接続詞' || n.pos === '感動詞' || n.pos === 'フィラー') { s += 1.8; why.push('接続詞+'); }
      }
    }
    if (OPENERS.test(following)) { s += 2.0; why.push('开头词'); }
    return { s, why };
  }

  // ---------- 3. dynamic programming ----------
  function segPenalty(dur, chars) {
    let p = 0;
    if (dur < 1.0) p -= (1.0 - dur) * 4;
    if (dur > 6) p -= (dur - 6) * 1.0;
    if (dur > 10) p -= (dur - 10) * 3;
    if (chars > 40) p -= (chars - 40) * 0.15;
    if (chars < 4) p -= 1;
    return p;
  }

  // Split units at token boundaries so a sentence can end inside a caption line or an ASR chunk.
  // Time inside a unit is interpolated by character count; such inner boundaries get no gap signal.
  function refine(units, tokenizer) {
    if (!tokenizer) return units;
    const out = [];
    for (const u of units) {
      const toks = tokenizer.tokenize(u.text);
      if (toks.length <= 1) { out.push(u); continue; }
      const len = u.text.length || 1;
      let c = 0;
      // keep punctuation glued to the token before it
      const pieces = [];
      for (const t of toks) {
        if (pieces.length && (t.pos === '記号' || /^[。、！？!?」』…]+$/.test(t.surface_form))) pieces[pieces.length - 1] += t.surface_form;
        else pieces.push(t.surface_form);
      }
      pieces.forEach((txt, k) => {
        const t0 = u.t + (u.end - u.t) * (c / len);
        c += txt.length;
        const t1 = u.t + (u.end - u.t) * (c / len);
        out.push(Object.assign({}, u, { t: t0, end: k === pieces.length - 1 ? u.end : t1, text: txt, inner: k > 0,
          firstInEvent: k === 0 ? u.firstInEvent : false, sepBefore: k === 0 ? u.sepBefore : null,
          hardBreak: k === pieces.length - 1 ? u.hardBreak : false }));
      });
    }
    return out;
  }

  function segment(parsed, tokenizer, opts = {}) {
    const units = opts.refine === false ? parsed.units : refine(parsed.units, tokenizer);
    const n = units.length;
    if (!n) return [];
    const isAsr = parsed.isAsr;
    let text = '';
    const off = [];
    for (const u of units) { text = join(text, u.text); off.push(text.length - u.text.length); }
    const ends = units.map((u, i) => off[i] + u.text.length);
    const ti = opts.tokens === false ? null : tokenIndex(text, tokenizer);
    const punct = opts.punct || null; // Set of char offsets (in the joined text) where AI put a sentence end

    const bScore = new Array(n).fill(0);
    const bWhy = new Array(n).fill(null);
    for (let k = 0; k < n - 1; k++) {
      const gap = units[k + 1].t - units[k].end;
      let prevText = units[k].text;
      if (punct && punct.has(ends[k]) && !SENT_END_CHAR.test(prevText)) prevText += '。';
      const r = boundaryScore(prevText, text.slice(ends[k], ends[k] + 6), gap, ti, ends[k], isAsr, units[k + 1].firstInEvent, units[k].hardBreak, units[k + 1].sepBefore);
      if (units[k + 1].inner) r.s -= isAsr ? 0.6 : 0.2; // ASR chunk edges and caption line edges are mild evidence
      bScore[k] = r.s; bWhy[k] = r.why;
    }

    const MAX_SPAN = 20;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const back = new Int32Array(n + 1).fill(-1);
    best[0] = 0;
    for (let j = 1; j <= n; j++) {          // segment = units[i..j-1]
      for (let i = j - 1; i >= 0; i--) {
        const dur = units[j - 1].end - units[i].t;
        if (dur > MAX_SPAN && i < j - 1) break;
        const chars = ends[j - 1] - off[i];
        const v = best[i] + segPenalty(dur, chars) + (j < n ? bScore[j - 1] : 0);
        if (v > best[j]) { best[j] = v; back[j] = i; }
      }
    }
    const cuts = [];
    for (let j = n; j > 0; j = back[j]) cuts.push([back[j], j]);
    cuts.reverse();

    return cuts.map(([i, j], idx) => {
      const us = units.slice(i, j);
      let t = '';
      const marks = [];
      for (const u of us) { t = join(t, u.text); marks.push([t.length - u.text.length, +u.t.toFixed(3)]); }
      return {
        i: idx,
        start: +us[0].t.toFixed(3),
        end: +us[us.length - 1].end.toFixed(3),
        text: t,
        marks,                 // [charOffset, time] at every unit start → lets the user split anywhere
        u: [i, j],             // unit range (for AI punctuation mapping / debugging)
        why: j < n ? bWhy[j - 1] : ['end'],
      };
    }).filter((s) => !BRACKET_ONLY.test(s.text));
  }

  // ---------- manual edits ----------
  function timeAt(s, c) {
    const m = s.marks && s.marks.length ? s.marks : [[0, s.start]];
    let k = 0;
    while (k + 1 < m.length && m[k + 1][0] <= c) k++;
    const [c0, t0] = m[k];
    const [c1, t1] = m[k + 1] || [s.text.length, s.end];
    if (c === c0) return t0;
    return t0 + (t1 - t0) * ((c - c0) / Math.max(1, c1 - c0));
  }
  function splitSentence(s, c) {
    if (c <= 0 || c >= s.text.length) return null;
    const t = +timeAt(s, c).toFixed(3);
    const a = { start: s.start, end: t, text: s.text.slice(0, c), marks: (s.marks || []).filter((m) => m[0] < c) };
    const b = { start: t, end: s.end, text: s.text.slice(c), marks: (s.marks || []).filter((m) => m[0] >= c).map((m) => [m[0] - c, m[1]]) };
    if (!b.marks.length || b.marks[0][0] !== 0) b.marks.unshift([0, t]);
    return [a, b];
  }
  function mergeSentences(a, b) {
    const text = join(a.text, b.text);
    const shift = text.length - b.text.length;
    return { start: a.start, end: b.end, text, marks: (a.marks || []).concat((b.marks || []).map((m) => [m[0] + shift, m[1]])) };
  }
  function renumber(list) { return list.map((s, i) => Object.assign(s, { i })); }

  // ---------- AI punctuation mapping ----------
  const STRIP = /[。、？！?!，,.\s　]/g;
  // The text the model sees (same joining as segment()).
  function plainText(parsed, tokenizer) {
    const units = refine(parsed.units, tokenizer);
    let text = '';
    for (const u of units) text = join(text, u.text);
    return text;
  }
  // Map the model's punctuated text back to char offsets in `text` where a sentence ends.
  // Returns null if the model changed anything other than punctuation.
  function mapPunctuation(text, punctuated) {
    if (punctuated.replace(STRIP, '') !== text.replace(STRIP, '')) return null;
    // index: stripped-char count → offset in text just after that char
    const after = [0];
    for (let i = 0; i < text.length; i++) if (!/[。、？！?!，,.\s　]/.test(text[i])) after.push(i + 1);
    const out = new Set();
    let n = 0;
    for (const ch of punctuated) {
      if (/[。？！?!]/.test(ch)) { let o = after[n]; while (o < text.length && /[。、？！?!，,.\s　」』]/.test(text[o])) o++; out.add(o); }
      else if (!/[、，,.\s　]/.test(ch)) n++;
    }
    return out;
  }

  // ---------- evaluation helper ----------
  // boundaries are compared by time (seconds); a predicted boundary within `tol` of a gold one is a hit
  function boundaryF1(pred, gold, tol = 0.35) {
    const p = pred.slice(1).map((s) => s.start), g = gold.slice(1).map((s) => s.start);
    const used = new Set();
    let tp = 0;
    for (const x of p) {
      let bi = -1, bd = tol;
      g.forEach((y, i) => { const d = Math.abs(x - y); if (d <= bd && !used.has(i)) { bd = d; bi = i; } });
      if (bi >= 0) { used.add(bi); tp++; }
    }
    const prec = p.length ? tp / p.length : 1, rec = g.length ? tp / g.length : 1;
    return { precision: prec, recall: rec, f1: prec + rec ? (2 * prec * rec) / (prec + rec) : 0, pred: p.length, gold: g.length };
  }

  function boundaryF1Text(pred, gold) {
    const pos = (list) => { const out = []; let n = 0; list.forEach((x) => { n += x.text.replace(STRIP, '').length; out.push(n); }); out.pop(); return out; };
    const p = pos(pred), g = new Set(pos(gold));
    const tp = p.filter((x) => g.has(x)).length;
    const prec = p.length ? tp / p.length : 1, rec = g.size ? tp / g.size : 1;
    return { precision: prec, recall: rec, f1: prec + rec ? (2 * prec * rec) / (prec + rec) : 0 };
  }

  const api = { SEG_VERSION, plainText, boundaryF1Text, unitsFromJson3, unitsFromCues, segment, splitSentence, mergeSentences, renumber, timeAt, mapPunctuation, boundaryF1, _boundaryScore: boundaryScore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KageSeg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
