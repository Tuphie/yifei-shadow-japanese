// Kage 影读 · side panel
const C = window.KageCore;
const Seg = window.KageSeg;
let J = null; // JLPT lookup, loaded from data/jlpt.json
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULTS = {
  autoPause: true, loop: false, gapFactor: 1.2, rate: 1,
  furi: true, roma: false, transMode: 'blur', follow: true, recMax: 0,
  provider: 'anthropic', apiKey: '', model: '', baseUrl: '',
  myLevel: 4, showLevel: true, // mark words harder than N{myLevel}; 0 = mark nothing
};
const S = {
  settings: Object.assign({}, DEFAULTS),
  tabId: null, videoId: null, title: '', track: null,
  sentences: [], words: [], wordKeys: new Set(),
  active: -1, paused: true, phase: 'play', gapTotal: 0,
  tokenizer: null, rec: null, recordings: {}, pendingCompare: -1,
  userScrollAt: 0, loading: false,
  data: null, editing: false, profile: null,
};
const LV = (n) => (n ? 'N' + n : '级外');

// ---------- storage ----------
const store = {
  get: (k) => chrome.storage.local.get(k).then((r) => r[k]),
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
};
async function saveSettings() { await store.set('settings', S.settings); }

// ---------- tokenizer ----------
const jlptReady = fetch('data/jlpt.json').then((r) => r.json()).then((d) => { J = KageJlpt.create(d); }).catch((e) => console.error('jlpt', e));
const tokenizerReady = new Promise((resolve) => {
  kuromoji.builder({ dicPath: 'dict/' }).build((err, tk) => {
    if (err) { console.error('kuromoji', err); resolve(null); return; }
    S.tokenizer = tk; resolve(tk);
  });
});

// ---------- talking to the YouTube tab ----------
function cmd(kageCmd, extra = {}) {
  if (S.tabId == null) return Promise.resolve(null);
  return chrome.tabs.sendMessage(S.tabId, Object.assign({ kageCmd }, extra)).catch(() => null);
}
function pushSettings() {
  return cmd('setSettings', { settings: { autoPause: S.settings.autoPause, loop: S.settings.loop, gapFactor: S.settings.gapFactor } });
}

function setStatus(html) {
  const el = $('#status');
  if (!html) { el.classList.add('hidden'); return; }
  el.innerHTML = html; el.classList.remove('hidden');
}

async function connect() {
  // ?tabId=123 lets automated tests open the panel as a normal page bound to a given tab
  const debugTab = Number(new URLSearchParams(location.search).get('tabId'));
  const [tab] = debugTab ? [await chrome.tabs.get(debugTab)] : await chrome.tabs.query({ active: true, currentWindow: true });
  const isWatch = tab && /^https:\/\/www\.youtube\.com\/watch/.test(tab.url || '');
  if (!isWatch) {
    S.tabId = tab ? tab.id : null;
    $('#videoTitle').textContent = '打开一个 YouTube 视频开始跟读';
    $('#videoMeta').textContent = '';
    $('#controls').classList.add('hidden');
    $('#list').innerHTML = '';
    setStatus('在当前窗口打开任意 youtube.com/watch 视频页面，侧边栏会自动载入字幕。');
    S.videoId = null;
    return;
  }
  S.tabId = tab.id;
  const vid = new URL(tab.url).searchParams.get('v');
  const pong = await cmd('ping');
  if (!pong) {
    $('#videoTitle').textContent = (tab.title || '').replace(/ - YouTube$/, '');
    setStatus('插件刚安装或更新过，需要<b>刷新一下这个 YouTube 页面</b>。<br><button class="chip" id="btnReload">刷新页面</button>');
    $('#btnReload').onclick = () => { chrome.tabs.reload(S.tabId); setTimeout(connect, 2500); };
    return;
  }
  if (vid !== S.videoId) await loadVideo(vid, (tab.title || '').replace(/ - YouTube$/, ''));
  else { await pushSentences(); await pushSettings(); }
}

// Keep only what segmentation needs from YouTube's json3 (drops confidence scores, styles…)
function compactJson3(j) {
  if (!j || !j.events) return null;
  return { events: j.events.filter((e) => e.segs).map((e) => {
    const o = { tStartMs: e.tStartMs || 0, dDurationMs: e.dDurationMs || 0, segs: e.segs.map((x) => (x.tOffsetMs != null ? { utf8: x.utf8, tOffsetMs: x.tOffsetMs } : { utf8: x.utf8 })) };
    if (e.aAppend) o.aAppend = 1;
    return o;
  }) };
}

// raw captions (+ optional AI punctuation) → sentences
function segmentData(data) {
  const parsed = data.raw.cues ? Seg.unitsFromCues(data.raw.cues) : Seg.unitsFromJson3(data.raw.ja);
  const punct = data.aiPunct ? new Set(data.aiPunct) : null;
  const sentences = Seg.segment(parsed, S.tokenizer, { punct });
  return sentences.map((x) => ({ i: x.i, start: x.start, end: x.end, text: x.text, marks: x.marks, why: x.why }));
}
function attachZh(sentences, data) {
  sentences.forEach((x) => { delete x.zh; });
  if (data.raw && data.raw.zh) C.attachTranslation(sentences, C.parseJson3(data.raw.zh));
  return sentences;
}

