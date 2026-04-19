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

async function startCapture({ tabId, streamId, backendUrl, recordMs, hints }) {
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
  const chunks = [];

  activeCapture = { tabId, media, audioContext, recorder };

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  });

  recorder.addEventListener('stop', async () => {
    try {
      chrome.runtime.sendMessage({
        type: 'LV_OFFSCREEN_STATUS',
        tabId,
        text: 'Identifying the song...'
      });

      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      const audioBase64 = await blobToBase64(blob);
      const response = await fetch(`${backendUrl}/recognize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'audio',
          audioBase64,
          mimeType: blob.type,
          hints
        })
      });

      const payload = await response.json();
      chrome.runtime.sendMessage({
        type: 'LV_OFFSCREEN_RESULT',
        tabId,
        payload
      });
    } catch (error) {
      chrome.runtime.sendMessage({
        type: 'LV_OFFSCREEN_ERROR',
        tabId,
        error: error.message
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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read audio sample.'));
    reader.readAsDataURL(blob);
  });
}
