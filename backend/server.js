const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const HOST = '0.0.0.0';
const LRCLIB_BASE = 'https://lrclib.net/api';

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        acrConfigured: hasAcrConfig()
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/recognize') {
      const body = await readJson(req);
      const result = await recognize(body);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, {
      ok: false,
      message: 'Route not found.'
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      message: error.message || 'Server error.'
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LyricVibe local backend running at http://${HOST}:${PORT}`);
  console.log(hasAcrConfig()
    ? 'ACRCloud is configured for audio fingerprinting.'
    : 'ACRCloud is not configured. Metadata mode still works on supported music pages.');
});

async function recognize(body) {
  const hints = normalizeHints(body && body.hints ? body.hints : {});
  let detected = null;
  let recognitionMessage = '';

  if (body.mode === 'audio' && body.audioBase64) {
    if (hasAcrConfig()) {
      detected = await recognizeWithAcr(body.audioBase64, body.mimeType);
    } else {
      recognitionMessage = 'No ACRCloud keys found, so audio fingerprinting is disabled.';
    }
  }

  if (!detected) {
    detected = trackFromHints(hints);
  }

  if (!detected) {
    return {
      ok: false,
      message: recognitionMessage || 'Could not read a song title from this page. Add ACRCloud keys for universal audio recognition.',
      hints
    };
  }

  const lyricResult = await findLyrics(detected, hints);

  if (!lyricResult) {
    return {
      ok: false,
      message: `Song detected as ${displayTrack(detected)}, but LRCLIB did not return lyrics.`,
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

async function recognizeWithAcr(audioBase64, mimeType) {
  const host = cleanAcrHost(process.env.ACR_HOST);
  const accessKey = process.env.ACR_ACCESS_KEY;
  const accessSecret = process.env.ACR_ACCESS_SECRET;
  const endpoint = '/v1/identify';
  const dataType = 'audio';
  const signatureVersion = '1';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = [
    'POST',
    endpoint,
    accessKey,
    dataType,
    signatureVersion,
    timestamp
  ].join('\n');

  const signature = crypto
    .createHmac('sha1', accessSecret)
    .update(stringToSign)
    .digest('base64');

  const buffer = Buffer.from(audioBase64, 'base64');
  const form = new FormData();
  form.append('sample', new Blob([buffer], { type: mimeType || 'audio/webm' }), 'sample.webm');
  form.append('sample_bytes', String(buffer.length));
  form.append('access_key', accessKey);
  form.append('timestamp', timestamp);
  form.append('signature', signature);
  form.append('data_type', dataType);
  form.append('signature_version', signatureVersion);

  const response = await fetch(`https://${host}${endpoint}`, {
    method: 'POST',
    body: form
  });

  const payload = await response.json();
  const statusCode = payload && payload.status ? payload.status.code : -1;
  if (statusCode !== 0) {
    const message = payload && payload.status ? payload.status.msg : 'ACRCloud did not recognize the sample.';
    throw new Error(message);
  }

  const music = payload.metadata && payload.metadata.music && payload.metadata.music[0];
  if (!music) throw new Error('ACRCloud returned no music match.');

  return {
    title: music.title || '',
    artist: Array.isArray(music.artists) ? music.artists.map((item) => item.name).filter(Boolean).join(', ') : '',
    album: music.album && music.album.name ? music.album.name : '',
    durationMs: music.duration_ms || 0,
    playOffsetMs: Number.isFinite(music.play_offset_ms) ? music.play_offset_ms : 0,
    source: 'acrcloud'
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
      return {
        lyrics,
        match: full
      };
    }
  }

  return null;
}

function buildLyricQueries(track, hints) {
  const queries = [];
  const titleArtist = [track.artist, track.title].filter(Boolean).join(' ').trim();
  const titleOnly = track.title || '';
  const rawQuery = track.query || '';
  const pageTitle = cleanPageTitle(hints.pageTitle || '');

  [titleArtist, titleOnly, rawQuery, pageTitle].forEach((query) => {
    const cleaned = cleanupSearchQuery(query);
    if (cleaned && !queries.includes(cleaned)) queries.push(cleaned);
  });

  return queries;
}

async function searchLrclib(query) {
  if (!query) return [];
  const url = `${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'LyricVibeLocal/0.1 (local prototype)'
    }
  });
  if (!response.ok) return [];
  const json = await response.json();
  return Array.isArray(json) ? json : [];
}

async function hydrateLrclibResult(result) {
  if ((result.syncedLyrics || result.plainLyrics) || !result.id) return result;

  const response = await fetch(`${LRCLIB_BASE}/get/${result.id}`, {
    headers: {
      'User-Agent': 'LyricVibeLocal/0.1 (local prototype)'
    }
  });

  if (!response.ok) return result;
  return response.json();
}

function chooseBestLyricResult(results, track, hints) {
  if (!Array.isArray(results) || !results.length) return null;
  const targetTitle = normalizeText(track.title || track.query || hints.pageTitle || '');
  const targetArtist = normalizeText(track.artist || '');
  const targetDuration = secondsToMs(hints.duration) || track.durationMs || 0;

  return results
    .map((item) => ({
      item,
      score: scoreLyricResult(item, targetTitle, targetArtist, targetDuration)
    }))
    .sort((a, b) => b.score - a.score)[0].item;
}

function scoreLyricResult(item, targetTitle, targetArtist, targetDurationMs) {
  const title = normalizeText(item.trackName || item.name || '');
  const artist = normalizeText(item.artistName || '');
  let score = 0;

  if (item.syncedLyrics) score += 40;
  if (item.plainLyrics) score += 10;
  if (targetTitle && title && (title.includes(targetTitle) || targetTitle.includes(title))) score += 24;
  if (targetArtist && artist && (artist.includes(targetArtist) || targetArtist.includes(artist))) score += 20;

  const durationMs = secondsToMs(item.duration);
  if (targetDurationMs && durationMs) {
    const diff = Math.abs(targetDurationMs - durationMs);
    if (diff < 2500) score += 14;
    else if (diff < 8000) score += 7;
  }

  return score;
}

function parsePageTitle(title) {
  const cleaned = cleanPageTitle(title);
  if (!cleaned) return {};

  const separators = [' - ', ' | ', ' by '];
  for (const separator of separators) {
    const parts = cleaned.split(separator).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0];
      const second = parts[1];
      return {
        artist: first,
        title: second,
        query: `${first} ${second}`
      };
    }
  }

  return { query: cleaned };
}

function cleanPageTitle(title) {
  return String(title || '')
    .replace(/\s*-\s*YouTube Music\s*$/i, '')
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .replace(/\s*\|\s*Spotify\s*$/i, '')
    .replace(/\s*\|\s*SoundCloud\s*$/i, '')
    .replace(/\[[^\]]*(official|lyrics?|visualizer|audio|video|mv)[^\]]*\]/gi, '')
    .replace(/\([^)]*(official|lyrics?|visualizer|audio|video|mv)[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanupSearchQuery(query) {
  return cleanPageTitle(query)
    .replace(/\b(official|lyrics?|visualizer|audio|video|mv|hd|4k)\b/gi, '')
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

function normalizeHints(hints) {
  return {
    url: stringValue(hints.url),
    host: stringValue(hints.host),
    pageTitle: stringValue(hints.pageTitle),
    track: cleanMaybe(hints.track),
    artist: cleanMaybe(hints.artist),
    currentTime: finiteNumber(hints.currentTime),
    duration: finiteNumber(hints.duration)
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

function cleanMaybe(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasAcrConfig() {
  return Boolean(process.env.ACR_HOST && process.env.ACR_ACCESS_KEY && process.env.ACR_ACCESS_SECRET);
}

function cleanAcrHost(host) {
  return String(host || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('Invalid JSON request.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const index = trimmed.indexOf('=');
    if (index < 0) return;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = value;
  });
}
