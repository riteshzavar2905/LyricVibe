(function initLyricVibeOverlay() {
  /* ══════════════════════════════════════
     CONSTANTS & CONFIG
     ══════════════════════════════════════ */
  const DEFAULT_SYNC_OFFSET_MS = -200;
  const SYNC_NUDGE_MS = 80;
  const THEMES = ['samay', 'hype', 'soft', 'neon', 'clean', 'retro', 'glass', 'fire', 'elegant', 'aurora', 'matrix', 'vinyl', 'cosmic', 'chaos'];
  const THEME_LABELS = {
    samay: 'SAMAY', hype: 'HYPE', soft: 'SOFT', neon: 'NEON',
    clean: 'CLEAN', retro: 'RETRO', glass: 'GLASS', fire: 'FIRE', elegant: 'ELEGANT',
    aurora: 'AURORA', matrix: 'MATRIX', vinyl: 'VINYL', cosmic: 'COSMIC', chaos: 'CHAOS'
  };
  const ANIMATIONS = ['slam', 'fade-up', 'scale-pop', 'slide-left', 'slide-right', 'blur-in', 'glitch', 'typewriter', 'shatter', 'wave'];

  const SETUP_OPENERS = new Set([
    'after', 'although', 'and', 'as', 'before', 'because', 'but', 'even',
    'if', 'i', 'just', 'maybe', 'my', 'now', 'once', 'she', 'since', 'so',
    'still', 'that', 'the', 'then', 'they', 'though', 'till', 'until',
    'when', 'while', 'with', 'you'
  ]);
  const TAG_OPENERS = new Set(['is', 'are', 'was', 'were', 'not', 'no', 'never', 'only', 'all']);

  /* If overlay already exists, just show it */
  if (window.__lyricVibeOverlay && window.__lyricVibeOverlay.show) {
    window.__lyricVibeOverlay.show();
    return;
  }

  /* ══════════════════════════════════════
     STATE
     ══════════════════════════════════════ */
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
    theme: 'samay',
    // Sync tracking for auto-adjustment
    lastMediaTime: 0,
    lastWallTime: 0,
    mediaDriftSamples: [],
    playbackRate: 1,
    // Spotify-specific: polling for time from DOM
    spotifyPollInterval: 0,
    spotifyCurrentTimeMs: 0,
    spotifyLastPollWall: 0,
    isSpotify: false
  };

  /* ══════════════════════════════════════
     DOM CONSTRUCTION
     ══════════════════════════════════════ */
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
  stopButton.textContent = '✕';
  stopButton.title = 'Stop LyricVibe (Esc)';
  stopButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {});
    teardown();
  });

  const themeButton = document.createElement('button');
  themeButton.className = 'lvx-theme-btn';
  themeButton.textContent = 'SAMAY';
  themeButton.title = 'Cycle theme (T)';
  themeButton.addEventListener('click', () => cycleTheme());

  const syncEarlier = document.createElement('button');
  syncEarlier.className = 'lvx-sync-btn';
  syncEarlier.textContent = '[ ←';
  syncEarlier.title = 'Lyrics earlier ([)';
  syncEarlier.addEventListener('click', () => nudgeSync(-SYNC_NUDGE_MS));

  const syncLater = document.createElement('button');
  syncLater.className = 'lvx-sync-btn';
  syncLater.textContent = '→ ]';
  syncLater.title = 'Lyrics later (])';
  syncLater.addEventListener('click', () => nudgeSync(SYNC_NUDGE_MS));

  hud.append(hudLabel, hudText, syncEarlier, syncLater, themeButton, stopButton);
  root.append(stage, hud);
  document.documentElement.appendChild(root);

  window.__lyricVibeOverlay = {
    show,
    hide: teardown,
    hints: getPageHints
  };

  setHud('Ready. Play music, then click LyricVibe.', false, true);

  /* Load saved theme */
  try {
    chrome.storage.local.get('lvxTheme', (result) => {
      if (result && result.lvxTheme && THEMES.includes(result.lvxTheme)) {
        applyTheme(result.lvxTheme);
      }
    });
  } catch (_) {}

  /* Detect if we're on Spotify */
  state.isSpotify = location.hostname.includes('spotify.com');

  /* Spotify track-change observer: auto-refresh when song changes */
  if (state.isSpotify) {
    setupSpotifyTrackObserver();
  }

  /* ══════════════════════════════════════
     MESSAGE LISTENER
     ══════════════════════════════════════ */
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

  /* ══════════════════════════════════════
     PAGE HINTS (works for YT, Spotify, SC, etc.)
     ══════════════════════════════════════ */
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
      /* ── SPOTIFY ENHANCED SELECTORS (2026) ── */
      // Try multiple selectors — Spotify's DOM changes frequently
      hints.track =
        textFrom('[data-testid="context-item-info-title"]') ||
        textFrom('[data-testid="now-playing-widget"] [data-testid="context-item-info-title"]') ||
        textFrom('[data-testid="context-item-link"] [dir="auto"]') ||
        textFrom('[data-testid="now-playing-widget"] a[data-testid="context-item-link"]') ||
        textFrom('.now-playing .track-info__name a') ||
        textFrom('.player-controls__left .track-info__name') ||
        textFrom('[data-testid="CoverSlotExpanded__container"] a') ||
        spotifyTrackFromNowPlaying() ||
        spotifyTrackFromFooter() ||
        '';
      hints.artist =
        textFrom('[data-testid="context-item-info-subtitles"]') ||
        textFrom('[data-testid="context-item-info-artist"]') ||
        textFrom('[data-testid="now-playing-widget"] span a[href*="/artist/"]') ||
        textFrom('.now-playing .track-info__artists a') ||
        textFrom('.player-controls__left .track-info__artists a') ||
        spotifyArtistFromNowPlaying() ||
        spotifyArtistFromFooter() ||
        '';
      // Spotify time from DOM (no <audio>/<video> element exposed)
      const spotifyTime = getSpotifyCurrentTimeFromDom();
      if (spotifyTime !== null) {
        hints.currentTime = spotifyTime / 1000;
      }
      const spotifyDuration = getSpotifyDurationFromDom();
      if (spotifyDuration !== null) {
        hints.duration = spotifyDuration / 1000;
      }
    } else if (host.includes('soundcloud.com')) {
      hints.track = textFrom('.playbackSoundBadge__titleLink') ||
        textFrom('.soundTitle__title');
      hints.artist = textFrom('.playbackSoundBadge__lightLink') ||
        textFrom('.soundTitle__username');
    }

    return hints;
  }

  /* ── Spotify-specific DOM scraping helpers ── */
  function spotifyTrackFromNowPlaying() {
    // Fallback: grab the first <a> inside the now-playing widget
    const widget = document.querySelector('[data-testid="now-playing-widget"]');
    if (!widget) return '';
    const links = widget.querySelectorAll('a');
    for (const link of links) {
      const text = link.textContent.trim();
      if (text && text.length > 1 && !link.href.includes('/artist/')) return text;
    }
    return '';
  }

  function spotifyTrackFromFooter() {
    // Fallback: try the footer/bottom bar area
    const footer = document.querySelector('footer') || document.querySelector('[data-testid="now-playing-bar"]');
    if (!footer) return '';
    const links = footer.querySelectorAll('a');
    for (const link of links) {
      const text = link.textContent.trim();
      if (text && text.length > 1 && !link.href.includes('/artist/') && link.href.includes('/track/')) return text;
    }
    // Try any link with album/track path
    for (const link of links) {
      const text = link.textContent.trim();
      if (text && text.length > 1 && !link.href.includes('/artist/')) return text;
    }
    return '';
  }

  function spotifyArtistFromNowPlaying() {
    const widget = document.querySelector('[data-testid="now-playing-widget"]');
    if (!widget) return '';
    const links = widget.querySelectorAll('a');
    for (const link of links) {
      if (link.href && link.href.includes('/artist/')) return link.textContent.trim();
    }
    return '';
  }

  function spotifyArtistFromFooter() {
    const footer = document.querySelector('footer') || document.querySelector('[data-testid="now-playing-bar"]');
    if (!footer) return '';
    const links = footer.querySelectorAll('a');
    for (const link of links) {
      if (link.href && link.href.includes('/artist/')) return link.textContent.trim();
    }
    return '';
  }

  function getSpotifyCurrentTimeFromDom() {
    // Spotify shows current time as text like "1:23"
    const el = document.querySelector('[data-testid="playback-position"]') ||
               document.querySelector('.playback-bar__progress-time-elapsed') ||
               document.querySelector('.playback-bar [data-testid="playback-position"]') ||
               document.querySelector('[data-testid="progress-bar"] [data-testid="playback-position"]');
    if (el) {
      const ms = parseTimeString(el.textContent);
      if (ms !== null) return ms;
    }
    // Alternative: look for aria-valuenow on the progress bar
    const bar = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]') ||
                document.querySelector('.playback-bar input[type="range"]') ||
                document.querySelector('[data-testid="progress-bar"] input[type="range"]');
    if (bar) {
      const val = parseFloat(bar.value);
      const max = parseFloat(bar.max);
      if (Number.isFinite(val) && Number.isFinite(max) && max > 0) {
        return val; // Sometimes value is already in ms or seconds
      }
    }
    // Last resort: check for any time-display element in the footer
    const footerTimes = document.querySelectorAll('footer [class*="playback"] span, [data-testid="now-playing-bar"] span');
    for (const span of footerTimes) {
      const ms = parseTimeString(span.textContent);
      if (ms !== null) return ms;
    }
    return null;
  }

  function getSpotifyDurationFromDom() {
    const el = document.querySelector('[data-testid="playback-duration"]') ||
               document.querySelector('.playback-bar__progress-time-total') ||
               document.querySelector('.playback-bar [data-testid="playback-duration"]');
    if (el) {
      return parseTimeString(el.textContent);
    }
    return null;
  }

  function parseTimeString(str) {
    if (!str) return null;
    const clean = str.trim();
    // Formats: "1:23", "01:23", "1:02:03"
    const parts = clean.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    return null;
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

  /* ══════════════════════════════════════
     SPOTIFY TIME POLLING
     (Spotify doesn't expose <audio>, so we poll the DOM progress bar)
     ══════════════════════════════════════ */
  function startSpotifyPolling() {
    stopSpotifyPolling();
    if (!state.isSpotify) return;

    state.spotifyPollInterval = setInterval(() => {
      const ms = getSpotifyCurrentTimeFromDom();
      if (ms !== null) {
        state.spotifyCurrentTimeMs = ms;
        state.spotifyLastPollWall = performance.now();
      }
    }, 150); // Poll ~7x per second for tighter sync interpolation
  }

  function stopSpotifyPolling() {
    if (state.spotifyPollInterval) {
      clearInterval(state.spotifyPollInterval);
      state.spotifyPollInterval = 0;
    }
  }

  /* ══════════════════════════════════════
     SPOTIFY TRACK CHANGE OBSERVER
     Watches for track title changes and auto-refreshes lyrics
     ══════════════════════════════════════ */
  function setupSpotifyTrackObserver() {
    let lastTrackText = '';
    const checkTrackChange = () => {
      const hints = getPageHints();
      const currentTrack = hints.track || '';
      if (currentTrack && currentTrack !== lastTrackText && state.active) {
        lastTrackText = currentTrack;
        // Notify service worker to re-detect lyrics for the new track
        try {
          chrome.runtime.sendMessage({
            type: 'LV_CONTENT_STOP'
          }).catch(() => {});
          // Small delay then request fresh detection
          setTimeout(() => {
            chrome.runtime.sendMessage({
              type: 'LV_SPOTIFY_TRACK_CHANGED'
            }).catch(() => {});
          }, 800);
        } catch (_) {}
      } else if (currentTrack && !lastTrackText) {
        lastTrackText = currentTrack;
      }
    };

    // Observe changes in the now-playing widget area
    const targetNode = document.querySelector('[data-testid="now-playing-widget"]') ||
                       document.querySelector('footer') ||
                       document.body;
    if (targetNode) {
      const observer = new MutationObserver(() => {
        checkTrackChange();
      });
      observer.observe(targetNode, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    // Also poll periodically as a fallback
    setInterval(checkTrackChange, 3000);
  }

  /* ══════════════════════════════════════
     TRACK START
     ══════════════════════════════════════ */
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
    const title = [track.artist, track.title].filter(Boolean).join(' — ') || 'Song found';

    state.active = true;
    state.lines = prepared;
    state.currentIndex = -1;
    state.currentMoment = null;
    state.trackTitle = title;
    state.lyricSource = synced.length ? 'synced' : 'plain fallback';
    state.syncOffsetMs = computeAdaptiveSyncOffset(prepared);
    state.mediaDriftSamples = [];
    state.playbackRate = 1;

    const media = getMedia();
    let mediaNow;
    if (state.isSpotify) {
      const spotMs = getSpotifyCurrentTimeFromDom();
      mediaNow = spotMs !== null ? spotMs : Number(track.playOffsetMs || 0);
      state.spotifyCurrentTimeMs = mediaNow;
      state.spotifyLastPollWall = performance.now();
      startSpotifyPolling();
    } else {
      mediaNow = media && Number.isFinite(media.currentTime)
        ? media.currentTime * 1000
        : Number(track.playOffsetMs || 0);
    }

    state.fallbackMediaStartMs = mediaNow;
    state.fallbackStartMs = performance.now();
    state.lastMediaTime = mediaNow;
    state.lastWallTime = performance.now();

    if (!state.lines.length) {
      setHud('Song found, but no lyrics were returned.', true, true);
      return;
    }

    show();
    root.classList.add('lvx-active');
    setHud(`${title} · ${state.lyricSource} · offset ${formatOffset(state.syncOffsetMs)}`);
    startLoop();
  }

  /* ══════════════════════════════════════
     LRC PARSER
     ══════════════════════════════════════ */
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

    const gaps = [];
    let totalWords = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      const g = lines[i + 1].time - lines[i].time;
      if (g > 200 && g < 8000) gaps.push(g);
      totalWords += (lines[i].text || '').split(/\s+/).filter(Boolean).length;
    }
    totalWords += (lines[lines.length - 1].text || '').split(/\s+/).filter(Boolean).length;
    if (!gaps.length) return DEFAULT_SYNC_OFFSET_MS;

    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const avgWordsPerLine = totalWords / lines.length;
    const songDuration = lines[lines.length - 1].time - lines[0].time;
    const linesPerMinute = songDuration > 0 ? (lines.length / (songDuration / 60000)) : 15;

    // Smart genre-like detection based on lyric patterns:
    // - High linesPerMinute + high avgWords = rap/hip-hop → tighter offset
    // - Low linesPerMinute + low avgWords = ballad → wider offset
    // - Medium = pop/rock → balanced

    let offset = DEFAULT_SYNC_OFFSET_MS; // -200ms base

    // Tempo-based (from gap analysis)
    if (avgGap >= 4200) offset = -350;       // very slow ballad
    else if (avgGap >= 3000) offset = -280;   // slow
    else if (avgGap >= 2200) offset = -220;   // mid-slow
    else if (avgGap >= 1400) offset = -180;   // mid-fast
    else offset = -150;                       // rapid-fire/rap

    // Word density adjustment: dense lines need earlier reveal
    if (avgWordsPerLine > 8) offset -= 40;    // long sentences — show earlier
    else if (avgWordsPerLine < 3) offset += 30; // short phrases — can delay slightly

    // Lines-per-minute adjustment
    if (linesPerMinute > 25) offset -= 30;    // fast song
    else if (linesPerMinute < 8) offset += 40; // very slow song

    // Clamp to reasonable range
    return Math.max(-500, Math.min(-80, offset));
  }

  function fakeTimedLyrics(lines) {
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

  /* ══════════════════════════════════════
     LINE PREPARATION
     ══════════════════════════════════════ */
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
        composition: composeMoment(line.text, role, index, repeated),
        animation: pickAnimation(index)
      };
    });
  }

  function pickAnimation(index) {
    const h = ((index + 1) * 2654435761) >>> 0;
    return ANIMATIONS[h % ANIMATIONS.length];
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
        return { support: trimWords(head, 9), main: tail, tag: '' };
      }
      if (words(tail).length > 7) {
        return { support: trimWords(head, 8), main: tailWords(tail, 5), tag: '' };
      }
    }

    const list = words(cleaned);
    if (list.length >= 8) {
      const mainCount = list.length >= 12 ? 5 : 4;
      const support = list.slice(0, Math.max(3, list.length - mainCount)).join(' ');
      const main = list.slice(-mainCount).join(' ');
      return { support: trimWords(support, 8), main, tag: '' };
    }

    return { support: '', main: cleaned, tag: '' };
  }

  /* ══════════════════════════════════════
     LAYOUT SELECTOR (expanded with new layouts)
     ══════════════════════════════════════ */
  function layoutFor(index, role) {
    const h = ((index + 1) * 2654435761) >>> 0;

    const mixedLayouts = [
      'lvx-layout-ref-a',     'lvx-layout-ref-b',     'lvx-layout-ref-c',
      'lvx-layout-diag-a',    'lvx-layout-diag-b',    'lvx-layout-split-v',
      'lvx-layout-asymm-l',   'lvx-layout-asymm-r',   'lvx-layout-cinema',
      'lvx-layout-stack',     'lvx-layout-typewriter', 'lvx-layout-widescreen',
      'lvx-layout-drift',     'lvx-layout-scatter',    'lvx-layout-cascade',
    ];
    const mainLayouts = [
      'lvx-layout-center',      'lvx-layout-left',       'lvx-layout-low',
      'lvx-layout-corner-tl',   'lvx-layout-corner-br',  'lvx-layout-edge-r',
      'lvx-layout-high',        'lvx-layout-edge-l',     'lvx-layout-typewriter',
      'lvx-layout-spotlight',   'lvx-layout-widescreen', 'lvx-layout-whisper',
      'lvx-layout-drift',       'lvx-layout-cascade',
    ];
    const punchLayouts = [
      'lvx-layout-center',     'lvx-layout-wide',       'lvx-layout-hero',
      'lvx-layout-corner-tl',  'lvx-layout-left',       'lvx-layout-corner-br',
      'lvx-layout-stadium',    'lvx-layout-cinema',     'lvx-layout-spotlight',
      'lvx-layout-scatter',    'lvx-layout-drift',
    ];

    if (role === 'mixed') return mixedLayouts[h % mixedLayouts.length];
    if (role === 'tag')   return 'lvx-layout-tag';
    if (role === 'punch') return punchLayouts[h % punchLayouts.length];
    return mainLayouts[h % mainLayouts.length];
  }

  /* ══════════════════════════════════════
     MAIN PLAYBACK LOOP (improved sync)
     ══════════════════════════════════════ */
  function startLoop() {
    cancelLoop();

    function tick() {
      if (!state.active) return;

      const mediaMs = getMediaTimeMs();
      updateDriftTracking(mediaMs);
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

  /* ══════════════════════════════════════
     MEDIA TIME (supports Spotify DOM polling + standard)
     ══════════════════════════════════════ */
  function getMediaTimeMs() {
    // 1) Standard <video>/<audio> element (YouTube, SoundCloud, etc.)
    const media = getMedia();
    if (media && Number.isFinite(media.currentTime) && media.duration > 0) {
      state.playbackRate = media.playbackRate || 1;
      return media.currentTime * 1000;
    }

    // 2) Spotify: interpolate from last DOM poll
    if (state.isSpotify && state.spotifyLastPollWall > 0) {
      const wallElapsed = performance.now() - state.spotifyLastPollWall;
      // Interpolate: assume 1x playback between polls
      return state.spotifyCurrentTimeMs + wallElapsed;
    }

    // 3) Pure fallback (no media element found)
    return state.fallbackMediaStartMs + (performance.now() - state.fallbackStartMs);
  }

  /* ── Drift tracking for auto-adjustment (improved) ── */
  function updateDriftTracking(mediaMs) {
    const now = performance.now();
    if (state.lastWallTime > 0) {
      const wallDelta = now - state.lastWallTime;
      const mediaDelta = mediaMs - state.lastMediaTime;

      // Only track when both are moving forward normally
      if (wallDelta > 30 && wallDelta < 2000 && mediaDelta > 0 && mediaDelta < 2000) {
        const drift = mediaDelta - wallDelta; // positive = media running fast
        state.mediaDriftSamples.push(drift);
        if (state.mediaDriftSamples.length > 15) state.mediaDriftSamples.shift();

        // Start adjusting earlier (5 samples) and more aggressively
        if (state.mediaDriftSamples.length >= 5) {
          const avgDrift = state.mediaDriftSamples.reduce((a, b) => a + b, 0) / state.mediaDriftSamples.length;
          if (Math.abs(avgDrift) > 35) {
            // More aggressive compensation factor (0.5 vs 0.3)
            state.syncOffsetMs -= avgDrift * 0.5;
            state.mediaDriftSamples = [];
          }
        }
      }
    }
    state.lastMediaTime = mediaMs;
    state.lastWallTime = now;
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
    const hold = Math.max(line.duration - 120, 1000);
    return clockMs > line.time + hold && line.nextTime - line.time > hold + 300;
  }

  /* ══════════════════════════════════════
     RENDERING
     ══════════════════════════════════════ */
  function renderIndex(index, clockMs) {
    if (state.theme === 'chaos') { renderChaosIndex(index, clockMs); return; }
    clearMoment();
    state.currentIndex = index;

    if (index < 0) return;
    const line = state.lines[index];
    if (!line || shouldClearLine(line, clockMs)) return;

    const moment = document.createElement('div');
    const animClass = line.animation === 'slam' ? '' : `lvx-anim-${line.animation}`;
    moment.className = `lvx-moment lvx-role-${line.role} ${line.composition.layout} ${animClass}`.trim();

    const revealQueue = [];
    line.composition.layers.forEach((layer) => {
      revealQueue.push(...addTextLayer(moment, layer.text, layer.kind));
    });

    stage.appendChild(moment);
    fitMoment(moment);
    state.currentMoment = moment;
    revealWords(revealQueue, line);
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

    // Determine reveal strategy based on line characteristics
    const wordCount = total;
    const duration = line.duration || 3000;
    const wordsPerSec = wordCount / (duration / 1000);

    let step;

    if (wordCount <= 2) {
      // Very short line: reveal almost instantly
      step = 60;
    } else if (wordsPerSec > 4) {
      // Rap / fast sections: rapid but visible stagger
      step = clamp(duration * 0.5 / (wordCount - 1), 30, 80);
    } else if (wordsPerSec > 2) {
      // Normal pop/rock tempo: clear word-by-word reveal
      step = clamp(duration * 0.55 / (wordCount - 1), 60, 180);
    } else {
      // Slow ballad: spacious word-by-word with breathing room
      step = clamp(duration * 0.6 / (wordCount - 1), 100, 280);
    }

    // Reveal words one by one with visible stagger
    spans.forEach((span, index) => {
      state.revealTimers.push(setTimeout(() => span.classList.add('lvx-in'), 15 + index * step));
    });
  }

  function clearMoment() {
    if (state.theme === 'chaos') return;
    clearRevealTimers();
    if (!state.currentMoment) return;

    const old = state.currentMoment;
    state.currentMoment = null;
    old.classList.add('lvx-out');
    setTimeout(() => old.remove(), 160);
  }

  function clearRevealTimers() {
    state.revealTimers.forEach(clearTimeout);
    state.revealTimers = [];
  }

  /* ══════════════════════════════════════
     TEXT SIZING & LAYOUT
     ══════════════════════════════════════ */
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

  /* ══════════════════════════════════════
     KEYBOARD CONTROLS
     ══════════════════════════════════════ */
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
      nudgeSync(event.key === '[' ? -SYNC_NUDGE_MS : SYNC_NUDGE_MS);
    }

    if (event.key === 'Escape') {
      chrome.runtime.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {});
      teardown();
    }
  }

  function nudgeSync(deltaMs) {
    state.syncOffsetMs += deltaMs;
    setHud(`Sync offset ${formatOffset(state.syncOffsetMs)}  ([ earlier / ] later)`);
    state.currentIndex = -999; // Force re-render
  }

  function pulse() {
    // Subtle smooth glow — no red flash
    stage.classList.remove('lvx-hit');
    void stage.offsetWidth;
    stage.classList.add('lvx-hit');
    setTimeout(() => stage.classList.remove('lvx-hit'), 300);
  }

  /* ══════════════════════════════════════
     THEME MANAGEMENT
     ══════════════════════════════════════ */
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

  /* ══════════════════════════════════════
     TEARDOWN / SHOW
     ══════════════════════════════════════ */
  function teardown() {
    chaosWordEls.forEach((el) => el.remove());
    chaosWordEls.length = 0;
    chaosUsedCells.clear();
    clearRevealTimers();
    cancelLoop();
    stopSpotifyPolling();
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

  /* ══════════════════════════════════════
     UTILITY HELPERS
     ══════════════════════════════════════ */
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
  /* ══════════════════════════════════════
     CHAOS THEME ENGINE
     ══════════════════════════════════════ */

  (function () {
    if (document.getElementById('lvx-chaos-fonts')) return;
    const link = document.createElement('link');
    link.id   = 'lvx-chaos-fonts';
    link.rel  = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Oswald:wght@700&family=Playfair+Display:wght@900&family=Space+Mono:wght@700&family=Righteous&family=Permanent+Marker&family=Black+Han+Sans&family=Boogaloo&display=swap';
    document.head.appendChild(link);
  })();

  const CHAOS_FONTS = [
    '"Bebas Neue", Impact, sans-serif',
    '"Oswald", "Arial Black", sans-serif',
    '"Playfair Display", Georgia, serif',
    '"Space Mono", "Courier New", monospace',
    '"Righteous", Verdana, sans-serif',
    '"Permanent Marker", cursive',
    '"Black Han Sans", Impact, sans-serif',
    '"Boogaloo", cursive',
    'Impact, "Arial Black", sans-serif',
    '"Arial Black", Impact, sans-serif',
    'Georgia, "Times New Roman", serif',
    '"Courier New", Courier, monospace',
    'Verdana, Geneva, sans-serif',
  ];

  const CHAOS_SENTIMENT = {
    pain:'#e74c3c', hurt:'#c0392b', hate:'#922b21', fear:'#8e44ad',
    alone:'#7d3c98', dark:'#6c3483', die:'#c0392b', cry:'#9b59b6',
    lost:'#8e44ad', broken:'#e74c3c', empty:'#7b241c', dead:'#641e16',
    hell:'#c0392b', tears:'#a569bd', blood:'#e74c3c', cold:'#2980b9',
    numb:'#5d6d7e', scar:'#c0392b', war:'#e74c3c', scream:'#c0392b',
    love:'#f39c12', joy:'#f1c40f', smile:'#f9ca24', happy:'#ffd32a',
    bright:'#ffc312', sun:'#f9ca24', dance:'#ff9f43', free:'#ffeaa7',
    life:'#fdcb6e', light:'#f9ca24', laugh:'#ff9f43', dream:'#a29bfe',
    heart:'#e84393', beautiful:'#fd79a8', heaven:'#74b9ff', gold:'#f9ca24',
    shine:'#ffd32a', sweet:'#ff7675', good:'#55efc4', best:'#ffd32a',
    fire:'#e17055', burn:'#d63031', wild:'#e84393', run:'#00b894',
    fight:'#e17055', power:'#e17055', loud:'#fd79a8', blaze:'#e17055',
    rage:'#d63031', rise:'#fdcb6e', electric:'#74b9ff', rush:'#e17055',
    miss:'#74b9ff', gone:'#636e72', old:'#b2bec3', rain:'#74b9ff',
    wait:'#7f8c8d', still:'#a0a0b0', shadow:'#636e72', ghost:'#9b59b6',
    memory:'#a29bfe', forget:'#636e72', fade:'#b2bec3', gray:'#95a5a6',
  };

  function chaosWordColor(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (CHAOS_SENTIMENT[w]) return CHAOS_SENTIMENT[w];
    let h = 0;
    for (let i = 0; i < w.length; i++) h = w.charCodeAt(i) + ((h << 5) - h);
    return `hsl(${((h >>> 0) % 360)},${55 + ((h >>> 4) % 35)}%,${52 + ((h >>> 8) % 28)}%)`;
  }

  function chaosRand(min, max) { return min + Math.random() * (max - min); }

  const chaosWordEls  = [];
  const chaosUsedCells = new Set(); // occupied grid cell indices

  const CHAOS_COLS = 5;
  const CHAOS_ROWS = 4;  // 5×4 = 20 cells, one word per cell

  function chaosCellRect(col, row) {
    const vw = window.innerWidth;
    const vh = window.innerHeight - 50; // 50px for HUD
    const cellW = vw / CHAOS_COLS;
    const cellH = vh / CHAOS_ROWS;
    return {
      x: col * cellW,
      y: 50 + row * cellH,
      w: cellW,
      h: cellH
    };
  }

  function chaosPickCell() {
    const total = CHAOS_COLS * CHAOS_ROWS;
    const free = [];
    for (let i = 0; i < total; i++) {
      if (!chaosUsedCells.has(i)) free.push(i);
    }
    if (!free.length) {
      // All cells full — clear oldest half
      const keys = [...chaosUsedCells].slice(0, Math.floor(total / 2));
      keys.forEach((k) => chaosUsedCells.delete(k));
      return keys[0] || 0;
    }
    return free[Math.floor(Math.random() * free.length)];
  }

  function renderChaosIndex(index, clockMs) {
    state.currentIndex = index;
    if (index < 0) return;
    const line = state.lines[index];
    if (!line || shouldClearLine(line, clockMs)) return;

    /* Clear any leftover non-chaos moment from previous theme */
    if (state.currentMoment) {
      state.currentMoment.remove();
      state.currentMoment = null;
    }

    if (chaosWordEls.length > 18) {
      const victims = chaosWordEls.splice(0, 8);
      victims.forEach((el) => {
        chaosUsedCells.delete(Number(el.dataset.cell));
        el.style.transition = 'opacity 0.8s ease, filter 0.8s ease';
        el.style.opacity = '0'; el.style.filter = 'blur(6px)';
        setTimeout(() => el.remove(), 900);
      });
    }

    const wordList = words(line.text);
    const stagger  = Math.max(200, Math.min(500, (line.duration * 0.65) / Math.max(1, wordList.length - 1)));
    const holdMs   = Math.max(3000, line.duration * 2.0);

    wordList.forEach((word, i) => {
      state.revealTimers.push(setTimeout(() => {
        if (!state.active || state.theme !== 'chaos') return;

        const cellIdx  = chaosPickCell();
        const cell     = chaosCellRect(cellIdx % CHAOS_COLS, Math.floor(cellIdx / CHAOS_COLS));
        chaosUsedCells.add(cellIdx);

        // Font size fits within cell height, with variation
        const maxFontH = cell.h * 0.72;
        const fontSize = Math.round(chaosRand(maxFontH * 0.45, maxFontH));
        const color    = chaosWordColor(word);

        // Random position within cell with padding
        const pad = 10;
        const x = cell.x + chaosRand(pad, Math.max(pad + 1, cell.w * 0.35));
        const y = cell.y + chaosRand(pad, Math.max(pad + 1, cell.h - fontSize - pad));

        const el = document.createElement('span');
        el.dataset.cell = String(cellIdx);
        el.textContent = word.toUpperCase();
        el.style.cssText = [
          'position:fixed',
          `left:${x}px`, `top:${y}px`,
          `font-family:${CHAOS_FONTS[Math.floor(Math.random() * CHAOS_FONTS.length)]}`,
          `font-size:${fontSize}px`,
          `font-weight:${Math.random() > 0.35 ? '900' : '400'}`,
          `color:${color}`,
          `transform:rotate(${chaosRand(-18, 18).toFixed(1)}deg)`,
          'opacity:0', 'pointer-events:none', 'z-index:2147483640',
          'line-height:1', 'white-space:nowrap',
          `letter-spacing:${chaosRand(-1, 4).toFixed(1)}px`,
          `text-shadow:0 0 ${Math.round(fontSize * 0.25)}px ${color}55,2px 3px 0 rgba(0,0,0,0.5)`,
          'transition:opacity 0.2s ease,filter 0.2s ease',
          'filter:blur(8px)',
        ].join(';');

        stage.appendChild(el);
        chaosWordEls.push(el);

        requestAnimationFrame(() => requestAnimationFrame(() => {
          el.style.opacity = chaosRand(0.82, 1.0).toFixed(2);
          el.style.filter  = 'blur(0px)';
        }));

        setTimeout(() => {
          if (!el.isConnected) return;
          chaosUsedCells.delete(cellIdx);
          el.style.transition = 'opacity 1.4s ease,filter 1.4s ease';
          el.style.opacity = '0'; el.style.filter = 'blur(8px)';
          setTimeout(() => {
            el.remove();
            const idx = chaosWordEls.indexOf(el);
            if (idx !== -1) chaosWordEls.splice(idx, 1);
          }, 1500);
        }, holdMs + i * 160);

      }, i * stagger));
    });
  }

})();
