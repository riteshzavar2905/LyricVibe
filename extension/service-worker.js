const BACKEND_URL = 'http://127.0.0.1:8787';
const RECORD_MS = 10000;
const sessions = new Map();

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  const existing = sessions.get(tab.id);
  if (existing && existing.active) {
    await stopSession(tab.id, 'Stopped');
    return;
  }

  await startSession(tab);
});

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
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  chrome.runtime.sendMessage({ type: 'LV_STOP_CAPTURE', tabId }).catch(() => {});
});

async function startSession(tab) {
  const tabId = tab.id;
  sessions.set(tabId, { active: true, capturing: false });

  await injectOverlay(tabId);
  sendToTab(tabId, { type: 'LV_STATUS', text: 'Checking this music tab...' });

  const hints = await getPageHints(tabId);
  const metadataResult = await tryMetadataDetection(hints);

  if (metadataResult && metadataResult.ok && hasUsableLyrics(metadataResult)) {
    await handleRecognitionResult(tabId, metadataResult);
    return;
  }

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

async function tryMetadataDetection(hints) {
  try {
    const response = await fetch(`${BACKEND_URL}/recognize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'metadata',
        hints
      })
    });
    return await response.json();
  } catch {
    return {
      ok: false,
      message: 'Local backend is not running.'
    };
  }
}

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
