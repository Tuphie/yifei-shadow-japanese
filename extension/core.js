// Kage 影读 · pure helpers (shared by side panel and tests)
(function (root) {
  const SENT_END = /[。！？!?」』…♪～〜]$/;
  const CJK = '\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef';
  const BRACKET_ONLY = /^[\[［(（【♪].*[\]］)）】♪]$/;

  function cleanText(t) {
    return String(t || '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(new RegExp('([' + CJK + '])\\s+(?=[' + CJK + '])', 'g'), '$1')
      .replace(/​/g, '')
      .trim();
  }

  // YouTube json3 → [{start, end, text}] (seconds)
  function parseJson3(json) {
    const evs = ((json && json.events) || []).filter((e) => e.segs && e.segs.length);
    const cues = [];
    for (const e of evs) {
      const text = cleanText(e.segs.map((s) => s.utf8 || '').join(''));
      if (!text) continue;
      const start = (e.tStartMs || 0) / 1000;
      const end = start + (e.dDurationMs || 0) / 1000;
      cues.push({ start, end, text });
    }
    cues.sort((a, b) => a.start - b.start);
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
      if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.3;
    }
    return cues;
  }

  function toSec(ts) {
    const m = String(ts).trim().replace(',', '.').split(':').map(Number);
    return m.length === 3 ? m[0] * 3600 + m[1] * 60 + m[2] : m[0] * 60 + m[1];
  }
  // .srt / .vtt → cues
  function parseSubtitleFile(text) {
    const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/);
    const cues = [];
    for (const b of blocks) {
      const lines = b.split('\n').filter((l) => l.trim() !== '');
      const ti = lines.findIndex((l) => l.includes('-->'));
      if (ti < 0) continue;
      const [a, z] = lines[ti].split('-->');
      const body = cleanText(lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, ''));
      if (!body) continue;
      cues.push({ start: toSec(a), end: toSec(z.trim().split(/\s+/)[0]), text: body });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  // Merge caption cues into shadowable sentences.
  function buildSentences(cues, isAsr) {
    const src = cues.filter((c) => !BRACKET_ONLY.test(c.text));
    if (!src.length) return [];
    const punctRatio = src.filter((c) => SENT_END.test(c.text)).length / src.length;
    const out = [];
    let cur = null;
    const flush = () => { if (cur) out.push(cur); cur = null; };
    for (const c of src) {
      if (!cur) { cur = Object.assign({}, c); continue; }
      const gap = c.start - cur.end;
      const dur = cur.end - cur.start;
      let merge;
      if (isAsr) {
        merge = gap < 0.6 && dur < 2.5 && (c.end - cur.start) < 7 && (cur.text + c.text).length < 40;
      } else if (punctRatio >= 0.3) {
        merge = !SENT_END.test(cur.text) && gap < 0.8 && (c.end - cur.start) < 12 && (cur.text + c.text).length < 70;
      } else {
        merge = (dur < 1.2 || cur.text.length < 6) && gap < 0.3 && (c.end - cur.start) < 8;
      }
      if (merge) {
        cur.end = c.end;
        const joiner = /[A-Za-z0-9]$/.test(cur.text) && /^[A-Za-z0-9]/.test(c.text) ? ' ' : '';
        cur.text += joiner + c.text;
      } else { flush(); cur = Object.assign({}, c); }
    }
    flush();
    return out.map((s, i) => ({ i, start: +s.start.toFixed(3), end: +s.end.toFixed(3), text: s.text }));
  }

  function attachTranslation(sentences, zhCues) {
    if (!zhCues || !zhCues.length) return sentences;
    let j = 0;
    for (const s of sentences) {
      const parts = [];
      while (j < zhCues.length && (zhCues[j].start + zhCues[j].end) / 2 < s.start - 0.05) j++;
      let k = j;
      while (k < zhCues.length && (zhCues[k].start + zhCues[k].end) / 2 <= s.end + 0.05) { parts.push(zhCues[k].text); k++; }
      j = k;
      if (parts.length) s.zh = parts.join('');
    }
    return sentences;
  }

  // ---------- kana / furigana ----------
  const toHira = (s) => String(s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const hasKanji = (s) => /[㐀-鿿々]/.test(s);
  const isKana = (c) => /[ぁ-ゟ゠-ヿ]/.test(c);

  // "空いて" + "すいて" → [{base:'空', rt:'す'}, {base:'いて'}]
  function rubyParts(surface, reading) {
    if (!hasKanji(surface) || !reading) return [{ base: surface }];
    let s = surface, r = toHira(reading), pre = '', suf = '';
    while (s.length > 1 && isKana(s[s.length - 1]) && toHira(s[s.length - 1]) === r[r.length - 1]) {
      suf = s[s.length - 1] + suf; s = s.slice(0, -1); r = r.slice(0, -1);
    }
    while (s.length > 1 && isKana(s[0]) && toHira(s[0]) === r[0]) {
      pre += s[0]; s = s.slice(1); r = r.slice(1);
    }
    const parts = [];
    if (pre) parts.push({ base: pre });
    parts.push(r ? { base: s, rt: r } : { base: s });
    if (suf) parts.push({ base: suf });
    return parts;
  }

  // Group kuromoji tokens into learner-friendly words: 空い+て+い+ます → 空いています
  function groupTokens(tokens) {
    const groups = [];
    for (const t of tokens) {
      const g = groups[groups.length - 1];
      const head = g && g.tokens[0];
      const prevPos = g && g.tokens[g.tokens.length - 1].pos;
      const attach = g && head.pos !== '記号' && (
        (t.pos === '助動詞' && ['動詞', '形容詞', '助動詞', '名詞'].includes(head.pos) && !(head.pos === '名詞' && ['です', 'だ'].includes(t.basic_form))) ||
        (t.pos === '助詞' && t.pos_detail_1 === '接続助詞' && ['て', 'で'].includes(t.surface_form) && ['動詞', '形容詞'].includes(head.pos)) ||
        (t.pos === '動詞' && t.pos_detail_1 === '非自立' && ['動詞', '形容詞'].includes(head.pos)) ||
        (t.pos_detail_1 === '接尾' && ['名詞', '動詞', '形容詞'].includes(head.pos) && prevPos !== '記号')
      );
      if (attach) { g.tokens.push(t); g.surface += t.surface_form; }
      else groups.push({ tokens: [t], surface: t.surface_form });
    }
    return groups.map((g) => {
      const head = g.tokens[0];
      return {
        surface: g.surface,
        base: head.basic_form && head.basic_form !== '*' ? head.basic_form : head.surface_form,
        reading: g.tokens.map((t) => toHira(t.reading && t.reading !== '*' ? t.reading : t.surface_form)).join(''),
        headReading: toHira(head.reading && head.reading !== '*' ? head.reading : head.surface_form),
        pos: head.pos,
        posDetail: head.pos_detail_1,
        tokens: g.tokens,
        isPunct: head.pos === '記号' || /^[\s、。！？!?「」『』（）()・…,.]+$/.test(g.surface),
      };
    });
  }

  function tokenRomaji(t, wanakana) {
    if (t.pos === '記号') return '';
    if (t.pos === '助詞') {
      if (t.surface_form === 'は') return 'wa';
      if (t.surface_form === 'へ') return 'e';
      if (t.surface_form === 'を') return 'o';
    }
    const r = toHira(t.reading && t.reading !== '*' ? t.reading : t.surface_form);
    return /[ぁ-ゟー]/.test(r) ? wanakana.toRomaji(r) : r;
  }

  const POS_ZH = {
    名詞: '名词', 動詞: '动词', 形容詞: '形容词', 副詞: '副词', 助詞: '助词', 助動詞: '助动词',
    連体詞: '连体词', 接続詞: '接续词', 感動詞: '感叹词', 接頭詞: '接头词', 記号: '符号', フィラー: '填充词',
  };

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  const api = { parseJson3, parseSubtitleFile, buildSentences, attachTranslation, toHira, hasKanji, rubyParts, groupTokens, tokenRomaji, POS_ZH, csvEscape, fmtTime, cleanText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KageCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
