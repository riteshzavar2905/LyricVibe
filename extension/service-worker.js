const LRCLIB_BASE = 'https://lrclib.net/api';
const RECORD_MS = 8000;
const sessions = new Map();

/* ── Lyrics cache: avoids re-fetching for previously played tracks ── */
const lyricsCache = new Map();
const CACHE_MAX = 60;

function cacheKey(track, artist) {
  return `${(artist || '').toLowerCase().trim()}|${(track || '').toLowerCase().trim()}`;
}

function getCachedLyrics(track, artist) {
  const key = cacheKey(track, artist);
  return lyricsCache.has(key) ? lyricsCache.get(key) : null;
}

function setCachedLyrics(track, artist, payload) {
  const key = cacheKey(track, artist);
  if (lyricsCache.size >= CACHE_MAX) {
    const oldest = lyricsCache.keys().next().value;
    lyricsCache.delete(oldest);
  }
  lyricsCache.set(key, payload);
}

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

  // STEP 0: Check cache first (instant)
  if (hints.track) {
    const cached = getCachedLyrics(hints.track, hints.artist);
    if (cached) {
      // Update playOffsetMs from current hints
      if (cached.track && hints.currentTime != null) {
        cached.track.playOffsetMs = Math.round((hints.currentTime || 0) * 1000);
      }
      await handleRecognitionResult(tabId, cached);
      return;
    }
  }

  // STEP 1: Try metadata detection directly (no server)
  const metadataResult = await recognize({ mode: 'metadata', hints });

  if (metadataResult && metadataResult.ok && hasUsableLyrics(metadataResult)) {
    await handleRecognitionResult(tabId, metadataResult);
    return;
  }

  // STEP 2: Spotify — metadata only, no tab capture (faster retries)
  if (isSpotify) {
    // Quick retry — Spotify DOM may not be ready yet
    await new Promise((r) => setTimeout(r, 100));
    const retryHints = await getPageHints(tabId);
    if (retryHints.track || retryHints.pageTitle) {
      const retryResult = await recognize({ mode: 'metadata', hints: retryHints });
      if (retryResult && retryResult.ok && hasUsableLyrics(retryResult)) {
        await handleRecognitionResult(tabId, retryResult);
        return;
      }
    }
    // One more retry
    await new Promise((r) => setTimeout(r, 400));
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

  // Check cache before hitting API
  const cached = getCachedLyrics(detected.title, detected.artist);
  if (cached) {
    if (cached.track && detected.playOffsetMs != null) {
      cached.track.playOffsetMs = detected.playOffsetMs;
    }
    return cached;
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

  const result = {
    ok: true,
    message: lyricResult.lyrics.synced ? 'Synced lyrics ready.' : 'Plain lyrics ready.',
    track,
    lyrics: lyricResult.lyrics,
    match: matched,
    hints
  };

  // Cache for future use
  setCachedLyrics(track.title, track.artist, result);

  return result;
}

function trackFromHints(hints) {
  if (hints.track && hints.artist) {
    return {
      title: hints.track,
      artist: hints.artist,
      album: hints.album || '',
      durationMs: secondsToMs(hints.duration),
      playOffsetMs: secondsToMs(hints.currentTime),
      source: 'page-metadata'
    };
  }

  if (hints.track) {
    return {
      title: hints.track,
      artist: '',
      album: hints.album || '',
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
      album: '',
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
  if (track.title && track.artist) {
    const direct = await getLrclibByMetadata(track);
    if (direct && (direct.syncedLyrics || direct.plainLyrics)) {
      // Validate: if direct result has fake/auto-generated synced lyrics,
      // fall through to search where scoring can find a better version
      const directIsFake = direct.syncedLyrics && isFakeLRC(direct.syncedLyrics);
      if (!directIsFake) {
        return {
          lyrics: {
            synced: direct.syncedLyrics || '',
            plain: cleanPlainLyrics(direct.plainLyrics || ''),
            provider: 'LRCLIB'
          },
          match: direct
        };
      }
      // Direct has fake LRC — still keep plain lyrics as fallback, but try search first
    }
  }

  // PRIORITY 2: Search — finds the best result across all available versions
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

  // PRIORITY 3: If search failed but direct had plain lyrics, use those
  if (track.title && track.artist) {
    const direct = await getLrclibByMetadata(track);
    if (direct && direct.plainLyrics) {
      return {
        lyrics: {
          synced: '',
          plain: cleanPlainLyrics(direct.plainLyrics),
          provider: 'LRCLIB'
        },
        match: direct
      };
    }
  }

  return null;
}

async function getLrclibByMetadata(track) {
  try {
    const params = new URLSearchParams();
    params.set('track_name', track.title);
    params.set('artist_name', track.artist);
    if (track.album) params.set('album_name', track.album);
    if (track.durationMs > 0) {
      params.set('duration', String(Math.round(track.durationMs / 1000)));
    }
    const response = await fetch(`${LRCLIB_BASE}/get?${params.toString()}`, {
      headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
    });
    if (!response.ok) {
      // If direct lookup with album fails, retry without album
      if (track.album) {
        const fallbackParams = new URLSearchParams();
        fallbackParams.set('track_name', track.title);
        fallbackParams.set('artist_name', track.artist);
        if (track.durationMs > 0) {
          fallbackParams.set('duration', String(Math.round(track.durationMs / 1000)));
        }
        const fb = await fetch(`${LRCLIB_BASE}/get?${fallbackParams.toString()}`, {
          headers: { 'User-Agent': 'LyricVibe/1.0 (chrome-extension)' }
        });
        if (!fb.ok) return null;
        const fbData = await fb.json();
        return fbData && fbData.id ? fbData : null;
      }
      return null;
    }
    const data = await response.json();
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
  const targetAlbum    = normalizeText(track.album || '');
  const targetDuration = secondsToMs(hints.duration) || track.durationMs || 0;

  const scored = results
    .map((item) => ({
      item,
      score: scoreLyricResult(item, targetTitle, targetArtist, targetAlbum, targetDuration)
    }))
    .sort((a, b) => b.score - a.score);

  // Only return if score is positive (avoid returning garbage)
  return scored[0].score > 0 ? scored[0].item : null;
}

function scoreLyricResult(item, targetTitle, targetArtist, targetAlbum, targetDurationMs) {
  const title  = normalizeText(item.trackName || item.name || '');
  const artist = normalizeText(item.artistName || '');
  const album  = normalizeText(item.albumName || '');
  let score = 0;

  // Synced lyrics bonus — but penalize fake/auto-generated LRC
  if (item.syncedLyrics) {
    if (isFakeLRC(item.syncedLyrics)) {
      score += 5;  // Has synced but they're fake — barely better than plain
    } else {
      score += 50; // Real synced lyrics — strongly prefer
    }
  }
  if (item.plainLyrics) score += 8;

  // Title matching
  if (targetTitle && title) {
    // Strip artist name from title field (some LRCLIB entries have "Artist - Title" as trackName)
    const cleanTitle = title.replace(targetArtist, '').trim();
    const cleanTarget = targetTitle.replace(targetArtist, '').trim();
    if (cleanTitle === cleanTarget || title === targetTitle) score += 30;
    else if (title.includes(targetTitle) || targetTitle.includes(title)) score += 22;
    else if (cleanTitle.includes(cleanTarget) || cleanTarget.includes(cleanTitle)) score += 20;
  }

  // Artist matching
  if (targetArtist && artist) {
    if (artist === targetArtist) score += 25;
    else if (artist.includes(targetArtist) || targetArtist.includes(artist)) score += 18;
    // Penalize wrong artist (e.g., "R&BHype" reposting someone else's song)
    if (!artist.includes(targetArtist) && !targetArtist.includes(artist)) score -= 10;
  }

  // Album matching — strong signal when available
  if (targetAlbum && album) {
    if (album === targetAlbum) score += 20;
    else if (album.includes(targetAlbum) || targetAlbum.includes(album)) score += 12;
    // Penalize clearly wrong albums ("Videos", "Songs", "unknown", "null")
    if (/\b(videos?|songs?|unknown|null)\b/i.test(item.albumName || '')) score -= 8;
  }

  // Duration matching — critical for picking the right version
  const durationMs = secondsToMs(item.duration);
  if (targetDurationMs && durationMs) {
    const diff = Math.abs(targetDurationMs - durationMs);
    if (diff < 1500)       score += 22; // near-exact
    else if (diff < 3000)  score += 14;
    else if (diff < 6000)  score += 5;
    else                   score -= 8;  // very wrong duration
  }

  return score;
}

/* ── Detect auto-generated / fake LRC timestamps ──
   Many LRCLIB entries have machine-generated timestamps with perfectly uniform gaps
   (e.g., every 5.2s or every 4.2s). Real synced lyrics have IRREGULAR gaps because
   actual song lines have different lengths. */
function isFakeLRC(syncedLyrics) {
  if (!syncedLyrics) return true;
  const times = [];
  const lines = syncedLyrics.split('\n');
  for (const line of lines) {
    const match = line.match(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/);
    if (match) {
      const ms = Number(match[1]) * 60000 + Number(match[2]) * 1000 +
        (match[3] ? Number(match[3].padEnd(3, '0').slice(0, 3)) : 0);
      times.push(ms);
    }
  }
  if (times.length < 6) return false; // too few lines to judge

  // Calculate gaps between consecutive timestamps
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length < 5) return false;

  // Check 1: Do gaps have suspiciously low variance? (real lyrics have varied timing)
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / (mean || 1); // coefficient of variation

  // Real lyrics typically have CV > 0.3 (lots of variation)
  // Fake uniform timestamps have CV < 0.15
  if (cv < 0.12) return true;

  // Check 2: Does it start at exactly [00:00.00] with very first lyric text?
  // Real songs usually have intros — lyrics don't start at 0
  if (times[0] === 0 && times.length > 10) {
    // If all gaps are very uniform AND starts at 0, almost certainly fake
    if (cv < 0.25) return true;
  }

  return false;
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
    album:     cleanMaybe(hints.album),
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
