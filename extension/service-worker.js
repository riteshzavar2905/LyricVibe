const LRCLIB_BASE = 'https://lrclib.net/api';
const RECORD_MS = 8000;
const sessions = new Map();

/* ══════════════════════════════════════
   ACTION CLICK HANDLER
   ══════════════════════════════════════ */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  const existing = sessions.get(tab.id);
  if (existing && existing.active) {
    await stopSession(tab.id, 'Stopped');
    return;
  }

  await startSession(tab);
});

/* ══════════════════════════════════════
   MESSAGE ROUTING
   ══════════════════════════════════════ */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !message.type) return;

  if (message.type === 'LV_CONTENT_STOP' && sender.tab && sender.tab.id) {
    stopSession(sender.tab.id, 'Stopped');
  }

  if (message.type === 'LV_OFFSCREEN_STATUS') {
    sendToTab(message.tabId, {
      type: 'LV_STATUS',
      text: message.text || 'Listening...'
    });
  }

  if (message.type === 'LV_OFFSCREEN_RESULT') {
    const session = sessions.get(message.tabId);
    if (session) session.capturing = false;
    handleRecognitionResult(message.tabId, message.payload);
  }

  if (message.type === 'LV_OFFSCREEN_ERROR') {
    const session = sessions.get(message.tabId);
    if (session) session.capturing = false;
    sendToTab(message.tabId, {
      type: 'LV_ERROR',
      text: message.error || 'Could not detect the song.'
    });
  }

  if (message.type === 'LV_SPOTIFY_TRACK_CHANGED' && sender.tab && sender.tab.id) {
    startSession(sender.tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  chrome.runtime.sendMessage({ type: 'LV_STOP_CAPTURE', tabId }).catch(() => {});
});

/* ══════════════════════════════════════
   SESSION MANAGEMENT
   ══════════════════════════════════════ */
async function startSession(tab) {
  const tabId = tab.id;
  sessions.set(tabId, { active: true, capturing: false });

  await injectOverlay(tabId);
  sendToTab(tabId, { type: 'LV_STATUS', text: 'Detecting song...' });

  const hints = await getPageHints(tabId);
  const isSpotify = (hints.host || '').includes('spotify.com');

  // STEP 1: Try metadata detection directly (no server)
  const metadataResult = await recognize({ mode: 'metadata', hints });

  if (metadataResult && metadataResult.ok && hasUsableLyrics(metadataResult)) {
    await handleRecognitionResult(tabId, metadataResult);
    return;
  }

  // STEP 2: Spotify — metadata only, no tab capture
  if (isSpotify) {
    // Wait a moment for Spotify's DOM to fully render track info
    await new Promise((r) => setTimeout(r, 600));
    const retryHints = await getPageHints(tabId);
    if (retryHints.track || retryHints.pageTitle) {
      const retryResult = await recognize({ mode: 'metadata', hints: retryHints });
      if (retryResult && retryResult.ok && hasUsableLyrics(retryResult)) {
        await handleRecognitionResult(tabId, retryResult);
        return;
      }
    }
    // One more retry with longer wait
    await new Promise((r) => setTimeout(r, 1200));
    const finalHints = await getPageHints(tabId);
    if (finalHints.track || finalHints.pageTitle) {
      const finalResult = await recognize({ mode: 'metadata', hints: finalHints });
      if (finalResult && finalResult.ok && hasUsableLyrics(finalResult)) {
        await handleRecognitionResult(tabId, finalResult);
        return;
      }
    }
    sendToTab(tabId, {
      type: 'LV_ERROR',
      text: metadataResult && metadataResult.message
        ? metadataResult.message
        : 'Could not find lyrics for this Spotify track. Make sure a song is playing.'
    });
    return;
  }

  // STEP 3: Fall back to audio capture for other sites
  sendToTab(tabId, {
    type: 'LV_STATUS',
    text: 'Listening to tab audio...'
  });

  await startTabCapture(tab);
}

