(function initLyricVibeOverlay() {
  const DEFAULT_SYNC_OFFSET_MS = -180;
  const SYNC_NUDGE_MS = 80;
  const THEMES = ['samay', 'hype', 'soft', 'neon', 'clean'];
  const THEME_LABELS = { samay: 'SAMAY', hype: 'HYPE', soft: 'SOFT', neon: 'NEON', clean: 'CLEAN' };
  const SETUP_OPENERS = new Set([
    'after', 'although', 'and', 'as', 'before', 'because', 'but', 'even',
    'if', 'i', 'just', 'maybe', 'my', 'now', 'once', 'she', 'since', 'so',
    'still', 'that', 'the', 'then', 'they', 'though', 'till', 'until',
    'when', 'while', 'with', 'you'
  ]);
  const TAG_OPENERS = new Set(['is', 'are', 'was', 'were', 'not', 'no', 'never', 'only', 'all']);

  if (window.__lyricVibeOverlay && window.__lyricVibeOverlay.show) {
    window.__lyricVibeOverlay.show();
    return;
  }

  const state = {
    active: false,
    lines: [],
    currentIndex: -1,
    currentMoment: null,
    revealTimers: [],
    rafId: 0,
    hudTimer: 0,
    trackTitle: '',
    lyricSource: '',
    syncOffsetMs: DEFAULT_SYNC_OFFSET_MS,
    fallbackStartMs: 0,
    fallbackMediaStartMs: 0,
    theme: 'samay'
  };

  const root = document.createElement('div');
  root.id = 'lvx-root';

  const stage = document.createElement('div');
  stage.className = 'lvx-stage';

  const hud = document.createElement('div');
  hud.className = 'lvx-hud';

  const hudLabel = document.createElement('span');
  hudLabel.className = 'lvx-hud-label';
  hudLabel.textContent = 'LYRICVIBE';

  const hudText = document.createElement('span');
  hudText.className = 'lvx-hud-text';
  hudText.textContent = 'Ready';

  const stopButton = document.createElement('button');
  stopButton.className = 'lvx-stop';
  stopButton.textContent = 'Stop';
  stopButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {});
    teardown();
  });

  const themeButton = document.createElement('button');
  themeButton.className = 'lvx-theme-btn';
  themeButton.textContent = 'SAMAY';
  themeButton.title = 'Cycle theme (or press T)';
  themeButton.addEventListener('click', () => cycleTheme());

  hud.append(hudLabel, hudText, themeButton, stopButton);
  root.append(stage, hud);
  document.documentElement.appendChild(root);

  window.__lyricVibeOverlay = {
    show,
    hide: teardown,
    hints: getPageHints
  };

  setHud('Ready. Play music, then click LyricVibe.', false, true);

  // Load saved theme
  try {
    chrome.storage.local.get('lvxTheme', (result) => {
      if (result && result.lvxTheme && THEMES.includes(result.lvxTheme)) {
        applyTheme(result.lvxTheme);
      }
    });
  } catch (_) {}

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'LV_GET_HINTS') {
      sendResponse(getPageHints());
      return true;
    }

    if (message.type === 'LV_STATUS') {
      setHud(message.text || 'Working...');
    }

    if (message.type === 'LV_ERROR') {
      setHud(message.text || 'Something went wrong.', true, true);
    }

    if (message.type === 'LV_TRACK') {
      startTrack(message.payload);
    }

    if (message.type === 'LV_STOP') {
      teardown();
    }
  });

  document.addEventListener('keydown', handleKeys, true);
  window.addEventListener('resize', () => {
    if (state.currentMoment) fitMoment(state.currentMoment);
  });

  function getPageHints() {
    const media = getMedia();
    const url = location.href;
    const title = document.title || '';
    const host = location.hostname;
    const hints = {
      url,
      host,
      pageTitle: title,
      currentTime: media && Number.isFinite(media.currentTime) ? media.currentTime : null,
      duration: media && Number.isFinite(media.duration) ? media.duration : null
    };

    if (host.includes('music.youtube.com')) {
      hints.track = textFrom('.title.ytmusic-player-bar') ||
        textFrom('ytmusic-player-bar .title') ||
        textFrom('yt-formatted-string.title');
      hints.artist = textFrom('.byline.ytmusic-player-bar a') ||
        textFrom('ytmusic-player-bar .byline a');
    } else if (host.includes('youtube.com')) {
      hints.track = textFrom('h1 yt-formatted-string') ||
        textFrom('h1.title') ||
        title.replace(/ - YouTube$/i, '');
    } else if (host.includes('spotify.com')) {
      hints.track = textFrom('[data-testid="context-item-info-title"]') ||
        textFrom('[data-testid="now-playing-widget"] a');
      hints.artist = textFrom('[data-testid="context-item-info-artist"]') ||
        textFrom('[data-testid="now-playing-widget"] span a');
    } else if (host.includes('soundcloud.com')) {
      hints.track = textFrom('.playbackSoundBadge__titleLink') ||
        textFrom('.soundTitle__title');
      hints.artist = textFrom('.playbackSoundBadge__lightLink') ||
        textFrom('.soundTitle__username');
    }

    return hints;
  }

  function textFrom(selector) {
    const node = document.querySelector(selector);
    return node ? node.textContent.trim().replace(/\s+/g, ' ') : '';
  }

  function getMedia() {
    const candidates = [...document.querySelectorAll('video, audio')];
    return candidates.find((item) => Number.isFinite(item.currentTime) && item.duration) ||
      candidates.find((item) => Number.isFinite(item.currentTime)) ||
      null;
  }

  function startTrack(payload) {
    clearRevealTimers();
    cancelLoop();
    stage.textContent = '';

    const track = payload.track || {};
    const lyrics = payload.lyrics || {};
    const synced = parseLrc(lyrics.synced || '');
    const plain = lyrics.plain
      ? lyrics.plain.split(/\n+/).map((line) => line.trim()).filter(Boolean)
      : [];

    const prepared = prepareLines(synced.length ? synced : fakeTimedLyrics(plain));
    const title = [track.artist, track.title].filter(Boolean).join(' - ') || 'Song found';

    state.active = true;
    state.lines = prepared;
    state.currentIndex = -1;
    state.currentMoment = null;
    state.trackTitle = title;
    state.lyricSource = synced.length ? 'synced' : 'plain fallback';
    // Adaptive offset: slow songs need lyrics to appear earlier to feel in sync
    state.syncOffsetMs = computeAdaptiveSyncOffset(prepared);

    const media = getMedia();
    const mediaNow = media && Number.isFinite(media.currentTime)
      ? media.currentTime * 1000
      : Number(track.playOffsetMs || 0);
    state.fallbackMediaStartMs = mediaNow;
    state.fallbackStartMs = performance.now();

    if (!state.lines.length) {
      setHud('Song found, but no lyrics were returned.', true, true);
      return;
    }

    show();
    root.classList.add('lvx-active');
    setHud(`${title} / ${state.lyricSource} / offset ${formatOffset(state.syncOffsetMs)}`);
    startLoop();
  }

  function parseLrc(raw) {
    const lines = [];
    String(raw || '').split(/\n+/).forEach((line) => {
      const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
      if (!matches.length) return;

      const text = line.replace(/\[[^\]]+\]/g, '').trim();
      if (!text) return;

      matches.forEach((match) => {
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);
        const fraction = match[3] ? Number(match[3].padEnd(3, '0').slice(0, 3)) : 0;
        lines.push({
          time: minutes * 60000 + seconds * 1000 + fraction,
          text
        });
      });
    });
    return lines.sort((a, b) => a.time - b.time);
  }

  function computeAdaptiveSyncOffset(lines) {
    if (lines.length < 2) return DEFAULT_SYNC_OFFSET_MS;
    // Measure average gap between lines (excluding outlier long pauses > 8s)
    const gaps = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const g = lines[i + 1].time - lines[i].time;
      if (g < 8000) gaps.push(g);
    }
    if (!gaps.length) return DEFAULT_SYNC_OFFSET_MS;
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    // LRC databases timestamp when the word is ALREADY being sung.
    // We need to show text early enough to read it before hearing it.
    // Slow ballads (Sailor Song ~4-5s/line): need the most lead time.
    if (avgGap >= 4200) return -650; // very slow / ballad
    if (avgGap >= 3000) return -480; // slow
    if (avgGap >= 1800) return -280; // mid tempo
    return DEFAULT_SYNC_OFFSET_MS;   // fast / rap: -180ms
  }

  function fakeTimedLyrics(lines) {
    // Space plain lyrics based on typical pop line length:
    // short lines (~4 words) get tighter spacing, longer lines get more room
    return lines.map((text, index) => {
      const wc = text.split(/\s+/).filter(Boolean).length;
      const interval = Math.max(2200, Math.min(wc * 420, 4200));
      const startTime = index === 0 ? 0
        : lines.slice(0, index).reduce((acc, t) => {
            const w = t.split(/\s+/).filter(Boolean).length;
            return acc + Math.max(2200, Math.min(w * 420, 4200));
          }, 0);
      return { time: startTime, text };
    });
  }

  function prepareLines(rawLines) {
    const clean = rawLines
      .map((line) => ({
        time: Number(line.time || 0),
        text: cleanText(line.text || '')
      }))
      .filter((line) => line.text)
      .sort((a, b) => a.time - b.time);

    const counts = new Map();
    clean.forEach((line) => {
      const key = normalize(line.text);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });

    return clean.map((line, index) => {
      const next = clean[index + 1];
      const duration = next ? Math.max(420, next.time - line.time) : 4500;
      const repeated = (counts.get(normalize(line.text)) || 0) > 1;
      const role = classifyLine(line.text, duration, repeated);
      return {
        ...line,
        index,
        nextTime: next ? next.time : line.time + 4500,
        duration,
        repeated,
        role,
        composition: composeMoment(line.text, role, index, repeated)
      };
    });
  }

  function classifyLine(text, duration, repeated) {
    const list = words(text);
    const wc = list.length;
    const lower = normalize(text);
    const first = lower.split(' ')[0] || '';
    const tagLike = TAG_OPENERS.has(first) && wc <= 5;

    if (tagLike) return 'tag';
    if (repeated && wc <= 9) return 'punch';
    if (wc <= 3 || text.length <= 14) return 'punch';
    if (duration <= 1250 && wc <= 6) return 'punch';
    if (/!$/.test(text.trim()) && wc <= 7) return 'punch';
    if (wc >= 8 || /[,;:?]/.test(text) || (SETUP_OPENERS.has(first) && wc >= 5)) return 'mixed';
    return 'main';
  }

  function composeMoment(text, role, index, repeated) {
    const list = words(text);
    const wc = list.length;
    const normalized = cleanText(text);

    if (role === 'tag') {
      return {
        layout: layoutFor(index, 'tag'),
        layers: [{ kind: 'tag', text: normalized }]
      };
    }

    if (role === 'punch' || role === 'main' || wc <= 5) {
      return {
        layout: layoutFor(index, role),
        layers: [{ kind: role === 'punch' || repeated ? 'punch' : 'main', text: normalized }]
      };
    }

    const split = splitForKineticMoment(normalized);
    if (split.support && split.main) {
      const layers = [
        { kind: 'support', text: split.support },
        { kind: repeated ? 'punch' : 'main', text: split.main }
      ];
      if (split.tag) layers.push({ kind: 'tag', text: split.tag });
      return {
        layout: layoutFor(index, 'mixed'),
        layers
      };
    }

    return {
      layout: layoutFor(index, 'main'),
      layers: [{ kind: 'main', text: normalized }]
    };
  }

  function splitForKineticMoment(text) {
    const cleaned = cleanText(text);
    const hardSplit = cleaned.match(/^(.+?)([,;:]|\s+-\s+|\s+but\s+|\s+and\s+)(.+)$/i);
    if (hardSplit) {
      const head = cleanText(`${hardSplit[1]}${hardSplit[2].trim().match(/but|and/i) ? ` ${hardSplit[2].trim()}` : hardSplit[2]}`);
      const tail = cleanText(hardSplit[3]);
      if (words(tail).length >= 2 && words(tail).length <= 7) {
        return {
          support: trimWords(head, 9),
          main: tail,
          tag: ''
        };
      }
      if (words(tail).length > 7) {
        return {
          support: trimWords(head, 8),
          main: tailWords(tail, 5),
          tag: ''
        };
      }
    }

    const list = words(cleaned);
    if (list.length >= 8) {
      const mainCount = list.length >= 12 ? 5 : 4;
      const support = list.slice(0, Math.max(3, list.length - mainCount)).join(' ');
      const main = list.slice(-mainCount).join(' ');
      return {
        support: trimWords(support, 8),
        main,
        tag: ''
      };
    }

    return { support: '', main: cleaned, tag: '' };
  }

  function layoutFor(index, role) {
    // Use a simple hash so layouts don't cycle predictably (not just index % n)
    const h = ((index + 1) * 2654435761) >>> 0;

    const mixedLayouts = [
      'lvx-layout-ref-a',   'lvx-layout-ref-b',   'lvx-layout-ref-c',
      'lvx-layout-diag-a',  'lvx-layout-diag-b',  'lvx-layout-split-v',
      'lvx-layout-asymm-l', 'lvx-layout-asymm-r',
    ];
    const mainLayouts = [
      'lvx-layout-center',     'lvx-layout-left',    'lvx-layout-low',
      'lvx-layout-corner-tl',  'lvx-layout-corner-br',
      'lvx-layout-edge-r',     'lvx-layout-high',
    ];
    const punchLayouts = [
      'lvx-layout-center',    'lvx-layout-wide',    'lvx-layout-hero',
      'lvx-layout-corner-tl', 'lvx-layout-left',    'lvx-layout-corner-br',
    ];

    if (role === 'mixed') return mixedLayouts[h % mixedLayouts.length];
    if (role === 'tag')   return 'lvx-layout-tag';
    if (role === 'punch') return punchLayouts[h % punchLayouts.length];
    return mainLayouts[h % mainLayouts.length];
  }

  function startLoop() {
    cancelLoop();

    function tick() {
      if (!state.active) return;

      const mediaMs = getMediaTimeMs();
      const lyricClockMs = mediaMs - state.syncOffsetMs;
      const nextIndex = findActiveIndex(lyricClockMs);

      if (nextIndex !== state.currentIndex) {
        renderIndex(nextIndex, lyricClockMs);
      } else if (nextIndex >= 0) {
        const line = state.lines[nextIndex];
        if (state.currentMoment && shouldClearLine(line, lyricClockMs)) {
          clearMoment();
        } else if (!state.currentMoment && !shouldClearLine(line, lyricClockMs)) {
          renderIndex(nextIndex, lyricClockMs);
        }
      }

      state.rafId = requestAnimationFrame(tick);
    }

    state.rafId = requestAnimationFrame(tick);
  }

  function cancelLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }

  function getMediaTimeMs() {
    const media = getMedia();
    if (media && Number.isFinite(media.currentTime)) {
      return media.currentTime * 1000;
    }
    return state.fallbackMediaStartMs + performance.now() - state.fallbackStartMs;
  }

  function findActiveIndex(clockMs) {
    const lines = state.lines;
    if (!lines.length || clockMs < lines[0].time - 500) return -1;

    let low = 0;
    let high = lines.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lines[mid].time <= clockMs) low = mid + 1;
      else high = mid - 1;
    }

    return Math.max(0, high);
  }

  function shouldClearLine(line, clockMs) {
    if (!line) return true;
    // Hold until 120ms before the next line starts (no arbitrary upper cap).
    // Floor at 1000ms so very short lines don't vanish instantly.
    const hold = Math.max(line.duration - 120, 1000);
    return clockMs > line.time + hold && line.nextTime - line.time > hold + 300;
  }

  function renderIndex(index, clockMs) {
    clearMoment();
    state.currentIndex = index;

    if (index < 0) return;
    const line = state.lines[index];
    if (!line || shouldClearLine(line, clockMs)) return;

    const moment = document.createElement('div');
    moment.className = `lvx-moment lvx-role-${line.role} ${line.composition.layout}`;

    const revealQueue = [];
    line.composition.layers.forEach((layer) => {
      revealQueue.push(...addTextLayer(moment, layer.text, layer.kind));
    });

    stage.appendChild(moment);
    fitMoment(moment);
    state.currentMoment = moment;
    revealWords(revealQueue, line);
    pulse();
  }

  function addTextLayer(moment, text, kind) {
    const layer = document.createElement('div');
    layer.className = `lvx-text lvx-${kind}`;
    layer.style.fontSize = `${estimateFontSize(text, kind)}px`;

    const spans = [];
    splitRows(text, kind).forEach((row) => {
      const rowEl = document.createElement('span');
      rowEl.className = 'lvx-word-row';
      row.forEach((word) => {
        const span = document.createElement('span');
        span.className = 'lvx-word';
        span.textContent = word.toUpperCase();
        spans.push(span);
        rowEl.appendChild(span);
      });
      layer.appendChild(rowEl);
    });

    moment.appendChild(layer);
    return spans;
  }

  function revealWords(spans, line) {
    const total = spans.length;
    if (!total) return;

    // Scale reveal window to actual line duration so slow songs breathe naturally.
    // Fast rap: duration ~600ms → window ~430ms (snappy)
    // Mid tempo: duration ~2000ms → window ~1440ms
    // Slow ballad: duration ~5000ms → window ~3200ms
    const revealWindow = clamp(line.duration * 0.72, 600, 3800);
    const step = total <= 3
      ? clamp(revealWindow / Math.max(1, total), 100, 380)
      : clamp(revealWindow / Math.max(1, total - 1), 70, 300);

    spans.forEach((span, index) => {
      state.revealTimers.push(setTimeout(() => span.classList.add('lvx-in'), 35 + index * step));
    });
  }

  function clearMoment() {
    clearRevealTimers();
    if (!state.currentMoment) return;

    const old = state.currentMoment;
    state.currentMoment = null;
    old.classList.add('lvx-out');
    setTimeout(() => old.remove(), 190);
  }

  function clearRevealTimers() {
    state.revealTimers.forEach(clearTimeout);
    state.revealTimers = [];
  }

  function splitRows(text, kind) {
    const list = words(text);
    if (list.length <= 1) return list.length ? [list] : [];

    const joined = list.join(' ');
    let rowCount = 1;
    if (kind === 'support') {
      rowCount = joined.length > 34 || list.length > 6 ? 2 : 1;
    } else if (kind === 'tag') {
      rowCount = joined.length > 18 || list.length > 4 ? 2 : 1;
    } else if (joined.length > 42 || list.length > 8) {
      rowCount = 3;
    } else if (joined.length > 17 || list.length > 4) {
      rowCount = 2;
    }

    rowCount = clamp(rowCount, 1, Math.min(3, list.length));
    const rows = [];
    let index = 0;
    for (let row = 0; row < rowCount; row++) {
      const remainingRows = rowCount - row;
      const remainingWords = list.length - index;
      const take = Math.ceil(remainingWords / remainingRows);
      rows.push(list.slice(index, index + take));
      index += take;
    }
    return rows;
  }

  function estimateFontSize(text, kind) {
    const length = String(text || '').length;
    const wc = words(text).length;

    if (kind === 'support') {
      if (length <= 18) return 62;
      if (length <= 36) return 54;
      return 46;
    }

    if (kind === 'tag') {
      return length <= 16 ? 72 : 60;
    }

    if (kind === 'punch') {
      if (wc <= 2 || length <= 10) return 166;
      if (length <= 22) return 148;
      if (length <= 40) return 118;
      return 94;
    }

    if (length <= 12) return 150;
    if (length <= 24) return 126;
    if (length <= 42) return 100;
    return 82;
  }

  function fitMoment(moment) {
    [...moment.querySelectorAll('.lvx-text')].forEach((layer) => fitLayer(layer));
  }

  function fitLayer(layer) {
    let size = parseFloat(layer.style.fontSize) || 82;
    const minSize = layer.classList.contains('lvx-support') ? 26 : 36;
    const maxHeight = parseFloat(getComputedStyle(layer).maxHeight) || window.innerHeight * 0.42;

    for (let i = 0; i < 36; i++) {
      const box = layer.getBoundingClientRect();
      const parentWidth = layer.clientWidth || box.width;
      if (layer.scrollWidth <= parentWidth + 2 && layer.scrollHeight <= maxHeight + 2) break;
      size -= 3;
      if (size <= minSize) {
        size = minSize;
        break;
      }
      layer.style.fontSize = `${size}px`;
    }
  }

  function handleKeys(event) {
    if (!state.active) return;
    const target = event.target;
    const tagName = target && target.tagName ? target.tagName.toLowerCase() : '';
    if (tagName === 'input' || tagName === 'textarea' || target.isContentEditable) return;

    if (event.key === 't' || event.key === 'T') {
      event.preventDefault();
      cycleTheme();
    }

    if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      state.syncOffsetMs += event.key === '[' ? -SYNC_NUDGE_MS : SYNC_NUDGE_MS;
      setHud(`Sync offset ${formatOffset(state.syncOffsetMs)}  ([ earlier / ] later)`);
      state.currentIndex = -999;
    }

    if (event.key === 'Escape') {
      chrome.runtime.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {});
      teardown();
    }
  }

  function pulse() {
    stage.classList.remove('lvx-hit');
    void stage.offsetWidth;
    stage.classList.add('lvx-hit');
    setTimeout(() => stage.classList.remove('lvx-hit'), 150);
  }

  function applyTheme(name) {
    state.theme = name;
    if (name === 'samay') {
      root.removeAttribute('data-lvx-theme');
    } else {
      root.setAttribute('data-lvx-theme', name);
    }
    themeButton.textContent = THEME_LABELS[name] || name.toUpperCase();
    try {
      chrome.storage.local.set({ lvxTheme: name });
    } catch (_) {}
  }

  function cycleTheme() {
    const idx = THEMES.indexOf(state.theme);
    const next = THEMES[(idx + 1) % THEMES.length];
    applyTheme(next);
    setHud(`Theme: ${THEME_LABELS[next]}  (T to cycle)`, false, false);
  }

  function teardown() {
    clearRevealTimers();
    cancelLoop();
    state.active = false;
    state.currentIndex = -1;
    state.currentMoment = null;
    root.classList.remove('lvx-active');
    stage.textContent = '';
    root.remove();
  }

  function show() {
    if (!root.isConnected) {
      root.append(stage, hud);
      document.documentElement.appendChild(root);
    }
  }

  function setHud(text, isError = false, sticky = false) {
    show();
    hud.classList.toggle('lvx-error', isError);
    hud.classList.remove('lvx-dim');
    hudLabel.textContent = isError ? 'LYRICVIBE ERROR' : 'LYRICVIBE';
    hudText.textContent = text;
    clearTimeout(state.hudTimer);
    if (!sticky) {
      state.hudTimer = setTimeout(() => hud.classList.add('lvx-dim'), 3400);
    }
  }

  function trimWords(text, maxWords) {
    const list = words(text);
    if (list.length <= maxWords) return cleanText(text);
    return list.slice(0, maxWords).join(' ');
  }

  function tailWords(text, count) {
    return words(text).slice(-count).join(' ');
  }

  function formatOffset(ms) {
    return `${ms > 0 ? '+' : ''}${Math.round(ms)}ms`;
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\u200b/g, '')
      .trim();
  }

  function normalize(text) {
    return cleanText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function words(text) {
    return cleanText(text).split(/\s+/).filter(Boolean);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
