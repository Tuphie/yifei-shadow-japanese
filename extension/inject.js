// Kage 影读 · runs in the page's MAIN world on youtube.com
// Job: find the Japanese caption track for the current video and hand its JSON to the extension.
(() => {
  if (window.__kageInjected) return;
  window.__kageInjected = true;

  const SRC_IN = 'kage-cs';
  const SRC_OUT = 'kage-page';
  const captured = []; // timedtext URLs the player itself requested (they carry the "pot" token)

  function noteUrl(u) {
    try {
      const s = typeof u === 'string' ? u : (u && u.url) || String(u);
      if (s.includes('/api/timedtext')) {
        captured.push(new URL(s, location.href).toString());
        if (captured.length > 30) captured.shift();
      }
    } catch (e) {}
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    noteUrl(input);
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    noteUrl(url);
    return origOpen.apply(this, arguments);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const player = () => document.getElementById('movie_player');
  const currentVideoId = () => new URL(location.href).searchParams.get('v');

  function playerResponse() {
    const vid = currentVideoId();
    try {
      const pr = player() && player().getPlayerResponse && player().getPlayerResponse();
      if (pr && pr.videoDetails && pr.videoDetails.videoId === vid) return pr;
    } catch (e) {}
    const pr = window.ytInitialPlayerResponse;
    if (pr && pr.videoDetails && pr.videoDetails.videoId === vid) return pr;
    return null;
  }

  function pickJaTrack(tracks) {
    const ja = tracks.filter((t) => (t.languageCode || '').toLowerCase().startsWith('ja'));
    return ja.find((t) => t.kind !== 'asr') || ja.find((t) => t.kind === 'asr') || null;
  }

  async function getJson(url) {
    const res = await origFetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (!text || !text.trim()) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function withParams(baseUrl, extra) {
    const u = new URL(baseUrl, location.href);
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) u.searchParams.delete(k); else u.searchParams.set(k, v);
    }
    return u.toString();
  }

  // Copy session/token params (pot, potc, c, cver …) from a URL the player made itself.
  function tokenParams(vid) {
    for (let i = captured.length - 1; i >= 0; i--) {
      const u = new URL(captured[i]);
      if (u.searchParams.get('v') !== vid) continue;
      const out = {};
      const skip = new Set(['lang', 'kind', 'tlang', 'name', 'fmt', 'v']);
      u.searchParams.forEach((val, key) => { if (!skip.has(key)) out[key] = val; });
      if (out.pot) return out;
    }
    return null;
  }

  async function forcePlayerToRequestCaptions(track) {
    const p = player();
    let turnedOn = false;
    try {
      p.loadModule && p.loadModule('captions');
      p.setOption && p.setOption('captions', 'track', { languageCode: track.languageCode, kind: track.kind || '' });
      turnedOn = true;
    } catch (e) {}
    for (let i = 0; i < 12; i++) { await sleep(250); if (tokenParams(currentVideoId())) return turnedOn; }
    const btn = document.querySelector('.ytp-subtitles-button');
    if (btn && btn.getAttribute('aria-pressed') !== 'true') { btn.click(); turnedOn = true; }
    for (let i = 0; i < 24; i++) { await sleep(250); if (tokenParams(currentVideoId())) break; }
    return turnedOn;
  }

  function hideCaptionsAgain() {
    try {
      const btn = document.querySelector('.ytp-subtitles-button');
      if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click();
    } catch (e) {}
  }

  async function getTranscript() {
    const vid = currentVideoId();
    if (!vid) return { error: 'notWatch' };
    let pr = playerResponse();
    for (let i = 0; !pr && i < 20; i++) { await sleep(250); pr = playerResponse(); }
    if (!pr) return { error: 'noPlayer', videoId: vid };

    const title = (pr.videoDetails && pr.videoDetails.title) || document.title;
    const tracks = (((pr.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
    const trackList = tracks.map((t) => ({
      lang: t.languageCode, kind: t.kind || 'manual',
      name: (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text).join(''))) || t.languageCode,
    }));
    const track = pickJaTrack(tracks);
    if (!track) return { error: 'noJa', videoId: vid, title, tracks: trackList };

    const meta = {
      videoId: vid, title, tracks: trackList,
      track: { lang: track.languageCode, kind: track.kind || 'manual' },
      translatable: !!track.isTranslatable,
    };

    // 1) Direct request
    let ja = null, zh = null, base = track.baseUrl, extra = {};
    try { ja = await getJson(withParams(base, { fmt: 'json3' })); } catch (e) {}

    // 2) Needs a proof-of-origin token → let the player fetch once, borrow its token
    let turnedOn = false;
    if (!ja || !ja.events) {
      let tp = tokenParams(vid);
      if (!tp) { turnedOn = await forcePlayerToRequestCaptions(track); tp = tokenParams(vid); }
      if (tp) {
        extra = tp;
        try { ja = await getJson(withParams(base, Object.assign({}, tp, { fmt: 'json3' }))); } catch (e) {}
      }
    }
    if (turnedOn) hideCaptionsAgain();
    if (!ja || !ja.events) return Object.assign(meta, { error: 'fetchFailed' });

    // 3) YouTube machine translation into Chinese, same timings
    if (track.isTranslatable !== false) {
      try { zh = await getJson(withParams(base, Object.assign({}, extra, { fmt: 'json3', tlang: 'zh-Hans' }))); } catch (e) {}
    }
    return Object.assign(meta, { ja, zh });
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== SRC_IN) return;
    const { type, reqId } = ev.data;
    if (type === 'getTranscript') {
      let result;
      try { result = await getTranscript(); } catch (e) { result = { error: 'exception', message: String(e) }; }
      window.postMessage({ source: SRC_OUT, type: 'transcript', reqId, result }, '*');
    }
  });

  document.addEventListener('yt-navigate-finish', () => {
    window.postMessage({ source: SRC_OUT, type: 'navigated', videoId: currentVideoId() }, '*');
  });
})();