async function stopSession(tabId, reason) {
  sessions.delete(tabId);
  chrome.runtime.sendMessage({ type: 'LV_STOP_CAPTURE', tabId }).catch(() => {});
  sendToTab(tabId, { type: 'LV_STOP', text: reason || 'Stopped' });
}

/* ══════════════════════════════════════
   CORE RECOGNITION LOGIC
   (previously lived in server.js)
   ══════════════════════════════════════ */
async function recognize(body) {
  const hints = normalizeHints(body && body.hints ? body.hints : {});
  const detected = trackFromHints(hints);

  if (!detected) {
    return {
      ok: false,
      message: 'Could not read a song title from this page.',
      hints
    };
  }

  const lyricResult = await findLyrics(detected, hints);

  if (!lyricResult) {
    return {
      ok: false,
      message: `Song detected as "${displayTrack(detected)}", but no lyrics were found.`,
      track: detected,
      hints
    };
  }

  const matched = lyricResult.match || {};
  const track = {
    title: detected.title || matched.trackName || matched.name || '',
    artist: detected.artist || matched.artistName || '',
    album: detected.album || matched.albumName || '',
    durationMs: detected.durationMs || secondsToMs(matched.duration),
    playOffsetMs: Number.isFinite(detected.playOffsetMs)
      ? detected.playOffsetMs
      : secondsToMs(hints.currentTime || 0),
    source: detected.source,
    lyricsProvider: 'LRCLIB'
  };

  return {
    ok: true,
    message: lyricResult.lyrics.synced ? 'Synced lyrics ready.' : 'Plain lyrics ready.',
    track,
    lyrics: lyricResult.lyrics,
    match: matched,
    hints
  };
}

function trackFromHints(hints) {
  if (hints.track && hints.artist) {
    return {
      title: hints.track,
      artist: hints.artist,
      durationMs: secondsToMs(hints.duration),
      playOffsetMs: secondsToMs(hints.currentTime),
      source: 'page-metadata'
    };
  }

  if (hints.track) {
    return {
      title: hints.track,
      artist: '',
      query: hints.track,
      durationMs: secondsToMs(hints.duration),
      playOffsetMs: secondsToMs(hints.currentTime),
      source: 'page-metadata-partial'
    };
  }

  const parsed = parsePageTitle(hints.pageTitle || '');
  if (parsed.title || parsed.query) {
    return {
      title: parsed.title || '',
      artist: parsed.artist || '',
      query: parsed.query,
      durationMs: secondsToMs(hints.duration),
      playOffsetMs: secondsToMs(hints.currentTime),
      source: 'page-title'
    };
  }

  return null;
}

async function findLyrics(track, hints) {
  // PRIORITY 1: LRCLIB direct metadata lookup — most accurate, uses exact title+artist+duration
  // This is far better than search for Spotify/YouTube Music where we have exact metadata
  if (track.title && track.artist) {
    const direct = await getLrclibByMetadata(track);
    if (direct && (direct.syncedLyrics || direct.plainLyrics)) {
      return {
        lyrics: {
          synced: direct.syncedLyrics || '',
          plain: cleanPlainLyrics(direct.plainLyrics || ''),
          provider: 'LRCLIB'
        },
        match: direct
      };
    }
  }

  // PRIORITY 2: Search fallback — used when direct lookup fails or no artist available
  const queries = buildLyricQueries(track, hints);

  for (const query of queries) {
    const results = await searchLrclib(query);
    const best = chooseBestLyricResult(results, track, hints);
    if (!best) continue;

    const full = await hydrateLrclibResult(best);
    const lyrics = {
      synced: full.syncedLyrics || '',
      plain: cleanPlainLyrics(full.plainLyrics || ''),
      provider: 'LRCLIB'
    };

    if (lyrics.synced || lyrics.plain) {
      return { lyrics, match: full };
    }
  }

  return null;
}