async function loadVideo(vid, titleHint, force = false) {
  if (S.loading) return;
  S.loading = true;
  S.videoId = vid; S.sentences = []; S.active = -1; S.recordings = {}; S.data = null; setEditing(false);
  $('#list').innerHTML = '';
  $('#videoTitle').textContent = titleHint || vid;
  $('#videoMeta').textContent = '';
  $('#diff').classList.add('hidden');
  $('#controls').classList.add('hidden');
  setStatus('正在读取日语字幕…');
  try {
    let data = force ? null : await store.get('tr2:' + vid);
    if (!data || !data.raw) {
      const r = await cmd('getTranscript');
      if (!r) { setStatus('无法和页面通信，请刷新 YouTube 页面后重试。'); return; }
      if (r.error) { showTranscriptError(r); return; }
      data = { videoId: vid, title: r.title, track: r.track, raw: { ja: compactJson3(r.ja), zh: compactJson3(r.zh) }, savedAt: Date.now() };
    }
    if (S.videoId !== vid) return;
    await applyTranscript(data);
  } finally { S.loading = false; }
}

function showTranscriptError(r) {
  const msgs = {
    noJa: '这个视频<b>没有日语字幕轨</b>（人工和自动都没有）。' + (r.tracks && r.tracks.length ? '<br><span class="muted">现有字幕：' + r.tracks.map((t) => esc(t.name)).join('、') + '</span>' : ''),
    fetchFailed: '找到了日语字幕，但没能下载下来。<br>试试先在播放器里手动打开一次字幕（CC），再点重试。',
    noPlayer: '播放器还没准备好，稍等几秒再试。',
    timeout: '读取超时，请重试。',
  };
  if (r.title) $('#videoTitle').textContent = r.title;
  setStatus((msgs[r.error] || ('读取失败：' + esc(r.error) + ' ' + esc(r.message || ''))) +
    '<br><button class="chip" id="btnRetry">重试</button> <button class="chip" id="btnImport">导入字幕文件</button>');
  $('#btnRetry').onclick = () => loadVideo(S.videoId, r.title, true);
  $('#btnImport').onclick = () => $('#fileSub').click();
}

async function applyTranscript(data) {
  S.data = data; S.title = data.title; S.track = data.track;
  $('#videoTitle').textContent = data.title;
  setStatus(S.tokenizer ? '正在断句…' : '正在加载日语词典（首次约需几秒）…');
  await tokenizerReady; await jlptReady;
  if (!S.tokenizer) { setStatus('<span class="err">日语词典加载失败，注音、查词和智能断句不可用。</span>'); }
  // re-segment when the algorithm changed, unless the user edited this video by hand
  if (!data.edited && (data.segVersion !== Seg.SEG_VERSION || !data.sentences)) {
    const zhAi = new Map((data.sentences || []).filter((x) => x.zhAi).map((x) => [x.text, x.zhAi]));
    data.sentences = attachZh(segmentData(data), data);
    data.sentences.forEach((x) => { if (zhAi.has(x.text)) x.zhAi = zhAi.get(x.text); });
    data.segVersion = Seg.SEG_VERSION;
  }
  S.sentences = data.sentences;
  if (S.sentences.length) await saveTranscript();
  renderMeta();
  if (!S.sentences.length) { setStatus('字幕是空的。'); return; }
  setStatus(S.tokenizer ? '' : '<span class="err">日语词典加载失败，注音、查词和智能断句不可用。</span>');
  $('#controls').classList.remove('hidden');
  renderList();
  renderDifficulty();
  await pushSentences();
  await pushSettings();
  if (S.settings.rate !== 1) cmd('setRate', { rate: S.settings.rate });
}

function renderMeta() {
  const data = S.data; if (!data) return;
  const kind = data.track ? (data.track.kind === 'asr' ? '自动生成字幕' : data.track.kind === 'import' ? '导入字幕' : '人工字幕') : '';
  const hasZh = S.sentences.some((x) => x.zh || x.zhAi);
  const tags = [`${S.sentences.length} 句`, kind];
  if (hasZh) tags.push('含中文翻译');
  if (data.aiPunct) tags.push('AI 已优化断句');
  if (data.edited) tags.push('已手动调整');
  $('#videoMeta').textContent = tags.join(' · ');
  $('#btnAiTrans').classList.toggle('hidden', S.sentences.every((x) => x.zh || x.zhAi));
}

function pushSentences() {
  return cmd('setSentences', { videoId: S.videoId, sentences: S.sentences.map((s) => ({ start: s.start, end: s.end })) });
}

// ---------- rendering ----------
function wordKey(w) { return w.base + '|' + (w.headReading || ''); }
function lookupKey(w) { return ['動詞', '形容詞', '助動詞'].includes(w.pos) ? w.base : w.surface; }

function renderSentenceJa(s) {
  if (!S.tokenizer) return `<div class="ja">${esc(s.text)}</div>`;
  if (!s._groups) s._groups = C.groupTokens(S.tokenizer.tokenize(s.text));
  return '<div class="ja">' + s._groups.map((w, wi) => {
    const ruby = w.tokens.map((t) => C.rubyParts(t.surface_form, t.reading).map((p) =>
      p.rt ? `<ruby>${esc(p.base)}<rt>${esc(p.rt)}</rt></ruby>` : `<ruby>${esc(p.base)}<rt>&nbsp;</rt></ruby>`).join('')).join('');
    const ro = w.tokens.map((t) => C.tokenRomaji(t, wanakana)).join('');
    const saved = !w.isPunct && S.wordKeys.has(wordKey(w)) ? ' saved' : '';
    const lv = J && !w.isPunct ? J.forWord(w) : null;
    const lvCls = lv && lv.level && lv.level < S.settings.myLevel ? ` hard h${lv.level}` : '';
    const tip = lv ? ` title="${lv.level ? (lv.src === 'kanji' ? '≈' : '') + 'N' + lv.level : '级外'}"` : '';
    return `<span class="w${w.isPunct ? ' punct' : ''}${saved}${lvCls}" data-w="${wi}"${tip}><span class="jt">${ruby}</span><span class="ro">${esc(ro) || '&nbsp;'}</span></span>`;
  }).join('') + '</div>';
}

