# LyricVibe 🎵 - Chrome Extension

A sleek, full-screen kinetic typography lyric visualizer that automatically overlays perfectly synced lyrics directly onto your active music tabs. 

Built for modern music listeners who want an immersive, "Spotify Canvas"-style experience right in their browser.

## ✨ Features
- **Zero Configuration:** Just play a song. The extension automatically detects the playing track, fetches the lyrics via LRCLIB, and handles the sync.
- **Universal Support:** Works seamlessly on **YouTube Music**, **Spotify Web Player**, and **SoundCloud**.
- **Smart Audio Sync:** Analyzes word density and genre tempo to automatically adjust the reveal timing so the text feels perfectly locked to the beat.
- **13 Stunning Themes:** Press `T` to cycle through beautifully crafted visual themes including Aurora, Matrix, Vinyl, Cosmic, Neon, and more.
- **Dynamic Layouts:** Lyrics automatically arrange into different visual layouts (Drift, Scatter, Cascade) to keep the screen feeling alive.
- **Word-by-Word Cascade:** Smooth, snappy transitions that reveal words exactly as they are sung.

## 🚀 How to Install
Since this extension is in beta and not yet on the Chrome Web Store, you can install it manually in 30 seconds:

1. Download this repository by clicking the green **Code** button -> **Download ZIP**.
2. Extract the downloaded ZIP file to a folder on your computer.
3. Open your browser and go to the extensions page:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
   - Brave: `brave://extensions/`
4. Turn on **Developer mode** (toggle in the top right corner).
5. Click the **Load unpacked** button.
6. Select the `extension` folder from the ZIP you extracted.
7. Done! Pin the extension, open YouTube Music or Spotify, and click the LyricVibe icon to start.

## ⌨️ Keyboard Shortcuts
- `T` — Cycle through 13 visual themes
- `[` / `]` — Manually nudge sync timing earlier/later if the auto-sync is slightly off
- `ESC` — Close the visualizer

## 🛠️ Tech Stack
- **Frontend / Extension:** Vanilla JavaScript, CSS3 (No heavy frameworks for maximum performance).
- **Backend:** Node.js server hosted on Render.
- **Lyrics Provider:** LRCLIB API.
