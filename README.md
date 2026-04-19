# LyricVibe Local Extension Prototype

This is a local-first Chrome extension prototype for automatic song detection and synced kinetic lyrics.

## What works locally

- Click the extension on a music tab.
- The extension injects the LyricVibe overlay into the page.
- It first tries page metadata from YouTube Music, YouTube, Spotify Web, or SoundCloud.
- The local backend searches LRCLIB for synced lyrics.
- If synced lyrics exist, the overlay starts from the current video/audio time.
- If metadata is not enough, the extension can capture 10 seconds of tab audio and send it to the local backend.

Audio fingerprinting needs ACRCloud keys in `backend/.env`. Without keys, the prototype still works when page metadata is readable.

## Run The Backend

From this folder:

```powershell
cd C:\Users\rites\Documents\Playground\lyricvibe-extension\backend
copy .env.example .env
node server.js
```

Leave that terminal running.

## Load The Extension

1. Open Chrome or Brave.
2. Go to `chrome://extensions`.
3. Turn on Developer mode.
4. Click Load unpacked.
5. Select:

```text
C:\Users\rites\Documents\Playground\lyricvibe-extension\extension
```

## Try It

1. Open YouTube Music, YouTube, Spotify Web, or SoundCloud.
2. Play a song.
3. Click the LyricVibe Local extension icon.
4. The overlay should say what it is doing, then start synced lyrics if LRCLIB has them.

## Add Universal Audio Recognition

Create `backend/.env` from `.env.example`, then fill:

```text
ACR_HOST=your-acrcloud-host
ACR_ACCESS_KEY=your-access-key
ACR_ACCESS_SECRET=your-access-secret
```

Restart the backend. When page metadata is not enough, the extension will capture 10 seconds of tab audio and ask ACRCloud to identify the song.

## Notes

- Chrome requires a user action before tab audio capture.
- While the tab is captured, the extension routes audio back to your speakers so the song keeps playing.
- Lyrics availability depends on LRCLIB coverage.
- For a public product, use a licensed lyrics provider and a hosted recognition backend.
