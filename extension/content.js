// Kage 影读 · content script (isolated world)
// Bridges the side panel and the YouTube page, and runs the shadowing engine next to the <video>.
(() => {
  if (window.__kageContent) return;
  window.__kageContent = true;

  const PAD = 0.12; // seconds of tail kept after a sentence ends
  let sentences = []; // [{start, end}] in seconds
  let videoId = null;
  let settings = { autoPause: true, loop: false, gapFactor: 1.2 };
  let phase = 'play'; // play | gap | hold | once
  let cur = -1; // sentence currently being played
  let onceIdx = -1;
  let gapTimer = null;
  let gapEndsAt = 0;
  let gapIdx = -1;
  let lastSent = 0;

  const video = () => document.querySelector('#movie_player video') || document.querySelector('video.html5-main-video') || document.querySelector('video');
  const vidFromUrl = () => { try { return new URL(location.href).searchParams.get('v'); } catch (e) { return null; } };

  function send(msg) {
    try { chrome.runtime.sendMessage(Object.assign({ kage: true }, msg)).catch(() => {}); } catch (e) {}
  }

  // ---------- page bridge ----------
  const pending = new Map();
  let reqSeq = 0;
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'kage-page') return;
    if (ev.data.type === 'transcript' && pending.has(ev.data.reqId)) {
      pending.get(ev.data.reqId)(ev.data.result);
      pending.delete(ev.data.reqId);
    } else if (ev.data.type === 'navigated') {
      if (ev.data.videoId !== videoId) {
        sentences = []; videoId = null; cancelGap(); phase = 'play'; cur = -1;
        send({ type: 'navigated', videoId: ev.data.videoId });
      }
    }
  });
  function askPage(type, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const reqId = ++reqSeq;
      pending.set(reqId, resolve);
      window.postMessage({ source: 'kage-cs', type, reqId }, '*');
      setTimeout(() => { if (pending.has(reqId)) { pending.delete(reqId); resolve({ error: 'timeout' }); } }, timeoutMs);
    });
  }

  // ---------- engine ----------
  function indexAt(t) {
    let lo = 0, hi = sentences.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sentences[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  function cancelGap() { if (gapTimer) clearTimeout(gapTimer); gapTimer = null; gapEndsAt = 0; }

  function startGap(i) {
    const v = video(); const s = sentences[i];
    const rate = v ? v.playbackRate || 1 : 1;
    const dur = (s.end - s.start) / rate;
    const gap = settings.autoPause ? Math.min(15, Math.max(1, dur * settings.gapFactor)) : 0.35;
    phase = 'gap'; gapIdx = i; gapEndsAt = Date.now() + gap * 1000;
    gapTimer = setTimeout(() => finishGap(), gap * 1000);
  }
  function finishGap() {
    cancelGap();
    const v = video(); if (!v) return;
    const i = gapIdx;
    phase = 'play';
    if (settings.loop) {
      cur = i;
      v.currentTime = Math.max(0, sentences[i].start - 0.05);
    } else if (sentences[i + 1]) {
      cur = i + 1;
      v.currentTime = Math.max(0, sentences[i + 1].start - 0.05);
    } else {
      cur = -1;
    }
    v.play();
  }

  function seekTo(i, play = true) {
    const v = video(); if (!v || !sentences[i]) return;
    cancelGap(); phase = 'play'; cur = i;
    v.currentTime = Math.max(0, sentences[i].start - 0.05);
    if (play) v.play();
  }
  function playOnce(i) {
    const v = video(); if (!v || !sentences[i]) return;
    cancelGap(); phase = 'once'; onceIdx = i; cur = i;
    v.currentTime = Math.max(0, sentences[i].start - 0.05);
    v.play();
  }

  function tick() {
    const v = video();
    if (!v) return;
    const t = v.currentTime;
    const idx = sentences.length ? indexAt(t) : -1;

    // keep "cur" in sync when the user scrubs the timeline
    if (sentences.length && phase === 'play') {
      const c = sentences[cur];
      if (!c || t < c.start - 0.4 || t > c.end + 1.2) cur = idx;
    }

    if (sentences.length && !v.paused) {
      if (phase === 'once') {
        const s = sentences[onceIdx];
        if (!s || t >= s.end + PAD || t < s.start - 1) {
          v.pause(); phase = 'play';
          send({ type: 'segmentEnded', index: onceIdx });
        }
      } else if (phase === 'play' && cur >= 0) {
        const s = sentences[cur];
        if (t >= s.end + PAD) {
          if (settings.autoPause || settings.loop) { v.pause(); startGap(cur); }
          else cur = Math.min(cur + 1, sentences.length - 1);
        }
      }
    }

    let shown = idx;
    if (phase === 'gap' || phase === 'hold') shown = gapIdx;
    else if (phase === 'once') shown = onceIdx;
    else if (cur >= 0 && sentences[cur] && t >= sentences[cur].start - 0.1 && t <= sentences[cur].end + PAD) shown = cur;

    const now = Date.now();
    if (now - lastSent > 120) {
      lastSent = now;
      send({
        type: 'tick', videoId: vidFromUrl(), time: t, paused: v.paused, index: shown,
        phase, gapLeft: phase === 'gap' ? Math.max(0, (gapEndsAt - now) / 1000) : 0,
        rate: v.playbackRate,
      });
    }
  }
  setInterval(tick, 40);

  // user hits play while we're waiting → just continue
  document.addEventListener('play', (e) => {
    if (e.target === video() && (phase === 'gap' || phase === 'hold')) finishGap();
  }, true);

  // ---------- messages from side panel ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.kageCmd) return;
    const v = video();
    switch (msg.kageCmd) {
      case 'ping':
        sendResponse({ ok: true, videoId: vidFromUrl(), title: document.title.replace(/ - YouTube$/, '') });
        return;
      case 'getTranscript':
        askPage('getTranscript').then(sendResponse);
        return true; // async
      case 'setSentences':
        sentences = msg.sentences || []; videoId = msg.videoId; cur = -1;
        sendResponse({ ok: true });
        return;
      case 'setSettings':
        settings = Object.assign(settings, msg.settings || {});
        if (!settings.autoPause && !settings.loop && phase === 'gap') finishGap();
        sendResponse({ ok: true });
        return;
      case 'seek': seekTo(msg.index, msg.play !== false); break;
      case 'playOnce': playOnce(msg.index); break;
      case 'seekTime': if (v) { cancelGap(); phase = 'play'; v.currentTime = msg.time; v.play(); } break;
      case 'togglePlay':
        if (v) {
          if (phase === 'gap' || phase === 'hold') finishGap();
          else if (v.paused) v.play(); else v.pause();
        }
        break;
      case 'pause': if (v) { cancelGap(); if (phase !== 'once') phase = 'play'; v.pause(); } break;
      case 'setRate': if (v) v.playbackRate = msg.rate; break;
      case 'holdGap': if (phase === 'gap') { cancelGap(); phase = 'hold'; } break;
      case 'releaseGap': if (phase === 'hold') finishGap(); break;
    }
    sendResponse({ ok: true });
  });
})();