function cardHtml(s) {
  return `<div class="card" id="c${s.i}" data-i="${s.i}">
    <div class="meta"><span class="t" data-act="seek">${C.fmtTime(s.start)}</span><span>#${s.i + 1}</span></div>
    ${renderSentenceJa(s)}
    <div class="zh">${s.zhAi || s.zh ? esc(s.zhAi || s.zh) : '<span class="muted">—</span>'}</div>
    <div class="edit-acts">${s.i > 0 ? '<button data-act="merge" title="把这句接到上一句后面">⤒ 合并到上一句</button>' : ''}</div>
    <div class="acts">
      <button data-act="seek" title="从这句开始播放">▶ 本句</button>
      <button data-act="rec" title="录下你的跟读 · M">🎙 录音</button>
      <button data-act="mine" ${S.recordings[s.i] ? 'class="has"' : 'disabled'} title="播放我的录音">我的</button>
      <button data-act="cmp" ${S.recordings[s.i] ? '' : 'disabled'} title="原声 → 我的 · C">⇄ 对比</button>
      <button data-act="bd" title="AI 拆解语法和句型">🧩 拆解</button>
    </div>
    <div class="bd hidden"></div>
  </div>`;
}

function renderList() {
  $('#list').innerHTML = S.sentences.map(cardHtml).join('');
  if (S.active >= 0) markActive(S.active, false);
}
function refreshCard(i) {
  const el = $('#c' + i); if (!el) return;
  const bd = $('.bd', el); const keep = bd && !bd.classList.contains('hidden') ? bd.innerHTML : null;
  el.outerHTML = cardHtml(S.sentences[i]);
  if (keep) { const nb = $('#c' + i + ' .bd'); nb.innerHTML = keep; nb.classList.remove('hidden'); }
  if (i === S.active) $('#c' + i).classList.add('active');
}

function markActive(i, scroll = true) {
  if (S.active >= 0) { const o = $('#c' + S.active); if (o) o.classList.remove('active'); }
  S.active = i;
  const el = $('#c' + i);
  if (!el) return;
  el.classList.add('active');
  if (scroll && S.settings.follow && Date.now() - S.userScrollAt > 2500) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function applyDisplay() {
  const st = S.settings;
  document.body.classList.toggle('no-furi', !st.furi);
  document.body.classList.toggle('no-roma', !st.roma);
  document.body.classList.toggle('trans-blur', st.transMode === 'blur');
  document.body.classList.toggle('trans-hide', st.transMode === 'hide');
  $('#tgFuri').classList.toggle('on', st.furi);
  $('#tgRoma').classList.toggle('on', st.roma);
  $('#tgTrans').classList.toggle('on', st.transMode !== 'hide');
  $('#tgTrans').textContent = { show: '翻译', blur: '翻译·模糊', hide: '翻译' }[st.transMode];
  $('#tgFollow').classList.toggle('on', st.follow);
  $('#tgLevel').classList.toggle('on', st.showLevel && st.myLevel > 0);
  $('#tgLevel').title = st.myLevel > 0 ? `给比 N${st.myLevel} 更难的词加下划线（在设置里改水平）` : '在设置里选你的水平后可用';
  document.body.classList.toggle('no-level', !st.showLevel || !st.myLevel);
  $('#btnAuto').classList.toggle('on', st.autoPause);
  $('#btnLoop').classList.toggle('on', st.loop);
  $('#selGap').value = String(st.gapFactor);
  $$('#speeds button').forEach((b) => b.classList.toggle('on', Number(b.dataset.rate) === st.rate));
}

// ---------- tick from the page ----------
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.kage || !sender.tab || sender.tab.id !== S.tabId) return;
  if (msg.type === 'tick') {
    if (msg.videoId && S.videoId && msg.videoId !== S.videoId && !S.loading) { connect(); return; }
    S.paused = msg.paused; S.phase = msg.phase;
    $('#btnPlay').textContent = msg.paused && msg.phase !== 'gap' ? '▶' : '⏸';
    if (msg.index >= 0 && msg.index !== S.active) markActive(msg.index);
    const bar = $('#gapBar');
    if (msg.phase === 'gap') {
      if (!S.gapTotal || msg.gapLeft > S.gapTotal) S.gapTotal = msg.gapLeft;
      bar.classList.add('on');
      bar.firstElementChild.style.width = (100 * (1 - msg.gapLeft / (S.gapTotal || 1))) + '%';
    } else { S.gapTotal = 0; bar.classList.remove('on'); bar.firstElementChild.style.width = '0'; }
  } else if (msg.type === 'segmentEnded') {
    if (S.pendingCompare === msg.index) { S.pendingCompare = -1; playMine(msg.index); }
  } else if (msg.type === 'navigated') {
    setTimeout(connect, 600);
  }
});

// ---------- recording ----------
async function getMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
    toast('需要先授权麦克风：在新打开的页面里点"允许"，然后回来再录一次。');
    return null;
  }
}
async function toggleRecord(i) {
  if (S.rec) { stopRecord(); return; }
  if (i < 0) return;
  const stream = await getMic();
  if (!stream) return;
  const chunks = [];
  const mr = new MediaRecorder(stream);
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    if (S.recordings[i]) URL.revokeObjectURL(S.recordings[i]);
    S.recordings[i] = URL.createObjectURL(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
    refreshCard(i);
    cmd('releaseGap');
  };
  cmd('holdGap');
  mr.start();
  S.rec = { mr, i, timer: S.settings.recMax > 0 ? setTimeout(stopRecord, S.settings.recMax * 1000) : null };
  const b = $(`#c${i} [data-act="rec"]`); if (b) { b.classList.add('rec'); b.textContent = '■ 停止'; }
}
function stopRecord() {
  if (!S.rec) return;
  clearTimeout(S.rec.timer);
  const r = S.rec; S.rec = null;
  if (r.mr.state !== 'inactive') r.mr.stop();
}
let mineAudio = null;
function playMine(i) {
  if (!S.recordings[i]) return;
  if (mineAudio) mineAudio.pause();
  mineAudio = new Audio(S.recordings[i]);
  mineAudio.play();
}
function compare(i) {
  if (!S.recordings[i]) { toast('先录一遍这句（M）'); return; }
  S.pendingCompare = i;
  cmd('playOnce', { index: i });
}

