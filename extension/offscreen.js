let activeCapture = null;

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;

  if (message.type === 'LV_START_CAPTURE') {
    startCapture(message).catch((error) => {
      chrome.runtime.sendMessage({
        type: 'LV_OFFSCREEN_ERROR',
        tabId: message.tabId,
        error: error.message
      });
    });
  }

  if (message.type === 'LV_STOP_CAPTURE') {
    stopCapture(message.tabId);
  }
});

async function startCapture({ tabId, streamId, recordMs, hints }) {
  stopCapture(tabId);

  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(media);
  source.connect(audioContext.destination);

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(media, mimeType ? { mimeType } : undefined);

  activeCapture = { tabId, media, audioContext, recorder };

  recorder.addEventListener('stop', async () => {
    try {
      // No backend — audio fingerprinting is not available.
      // Return an error so the service worker can show a clean message.
      chrome.runtime.sendMessage({
        type: 'LV_OFFSCREEN_ERROR',
        tabId,
        error: 'Could not detect this song from metadata. Try playing on YouTube Music, Spotify, or SoundCloud for best results.'
      });
    } finally {
      cleanup();
    }
  });

  chrome.runtime.sendMessage({
    type: 'LV_OFFSCREEN_STATUS',
    tabId,
    text: `Listening for ${Math.round(recordMs / 1000)} seconds...`
  });

  recorder.start();
  setTimeout(() => {
    if (activeCapture && activeCapture.tabId === tabId && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, recordMs);
}

function stopCapture(tabId) {
  if (!activeCapture) return;
  if (tabId && activeCapture.tabId !== tabId) return;

  if (activeCapture.recorder && activeCapture.recorder.state !== 'inactive') {
    activeCapture.recorder.stop();
  } else {
    cleanup();
  }
}

function cleanup() {
  if (!activeCapture) return;
  activeCapture.media.getTracks().forEach((track) => track.stop());
  activeCapture.audioContext.close().catch(() => {});
  activeCapture = null;
}

function pickMimeType() {
  const choices = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus'
  ];
  return choices.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}