async function getLrclibByMetadata(track) {
  try {
    const params = new URLSearchParams();
    params.set('track_name', track.title);
    params.set('artist_name', track.artist);
    if (track.durationMs > 0) {
      params.set('duration', String(Math.round(track.durationMs / 1000)));
    }
    const response = await fetch(`${LRCLIB_BASE}/get?${params.toString()}`, {
      headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    // LRCLIB returns 404 body or empty — check for valid id
    return data && data.id ? data : null;
  } catch {
    return null;
  }
}

function buildLyricQueries(track, hints) {
  const queries = [];
  const titleArtist = [track.artist, track.title].filter(Boolean).join(' ').trim();
  const artistTitle = [track.title, track.artist].filter(Boolean).join(' ').trim();
  const titleOnly  = track.title || '';
  const rawQuery   = track.query || '';
  const pageTitle  = cleanPageTitle(hints.pageTitle || '');

  [titleArtist, artistTitle, titleOnly, rawQuery, pageTitle].forEach((q) => {
    const cleaned = cleanupSearchQuery(q);
    if (cleaned && !queries.includes(cleaned)) queries.push(cleaned);
  });

  return queries;
}

async function searchLrclib(query) {
  if (!query) return [];
  try {
    const url = `${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
    });
    if (!response.ok) return [];
    const json = await response.json();
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

async function hydrateLrclibResult(result) {
  if ((result.syncedLyrics || result.plainLyrics) || !result.id) return result;
  try {
    const response = await fetch(`${LRCLIB_BASE}/get/${result.id}`, {
      headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
    });
    if (!response.ok) return result;
    return response.json();
  } catch {
    return result;
  }
}

function chooseBestLyricResult(results, track, hints) {
  if (!Array.isArray(results) || !results.length) return null;
  const targetTitle    = normalizeText(track.title || track.query || hints.pageTitle || '');
  const targetArtist   = normalizeText(track.artist || '');
  const targetDuration = secondsToMs(hints.duration) || track.durationMs || 0;

  return results
    .map((item) => ({
      item,
      score: scoreLyricResult(item, targetTitle, targetArtist, targetDuration)
    }))
    .sort((a, b) => b.score - a.score)[0].item;
}

function scoreLyricResult(item, targetTitle, targetArtist, targetDurationMs) {
  const title  = normalizeText(item.trackName || item.name || '');
  const artist = normalizeText(item.artistName || '');
  let score = 0;

  if (item.syncedLyrics) score += 40;
  if (item.plainLyrics)  score += 10;

  if (targetTitle && title) {
    if (title === targetTitle) score += 30;
    else if (title.includes(targetTitle) || targetTitle.includes(title)) score += 24;
  }

  if (targetArtist && artist) {
    if (artist === targetArtist) score += 25;
    else if (artist.includes(targetArtist) || targetArtist.includes(artist)) score += 20;
  }

  const durationMs = secondsToMs(item.duration);
  if (targetDurationMs && durationMs) {
    const diff = Math.abs(targetDurationMs - durationMs);
    if (diff < 1500)       score += 20; // near-exact match — almost certainly the right version
    else if (diff < 4000)  score += 12;
    else if (diff < 8000)  score += 5;
    else                   score -= 5;  // wrong duration = likely wrong version, penalize
  }

  return score;
}

/* ══════════════════════════════════════
   PAGE TITLE PARSING
   ══════════════════════════════════════ */
function parsePageTitle(title) {
  const cleaned = cleanPageTitle(title);
  if (!cleaned) return {};

  const spotifySplit = cleaned.split(' · ');
  if (spotifySplit.length >= 2) {
    return {
      title:  spotifySplit[0].trim(),
      artist: spotifySplit.slice(1).join(' ').trim(),
      query:  `${spotifySplit.slice(1).join(' ').trim()} ${spotifySplit[0].trim()}`
    };
  }

  for (const sep of [' - ', ' | ', ' by ']) {
    const parts = cleaned.split(sep).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { artist: parts[0], title: parts[1], query: `${parts[0]} ${parts[1]}` };
    }
  }

  return { query: cleaned };
}

function cleanPageTitle(title) {
  return String(title || '')
    .replace(/\s*-\s*YouTube Music\s*$/i, '')
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .replace(/\s*\|\s*Spotify\s*$/i, '')
    .replace(/\s*·\s*Spotify\s*$/i, '')
    .replace(/\s*-\s*Spotify\s*$/i, '')
    .replace(/\s*\|\s*SoundCloud\s*$/i, '')
    .replace(/\[[^\]]*(official|lyrics?|visualizer|audio|video|mv)[^\]]*\]/gi, '')
    .replace(/\([^)]*(official|lyrics?|visualizer|audio|video|mv)[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanupSearchQuery(query) {
  return cleanPageTitle(query)
    .replace(/\b(official|lyrics?|visualizer|audio|video|mv|hd|4k|feat\.?|ft\.?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanPlainLyrics(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[0-9:.]+\]/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

/* ══════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════ */
function normalizeHints(hints) {
  return {
    url:       stringValue(hints.url),
    host:      stringValue(hints.host),
    pageTitle: stringValue(hints.pageTitle),
    track:     cleanMaybe(hints.track),
    artist:    cleanMaybe(hints.artist),
    currentTime: finiteNumber(hints.currentTime),
    duration:    finiteNumber(hints.duration)
  };
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function displayTrack(track) {
  return [track.artist, track.title || track.query].filter(Boolean).join(' - ');
}

function secondsToMs(seconds) {
  const n = Number(seconds || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1000);
}

function cleanMaybe(value)  { return String(value || '').replace(/\s+/g, ' ').trim(); }
function stringValue(value) { return typeof value === 'string' ? value : ''; }
function finiteNumber(value){ const n = Number(value); return Number.isFinite(n) ? n : null; }

/* ══════════════════════════════════════
   CONTENT SCRIPT INJECTION
   ══════════════════════════════════════ */
async function injectOverlay(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  } catch {}

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (error) {
    throw new Error(`Could not inject LyricVibe overlay: ${error.message}`);
  }
}

async function getPageHints(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'LV_GET_HINTS' });
    return response || {};
  } catch {
    return {};
  }
}

/* ══════════════════════════════════════
   TAB AUDIO CAPTURE
   ══════════════════════════════════════ */
async function startTabCapture(tab) {
  const tabId = tab.id;
  try {
    await ensureOffscreenDocument();

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const session = sessions.get(tabId);
    if (session) session.capturing = true;

    chrome.runtime.sendMessage({
      type: 'LV_START_CAPTURE',
      tabId,
      streamId,
      recordMs: RECORD_MS,
      hints: await getPageHints(tabId)
    });
  } catch (error) {
    sendToTab(tabId, {
      type: 'LV_ERROR',
      text: `Tab audio capture failed: ${error.message}`
    });
  }
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });
  if (contexts.length) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture the active tab audio for local song recognition.'
  });
}

/* ══════════════════════════════════════
   RECOGNITION RESULT HANDLER
   ══════════════════════════════════════ */
async function handleRecognitionResult(tabId, payload) {
  if (!payload || !payload.ok) {
    sendToTab(tabId, {
      type: 'LV_ERROR',
      text: payload && payload.message ? payload.message : 'Song not recognized.'
    });
    return;
  }

  if (!hasUsableLyrics(payload)) {
    sendToTab(tabId, {
      type: 'LV_ERROR',
      text: payload.message || 'Song found, but no synced lyrics were available.'
    });
    return;
  }

  const session = sessions.get(tabId);
  if (session) session.active = true;

  sendToTab(tabId, { type: 'LV_TRACK', payload });
}

function hasUsableLyrics(payload) {
  return Boolean(payload && payload.lyrics && (payload.lyrics.synced || payload.lyrics.plain));
}

function sendToTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}