// ---------- AI ----------
function aiReady() { return !!S.settings.apiKey; }
async function callLLM(prompt, maxTokens = 1200) {
  const st = S.settings;
  if (!st.apiKey) throw new Error('请先在「设置」里填写 API Key');
  if (st.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': st.apiKey,
        'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: st.model || 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + res.status));
    return j.content.map((c) => c.text || '').join('');
  }
  const base = (st.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + st.apiKey },
    body: JSON.stringify({ model: st.model || 'gpt-4o-mini', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + res.status));
  return j.choices[0].message.content;
}
function parseJsonLoose(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  const a2 = text.indexOf('['), b2 = text.lastIndexOf(']');
  if (a2 >= 0 && (a < 0 || a2 < a)) return JSON.parse(text.slice(a2, b2 + 1));
  return JSON.parse(text.slice(a, b + 1));
}

async function breakdown(i) {
  const card = $('#c' + i); const box = $('.bd', card);
  if (!box.classList.contains('hidden') && box.dataset.done) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const key = `bd:${S.videoId}:${S.sentences[i].text}`;
  let data = await store.get(key);
  if (!data) {
    if (!aiReady()) { box.innerHTML = '<span class="muted">在「设置」里填好 API Key 后就能用 AI 拆解。</span>'; return; }
    box.innerHTML = '<span class="muted">正在拆解…</span>';
    const s = S.sentences[i];
    const ctx = [S.sentences[i - 1], S.sentences[i + 1]].filter(Boolean).map((x) => x.text).join(' / ');
    const prompt = `你是一位耐心的日语老师，学生母语是中文，正在用 YouTube 视频做影子跟读。请拆解下面这句日语。
视频标题：${S.title}
上下文：${ctx || '（无）'}
要拆解的句子：「${s.text}」

只输出 JSON，不要任何额外文字，格式：
{"translation":"自然的中文翻译",
 "grammar":[{"point":"语法点（日文原形，如 〜てみる）","level":"N5|N4|N3|N2|N1","explain":"一句话中文解释它在这句里的作用","example":"一个简短的新例句（日文）＋中文"}],
 "patterns":["可以直接套用的句型，如『〜に行ってみました』＝去试着…了"],
 "nuance":"口语/敬语/省略/语气等值得注意的地方，一两句话；没有就留空",
 "shadowTip":"跟读这句时的发音或节奏提示（长音、促音、语调、连读），一句话"}
语法点挑 1–4 个真正值得学的，不要罗列助词は、が之类太基础的内容，除非用法特殊。`;
    try { data = parseJsonLoose(await callLLM(prompt)); await store.set(key, data); }
    catch (e) { box.innerHTML = `<span class="err">拆解失败：${esc(e.message)}</span>`; return; }
  }
  box.dataset.done = '1';
  box.innerHTML = renderBreakdown(data);
  if (data.translation && !S.sentences[i].zh && !S.sentences[i].zhAi) {
    S.sentences[i].zhAi = data.translation; const z = $('.zh', card); if (z) z.textContent = data.translation;
    saveTranscript();
  }
}
function renderBreakdown(d) {
  let h = '';
  if (d.translation) h += `<div><b>译：</b>${esc(d.translation)}</div>`;
  if (d.grammar && d.grammar.length) {
    h += '<h4>语法</h4>' + d.grammar.map((g) => `<div class="gp"><b>${esc(g.point)}</b>${g.level ? `<span class="lv l${esc(String(g.level).slice(1))}">${esc(g.level)}</span>` : ''} — ${esc(g.explain)}${g.example ? `<div class="muted">例：${esc(g.example)}</div>` : ''}</div>`).join('');
  }
  if (d.patterns && d.patterns.length) h += '<h4>句型</h4>' + d.patterns.map((p) => `<div>· ${esc(p)}</div>`).join('');
  if (d.nuance) h += `<h4>语感</h4><div>${esc(d.nuance)}</div>`;
  if (d.shadowTip) h += `<h4>跟读提示</h4><div>${esc(d.shadowTip)}</div>`;
  return h;
}

async function aiTranslateAll() {
  if (!aiReady()) { toast('先在「设置」里填写 API Key'); switchTab('settings'); return; }
  const btn = $('#btnAiTrans');
  const todo = S.sentences.filter((s) => !s.zh && !s.zhAi);
  for (let k = 0; k < todo.length; k += 40) {
    btn.textContent = `翻译中 ${k}/${todo.length}…`;
    const batch = todo.slice(k, k + 40);
    const prompt = `把下面的日语句子逐句翻成自然的简体中文。视频标题：${S.title}
只输出 JSON 数组，每项 {"i":编号,"zh":"译文"}，不要其他文字。
${batch.map((s) => `${s.i}\t${s.text}`).join('\n')}`;
    try {
      const arr = parseJsonLoose(await callLLM(prompt, 4000));
      for (const it of arr) { const s = S.sentences[it.i]; if (s) { s.zhAi = it.zh; const z = $(`#c${it.i} .zh`); if (z) z.textContent = it.zh; } }
    } catch (e) { toast('翻译失败：' + e.message); break; }
  }
  btn.textContent = 'AI 翻译全部';
  await saveTranscript();
}
async function saveTranscript() {
  if (!S.data) return;
  S.data.sentences = S.sentences.map(({ i, start, end, text, zh, zhAi, marks, why }) => ({ i, start, end, text, zh, zhAi, marks, why }));
  S.data.savedAt = Date.now();
  await store.set('tr2:' + S.videoId, S.data);
  renderMeta();
}

