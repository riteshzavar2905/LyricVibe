const BACKEND_URL = 'https://lyricvibe.onrender.com';
const RECORD_MS = 8000; // Reduced from 10s to 8s for faster recognition
const sessions = new Map();

/* ══════════════════════════════════════
   WARM-UP: Keep Render backend alive using chrome.alarms
   Free-tier Render sleeps after ~15min of inactivity.
   We ping every 10 minutes to prevent cold-start delays.
   ══════════════════════════════════════ */
const KEEP_ALIVE_ALARM = 'lv-keep-alive';
const KEEP_ALIVE_INTERVAL_MINUTES = 10;

chrome.runtime.onInstalled.addListener(() => {
  warmUpBackend();
  setupKeepAlive();
});
chrome.runtime.onStartup.addListener(() => {
  warmUpBackend();
  setupKeepAlive();
});

/* Set up recurring alarm */
function setupKeepAlive() {
  chrome.alarms.create(KEEP_ALIVE_ALARM, {
    delayInMinutes: KEEP_ALIVE_INTERVAL_MINUTES,
    periodInMinutes: KEEP_ALIVE_INTERVAL_MINUTES
  });
}

/* Listen for alarm fires */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEP_ALIVE_ALARM) {
    warmUpBackend();
  }
});

async function warmUpBackend() {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const response = await fetch(`${BACKEND_URL}/health`, {
      method: 'GET',
      signal: controller.signal
    });
    const data = await response.json();
    console.log('[LyricVibe] Backend ping:', data.ok ? 'Awake ✓' : 'Starting...');
    return data.ok;
  } catch (err) {
    console.log('[LyricVibe] Backend cold — will warm up on next use.');
    return false;
  }
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

  /* Spotify track changed — re-detect lyrics */
  if (message.type === 'LV_SPOTIFY_TRACK_CHANGED' && sender.tab && sender.tab.id) {
    const tabId = sender.tab.id;
    // Re-start session for the new track
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
  sendToTab(tabId, { type: 'LV_STATUS', text: 'Checking this music tab...' });

  // PRE-FLIGHT: Ensure backend is awake before recognition
  const backendReady = await warmUpBackend();
  if (!backendReady) {
    sendToTab(tabId, { type: 'LV_STATUS', text: 'Waking up backend... hang tight!' });
    // Give it one more try with longer timeout
    await warmUpBackend();
  }

  // STEP 1: Always try metadata first (instant, no audio capture needed)
  const hints = await getPageHints(tabId);
  const isSpotify = (hints.host || '').includes('spotify.com');

  const metadataResult = await tryMetadataDetection(hints);

  if (metadataResult && metadataResult.ok && hasUsableLyrics(metadataResult)) {
    await handleRecognitionResult(tabId, metadataResult);
    return;
  }

  // STEP 2: For Spotify — metadata is the ONLY path (no tabCapture for encrypted audio)
  if (isSpotify) {
    // Retry with cleaned-up hints from Spotify
    const retryHints = await getPageHints(tabId);
    if (retryHints.track || retryHints.pageTitle) {
      const retryResult = await tryMetadataDetection(retryHints);
      if (retryResult && retryResult.ok && hasUsableLyrics(retryResult)) {
        await handleRecognitionResult(tabId, retryResult);
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

  // STEP 3: For other sites — fall back to audio capture
  sendToTab(tabId, {
    type: 'LV_STATUS',
    text: metadataResult && metadataResult.message
      ? `${metadataResult.message} Listening to tab audio...`
      : 'Listening to tab audio...'
  });

  await startTabCapture(tab);
}

async function stopSession(tabId, reason) {
  sessions.delete(tabId);
  chrome.runtime.sendMessage({ type: 'LV_STOP_CAPTURE', tabId }).catch(() => {});
  sendToTab(tabId, { type: 'LV_STOP', text: reason || 'Stopped' });
}

/* ══════════════════════════════════════
   CONTENT SCRIPT INJECTION
   ══════════════════════════════════════ */
async function injectOverlay(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css']
    });
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
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
   METADATA DETECTION (Render backend)
   ══════════════════════════════════════ */
async function tryMetadataDetection(hints) {
  try {
    // Warm-up ping first if this might be a cold start
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s max

    const response = await fetch(`${BACKEND_URL}/recognize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'metadata',
        hints
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        ok: false,
        message: 'Backend is waking up (cold start). Please try again in a few seconds.'
      };
    }
    return {
      ok: false,
      message: 'Backend not reachable. It may be warming up — try again shortly.'
    };
  }
}

/* ══════════════════════════════════════
   TAB AUDIO CAPTURE (for non-Spotify sites)
   ══════════════════════════════════════ */
async function startTabCapture(tab) {
  const tabId = tab.id;
  try {
    await ensureOffscreenDocument();

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId
    });

    const session = sessions.get(tabId);
    if (session) session.capturing = true;

    chrome.runtime.sendMessage({
      type: 'LV_START_CAPTURE',
      tabId,
      streamId,
      backendUrl: BACKEND_URL,
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

  sendToTab(tabId, {
    type: 'LV_TRACK',
    payload
  });
}

function hasUsableLyrics(payload) {
  return Boolean(payload && payload.lyrics && (payload.lyrics.synced || payload.lyrics.plain));
}

function sendToTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}