// ---------- manual segmentation edits ----------
function setEditing(on) {
  S.editing = on;
  document.body.classList.toggle('editing', on);
  const b = $('#tgEdit'); if (b) b.classList.toggle('on', on);
  const bar = $('#editBar'); if (bar) bar.classList.toggle('hidden', !on);
  if (on) {
    $('#btnAiSeg').disabled = !!(S.data && S.data.edited);
    $('#btnAiSeg').title = S.data && S.data.edited ? '先「恢复自动断句」再用 AI 优化' : '让 AI 给自动字幕补标点，再重新断句';
    $('#btnResetSeg').disabled = !(S.data && (S.data.edited || S.data.aiPunct));
  }
}
async function commitEdit(list, focusIdx) {
  S.sentences = attachZh(Seg.renumber(list), S.data);
  S.data.edited = true;
  S.recordings = {};
  await saveTranscript();
  renderList(); renderDifficulty();
  await pushSentences();
  setEditing(true);
  const el = $('#c' + focusIdx); if (el) el.scrollIntoView({ block: 'center' });
}
function splitAt(i, wi) {
  const s = S.sentences[i];
  const c = s._groups.slice(0, wi).reduce((n, g) => n + g.surface.length, 0);
  const parts = Seg.splitSentence(s, c);
  if (!parts) return;
  const list = S.sentences.slice(0, i).concat(parts, S.sentences.slice(i + 1));
  commitEdit(list, i);
}
function mergeUp(i) {
  if (i <= 0) return;
  const m = Seg.mergeSentences(S.sentences[i - 1], S.sentences[i]);
  const list = S.sentences.slice(0, i - 1).concat([m], S.sentences.slice(i + 1));
  commitEdit(list, i - 1);
}
async function resetSegmentation() {
  delete S.data.edited; delete S.data.aiPunct; delete S.data.segVersion;
  S.data.sentences = null;
  setEditing(false);
  await applyTranscript(S.data);
  toast('已恢复自动断句');
}

// AI adds punctuation only; we verify it changed nothing else, then re-run the segmenter with it.
async function aiOptimizeSegmentation() {
  if (!aiReady()) { toast('先在「设置」里填写 API Key'); switchTab('settings'); return; }
  const btn = $('#btnAiSeg');
  const parsed = S.data.raw.cues ? Seg.unitsFromCues(S.data.raw.cues) : Seg.unitsFromJson3(S.data.raw.ja);
  const text = Seg.plainText(parsed, S.tokenizer);
  // chunks of ~800 chars, cut where the current segmentation already ends a sentence
  const cuts = [0];
  let pos = 0;
  for (const x of segmentData(S.data)) {
    const at = text.indexOf(x.text, pos);
    if (at < 0) continue;
    pos = at + x.text.length;
    if (pos - cuts[cuts.length - 1] > 800) cuts.push(pos);
  }
  if (cuts[cuts.length - 1] < text.length) cuts.push(text.length);
  const ends = new Set();
  let failed = 0;
  for (let k = 0; k + 1 < cuts.length; k++) {
    btn.textContent = `AI 优化中 ${k + 1}/${cuts.length - 1}…`;
    const chunk = text.slice(cuts[k], cuts[k + 1]);
    const prompt = `下面是一段日语视频的自动字幕，没有标点，句子连在一起。视频标题：${S.title}
请只在合适的位置加上日语标点（。、？！），让每个句子在该结束的地方结束。
严格要求：不能修改、增加或删除任何文字（包括错别字也不要改），不要换行，不要任何解释，直接输出加好标点的全文。

${chunk}`;
    try {
      const out = (await callLLM(prompt, Math.min(4000, chunk.length * 3 + 200))).trim();
      const map = Seg.mapPunctuation(chunk, out);
      if (!map) { failed++; continue; }
      map.forEach((o) => ends.add(o + cuts[k]));
    } catch (e) { toast('AI 优化失败：' + e.message); btn.textContent = '✨ AI 优化断句'; return; }
  }
  btn.textContent = '✨ AI 优化断句';
  if (!ends.size) { toast('AI 返回的结果没通过校验，断句保持不变'); return; }
  S.data.aiPunct = [...ends].sort((a, b) => a - b);
  delete S.data.segVersion; S.data.sentences = null;
  setEditing(false);
  await applyTranscript(S.data);
  toast(failed ? `已优化断句（${failed} 段未通过校验，保留原断句）` : '已用 AI 优化断句');
}

function exportSegData() {
  const d = S.data; if (!d) return;
  const out = { kage: chrome.runtime.getManifest().version, segVersion: Seg.SEG_VERSION, videoId: d.videoId, title: d.title, track: d.track,
    url: `https://www.youtube.com/watch?v=${d.videoId}`, edited: !!d.edited, aiPunct: d.aiPunct || null,
    sentences: S.sentences.map(({ start, end, text, why }) => ({ start, end, text, why })), raw: d.raw, exportedAt: new Date().toISOString() };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = `kage-seg-${d.videoId}.json`;
  a.click();
  toast('已导出：把这个文件附在 GitHub Issue 里，或者直接发给开发者');
}

// ---------- difficulty ----------
function renderDifficulty() {
  const el = $('#diff');
  if (!J || !S.tokenizer || !S.sentences.length) { el.classList.add('hidden'); return; }
  S.sentences.forEach((x) => { if (!x._groups) x._groups = C.groupTokens(S.tokenizer.tokenize(x.text)); });
  const p = S.profile = J.profile(S.sentences.map((x) => x._groups));
  if (!p.total) { el.classList.add('hidden'); return; }
  const segs = [5, 4, 3, 2, 1, 0].filter((lv) => p.counts[lv]).map((lv) => {
    const pct = (100 * p.counts[lv]) / p.total;
    return `<span class="seg l${lv}" style="flex:${p.counts[lv]}" title="${LV(lv)}：${p.counts[lv]} 词（${pct.toFixed(0)}%）"></span>`;
  }).join('');
  const est = p.estimate;
  const label = est ? `约 <b>N${est}</b> · 掌握 N${est} 词汇可覆盖 ${(100 * p.coverage[est]).toFixed(0)}%` : '词汇量不足以估计难度';
  const legend = [5, 4, 3, 2, 1, 0].map((lv) => `<span class="lg"><i class="l${lv}"></i>${LV(lv)} ${p.counts[lv]}</span>`).join('');
  el.innerHTML = `<div class="diff-head"><span>词汇难度</span><span>${label}</span></div><div class="bar">${segs}</div><div class="legend">${legend}</div>`;
  el.classList.remove('hidden');
}

// ---------- word sheet ----------
async function openWord(i, wi) {
  const s = S.sentences[i]; const w = s._groups[wi];
  if (!w || w.isPunct) return;
  const key = lookupKey(w);
  const saved = S.wordKeys.has(wordKey(w));
  const dictReading = (key !== w.surface && S.tokenizer)
    ? S.tokenizer.tokenize(key).map((t) => C.toHira(t.reading && t.reading !== '*' ? t.reading : t.surface_form)).join('')
    : w.reading;
  $('#sheetBody').innerHTML = `
    <div class="wd-head"><span class="wd-word">${esc(key)}</span><span class="wd-read">${esc(dictReading)}</span>
    ${levelBadge(w)}
    <span class="wd-pos">${esc(C.POS_ZH[w.pos] || w.pos)}${w.surface !== key ? ' · 原文「' + esc(w.surface) + '」' : ''}</span></div>
    <div class="wd-sec"><h4>语境释义</h4><div id="wdAi" class="muted">${aiReady() ? '查询中…' : '填写 API Key 后显示中文语境释义'}</div></div>
    <div class="wd-sec"><h4>词典 · Jisho</h4><div id="wdDict" class="muted">查询中…</div></div>
    <div class="wd-sec"><h4>原句</h4><div class="wd-sent">${esc(s.text)}</div>${s.zhAi || s.zh ? `<div class="muted" style="margin-top:4px">${esc(s.zhAi || s.zh)}</div>` : ''}</div>
    <div class="wd-actions"><button id="wdSave" class="primary${saved ? ' done' : ''}">${saved ? '✓ 已在生词本' : '★ 加入生词本'}</button>
    <button class="chip" id="wdPlay">▶ 听这句</button></div>`;
  $('#sheet').classList.remove('hidden');
  const entry = { key: wordKey(w), word: key, reading: dictReading, pos: C.POS_ZH[w.pos] || w.pos,
    surface: w.surface, sentence: s.text, sentenceZh: s.zhAi || s.zh || '', videoId: S.videoId, videoTitle: S.title, t: s.start, meaning: '', dict: '' };
  { const lv = J && J.forWord(w); if (lv && lv.level) entry.jlpt = 'N' + lv.level; }
  $('#wdPlay').onclick = () => cmd('playOnce', { index: i });
  $('#wdSave').onclick = async () => {
    if (S.wordKeys.has(entry.key)) return;
    entry.addedAt = Date.now();
    S.words.unshift(entry); S.wordKeys.add(entry.key);
    await store.set('words', S.words);
    $('#wdSave').classList.add('done'); $('#wdSave').textContent = '✓ 已在生词本';
    updateWordCount(); refreshCard(i);
  };

  // dictionary
  fetch('https://jisho.org/api/v1/search/words?keyword=' + encodeURIComponent(key))
    .then((r) => r.json()).then((j) => {
      const items = (j.data || []).slice(0, 2);
      if (!items.length) { $('#wdDict').textContent = '没有找到词条'; return; }
      const html = items.map((it) => {
        const jp = it.japanese[0] || {};
        const lv = (it.jlpt || []).map((x) => x.replace('jlpt-', '').toUpperCase());
        const senses = it.senses.slice(0, 3).map((se, k) => `${k + 1}. ${esc(se.english_definitions.join('; '))}`).join('<br>');
        return `<div style="margin-bottom:6px"><b style="font-family:var(--jp)">${esc(jp.word || jp.reading)}</b> <span class="muted">${esc(jp.reading || '')}</span>${lv.map((l) => `<span class="lv l${l.slice(1)}">${l}</span>`).join('')}<div style="color:var(--ink-2)">${senses}</div></div>`;
      }).join('');
      const el = $('#wdDict'); if (el) { el.classList.remove('muted'); el.innerHTML = html; }
      entry.dict = items[0].senses.slice(0, 2).map((se) => se.english_definitions.join('; ')).join(' / ');
      const lv0 = (items[0].jlpt || [])[0]; if (lv0 && !entry.jlpt) entry.jlpt = lv0.replace('jlpt-', '').toUpperCase();
    }).catch(() => { const el = $('#wdDict'); if (el) el.textContent = '词典查询失败（网络）'; });

  // AI meaning in context
  if (aiReady()) {
    const ck = `wm:${key}|${s.text}`;
    let m = await store.get(ck);
    if (!m) {
      try {
        m = parseJsonLoose(await callLLM(`日语句子：「${s.text}」
这句里的「${w.surface}」（原形：${key}）是什么意思？只输出 JSON：{"meaning":"它在这句里的中文意思，10 字以内","note":"用法或易混点，一句话，可留空"}`, 300));
        await store.set(ck, m);
      } catch (e) { const el = $('#wdAi'); if (el) el.innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }
    }
    entry.meaning = m.meaning || '';
    const el = $('#wdAi'); if (el) { el.classList.remove('muted'); el.innerHTML = `<b>${esc(m.meaning)}</b>${m.note ? `<div class="muted">${esc(m.note)}</div>` : ''}`; }
  }
}
function levelBadge(w) {
  const lv = J ? J.forWord(w) : null;
  if (!lv) return '';
  if (!lv.level) return '<span class="lv l0" title="不在 JLPT 参考词表里">级外</span>';
  return `<span class="lv l${lv.level}" title="${lv.src === 'kanji' ? '词表里没有，按汉字等级估计' : 'JLPT 参考词表'}">${lv.src === 'kanji' ? '≈' : ''}N${lv.level}</span>`;
}
function closeSheet() { $('#sheet').classList.add('hidden'); }

// ---------- wordbook ----------
function updateWordCount() { $('#wordCount').textContent = S.words.length ? S.words.length : ''; }
function renderWords() {
  const q = $('#wordSearch').value.trim().toLowerCase();
  const list = S.words.filter((w) => !q || [w.word, w.reading, w.meaning, w.dict, w.sentence].join(' ').toLowerCase().includes(q));
  if (!list.length) { $('#wordList').innerHTML = `<div class="empty">${S.words.length ? '没有匹配的单词' : '还没有生词。<br>在跟读页点任意一个词，就能查词并收藏。'}</div>`; return; }
  $('#wordList').innerHTML = list.map((w) => `<div class="wi" data-key="${esc(w.key)}">
    <div class="h"><b>${esc(w.word)}</b><span class="r">${esc(w.reading)}</span>${w.jlpt ? `<span class="lv l${esc(String(w.jlpt).slice(1))}">${esc(w.jlpt)}</span>` : ''}<button class="x" data-act="del" title="删除">×</button></div>
    <div class="m">${esc(w.meaning || w.dict || '')}</div>
    <div class="s">${esc(w.sentence)}<a href="#" data-act="jump">▶ ${C.fmtTime(w.t)}</a></div></div>`).join('');
}
function exportCsv() {
  const rows = [['单词', '读音', '释义', '英文释义', '例句', '例句翻译', '视频', '链接']];
  for (const w of S.words) {
    rows.push([w.word, w.reading, w.meaning, w.dict, w.sentence, w.sentenceZh, w.videoTitle,
      `https://www.youtube.com/watch?v=${w.videoId}&t=${Math.floor(w.t)}s`]);
  }
  const csv = '﻿' + rows.map((r) => r.map(C.csvEscape).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `kage-words-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ---------- misc UI ----------
let toastTimer;
function toast(text) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t);
    Object.assign(t.style, { position: 'fixed', left: '12px', right: '12px', bottom: '14px', zIndex: 60, background: 'var(--ink)', color: 'var(--bg)', padding: '8px 12px', borderRadius: '10px', fontSize: '12px', transition: 'opacity .2s' }); }
  t.textContent = text; t.style.opacity = '1';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.style.opacity = '0'), 3200);
}
function switchTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
  if (name === 'words') renderWords();
}
const cur = () => (S.active >= 0 ? S.active : 0);

function bindUi() {
  $$('.tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $('#btnPlay').onclick = () => cmd('togglePlay');
  $('#btnPrev').onclick = () => cmd('seek', { index: Math.max(0, cur() - 1) });
  $('#btnNext').onclick = () => cmd('seek', { index: Math.min(S.sentences.length - 1, cur() + 1) });
  $('#btnAuto').onclick = () => { S.settings.autoPause = !S.settings.autoPause; applyDisplay(); saveSettings(); pushSettings(); };
  $('#btnLoop').onclick = () => { S.settings.loop = !S.settings.loop; applyDisplay(); saveSettings(); pushSettings(); };
  $('#selGap').onchange = (e) => { S.settings.gapFactor = Number(e.target.value); saveSettings(); pushSettings(); };
  $$('#speeds button').forEach((b) => (b.onclick = () => { S.settings.rate = Number(b.dataset.rate); applyDisplay(); saveSettings(); cmd('setRate', { rate: S.settings.rate }); }));
  $('#tgFuri').onclick = () => { S.settings.furi = !S.settings.furi; applyDisplay(); saveSettings(); };
  $('#tgRoma').onclick = () => { S.settings.roma = !S.settings.roma; applyDisplay(); saveSettings(); };
  $('#tgTrans').onclick = () => {
    const order = ['blur', 'show', 'hide']; S.settings.transMode = order[(order.indexOf(S.settings.transMode) + 1) % 3];
    $('#setTransMode').value = S.settings.transMode; applyDisplay(); saveSettings();
  };
  $('#tgFollow').onclick = () => { S.settings.follow = !S.settings.follow; applyDisplay(); saveSettings(); if (S.settings.follow) { S.userScrollAt = 0; markActive(S.active); } };
  $('#btnAiTrans').onclick = aiTranslateAll;
  $('#tgEdit').onclick = () => setEditing(!S.editing);
  $('#btnEditDone').onclick = () => setEditing(false);
  $('#btnResetSeg').onclick = resetSegmentation;
  $('#btnAiSeg').onclick = aiOptimizeSegmentation;
  $('#btnExportSeg').onclick = exportSegData;
  $('#tgLevel').onclick = () => { S.settings.showLevel = !S.settings.showLevel; applyDisplay(); saveSettings(); };

  $('#list').addEventListener('click', (e) => {
    const card = e.target.closest('.card'); if (!card) return;
    const i = Number(card.dataset.i);
    const actEl = e.target.closest('[data-act]');
    const wEl = e.target.closest('.w');
    if (actEl) {
      const act = actEl.dataset.act;
      if (act === 'seek') cmd('seek', { index: i });
      else if (act === 'rec') toggleRecord(i);
      else if (act === 'mine') playMine(i);
      else if (act === 'cmp') compare(i);
      else if (act === 'bd') breakdown(i);
      else if (act === 'merge') mergeUp(i);
    } else if (wEl && S.editing) {
      splitAt(i, Number(wEl.dataset.w));
    } else if (wEl && !wEl.classList.contains('punct')) {
      openWord(i, Number(wEl.dataset.w));
    }
  });
  const markScroll = () => { S.userScrollAt = Date.now(); };
  window.addEventListener('wheel', markScroll, { passive: true });
  window.addEventListener('touchmove', markScroll, { passive: true });

  $('#sheetClose').onclick = closeSheet;
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

  $('#wordSearch').oninput = renderWords;
  $('#btnExport').onclick = exportCsv;
  $('#wordList').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]'); if (!act) return;
    e.preventDefault();
    const key = e.target.closest('.wi').dataset.key;
    const w = S.words.find((x) => x.key === key);
    if (act.dataset.act === 'del') {
      S.words = S.words.filter((x) => x.key !== key); S.wordKeys.delete(key);
      await store.set('words', S.words); updateWordCount(); renderWords();
      if (S.sentences.length) renderList();
    } else if (act.dataset.act === 'jump' && w) {
      if (w.videoId === S.videoId) { switchTab('study'); cmd('seekTime', { time: Math.max(0, w.t - 0.05) }); }
      else chrome.tabs.update(S.tabId, { url: `https://www.youtube.com/watch?v=${w.videoId}&t=${Math.floor(w.t)}s` });
    }
  });

  // settings
  const st = S.settings;
  $('#setProvider').value = st.provider; $('#setKey').value = st.apiKey; $('#setModel').value = st.model; $('#setBase').value = st.baseUrl;
  $('#setTransMode').value = st.transMode; $('#setRecMax').value = st.recMax; $('#setLevel').value = String(st.myLevel);
  $('#setLevel').onchange = (e) => { st.myLevel = Number(e.target.value); st.showLevel = st.myLevel > 0; applyDisplay(); saveSettings(); if (S.sentences.length) renderList(); };
  const syncProv = () => {
    $$('.for-openai').forEach((el) => el.classList.toggle('hidden', $('#setProvider').value !== 'openai'));
    $('#setModel').placeholder = $('#setProvider').value === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'deepseek-chat';
  };
  $('#setProvider').onchange = syncProv; syncProv();
  $('#btnSaveAi').onclick = async () => {
    st.provider = $('#setProvider').value; st.apiKey = $('#setKey').value.trim(); st.model = $('#setModel').value.trim(); st.baseUrl = $('#setBase').value.trim();
    if (st.provider === 'openai' && st.baseUrl) {
      try {
        const origin = new URL(st.baseUrl).origin + '/*';
        const ok = await chrome.permissions.request({ origins: [origin] });
        if (!ok) { $('#aiMsg').textContent = '需要授权访问该地址'; return; }
      } catch (e) { $('#aiMsg').textContent = 'Base URL 格式不对'; return; }
    }
    await saveSettings(); $('#aiMsg').textContent = '已保存';
    $('#btnAiTrans').classList.toggle('hidden', !S.sentences.length || S.sentences.some((s) => s.zh));
  };
  $('#btnTestAi').onclick = async () => {
    $('#aiMsg').textContent = '测试中…';
    try { const r = await callLLM('用一个词回答：日语「猫」的中文？', 20); $('#aiMsg').textContent = '✓ 连接成功：' + r.trim().slice(0, 20); }
    catch (e) { $('#aiMsg').textContent = '✗ ' + e.message; }
  };
  $('#setTransMode').onchange = (e) => { st.transMode = e.target.value; applyDisplay(); saveSettings(); };
  $('#setRecMax').onchange = (e) => { st.recMax = Math.max(0, Number(e.target.value) || 0); saveSettings(); };
  $('#fileSub').onchange = async (e) => {
    const f = e.target.files[0]; if (!f || !S.videoId) { toast('先打开要配字幕的视频'); return; }
    const cues = C.parseSubtitleFile(await f.text());
    if (!cues.length) { toast('没有解析到字幕内容'); return; }
    const data = { videoId: S.videoId, title: $('#videoTitle').textContent, track: { lang: 'ja', kind: 'import' }, raw: { cues }, savedAt: Date.now() };
    switchTab('study'); setEditing(false); applyTranscript(data); e.target.value = '';
  };

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#sheet').classList.contains('hidden') && e.key === 'Escape') { closeSheet(); return; }
    if (!S.sentences.length) return;
    const k = e.key.toLowerCase();
    const map = {
      ' ': () => cmd('togglePlay'),
      arrowleft: () => $('#btnPrev').click(),
      arrowright: () => $('#btnNext').click(),
      r: () => cmd('seek', { index: cur() }),
      m: () => toggleRecord(S.rec ? S.rec.i : cur()),
      c: () => compare(cur()),
      p: () => $('#btnAuto').click(),
      l: () => $('#btnLoop').click(),
      e: () => setEditing(!S.editing),
      escape: () => S.editing && setEditing(false),
    };
    if (map[k]) { e.preventDefault(); map[k](); }
  });
}

// ---------- boot ----------
(async function init() {
  S.settings = Object.assign({}, DEFAULTS, (await store.get('settings')) || {});
  S.words = (await store.get('words')) || [];
  S.wordKeys = new Set(S.words.map((w) => w.key));
  updateWordCount();
  applyDisplay();
  bindUi();
  await connect();
  chrome.tabs.onActivated.addListener(() => connect());
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (tabId === S.tabId && info.status === 'complete') connect(); });
})();
