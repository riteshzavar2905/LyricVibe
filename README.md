# LYRICVIBE — Auto-Detect Lyric Visualizer

A kinetic typography lyric visualizer in the style of modern music reels (cream slab text + red context + big red punchline moments). The major upgrade over the original: **you no longer need to manually annotate lyrics with `^`, `>>`, `!!`, `~~`**. Just paste any raw song lyrics and the built-in analyzer figures out where the chorus, hook, setup lines, and tag lines are — then maps them to the right visual treatment.

## ✅ What's Implemented

### Core Visual Engine (kept from your original)
- **Big cream slab text**, word-by-word reveal with scale + translate easing
- **Small red context** lines (top/left, uppercase Space Grotesk)
- **Red short "extra" tail** (short phrases like *BUILT DIFFERENT*)
- **Full-screen red punchline mode** for chorus/hook moments
- **Subtitle under punchline** (`~~` equivalent) in Syne italic-feel
- 4 rotating layout templates so moments don't look identical
- Auto font sizing based on character count
- HUD, fullscreen, speed control (0.5× – 2.5×), keyboard shortcuts

### 🆕 NEW — Automatic Lyric Analyzer (`autoAnalyze()`)
Works on **plain lyrics** pasted from Genius, Spotify, YouTube captions, anywhere. No annotation characters required.

**Detection heuristics:**
| Pattern | Detected as | Visual |
|---|---|---|
| Line that **repeats 2+ times** in the song (≤ 7 words) | Hook | Red centered punchline |
| **Entire block repeats** (classic chorus) | Chorus | Red centered multi-line punchline |
| Line ending with comma / opening with *before, when, if, just, and, because…* | Setup | Small red context (`.ctx`) |
| Quoted line `"..."` or question line `?` | Narrative context | Small red context |
| 1–3 words ending with `!` | Emphasis tail | Red short extra |
| Line starting with *is, are, was, not, never, only…* (≤ 5 words) | Tag / subtitle | Cream subtitle under big text |
| Comma/dash split where tail is 1–5 words | Head + tail | Big cream + red extra |
| Longest "statement" line in a block | Main hook | Big cream word-by-word |
| Section headers `[Chorus]`, `(Verse 1)` etc. | Ignored | Stripped automatically |

**Smart grouping:** blocks split by blank lines become scene moments; long verses are auto-split so you never get 8 context lines crammed together.

### 🆕 Mode Toggle
- **✨ Auto Detect** (default) — paste raw lyrics, analyzer runs
- **Manual Annotate** — original `^ >> !! ~~` syntax still available as fallback/power-user mode

### Controls
| Control | Action |
|---|---|
| `▶ Play / ■ Stop` | Start / stop the sequence |
| `✎ Edit` | Open lyrics panel |
| `⛶` | Fullscreen toggle |
| `Space` | Play / pause |
| `E` | Open editor |
| `Esc` | Stop |
| Speed slider | 0.5× → 2.5× |
| `Load Sample` | Loads appropriate sample for current mode |
| `Analyze & Play` | Runs analyzer (auto) or parser (manual), then plays |

## 🌐 Entry Points

- **`/index.html`** — Main app. Query params: none. Opens directly into the idle stage with sample lyrics pre-analyzed. Click Play, or Edit to paste your own lyrics.

## 🚫 Not Implemented (Honest Limitations)

Because this is a pure static site (no LLM/backend available to this agent):

- **No audio-sync / timestamp detection.** The visualizer is pacing-based (timed reveal). If you want lines locked to actual song timestamps, you'd need `.lrc` karaoke files or the Spotify API.
- **No real NLP model.** The analyzer uses rule-based heuristics (repetition counting, opener-word lists, punctuation cues). It's tuned for pop / rap / Bollywood-lyric style where choruses literally repeat. On abstract / experimental lyrics it may miss the hook — in that case the Manual mode is your fallback.
- **No automatic language translation** or romanization (e.g. Devanagari → Latin). Feed lyrics in whatever script you want displayed.
- **No background audio track upload.** The visual is silent by design.

## 🛣️ Recommended Next Steps

1. **`.lrc` file support** — accept drag-and-drop of `.lrc` karaoke files to sync reveals to real timestamps.
2. **Audio upload + waveform scrub** — upload the song mp3 alongside lyrics and have the visualizer play with it; use WebAudio RMS to beat-pulse the cream text on kick drums.
3. **Export as MP4** — use `MediaRecorder` + `captureStream()` on the `#stage` to record a shareable reel.
4. **Theme presets** — swap cream/red palette for other brand moods (cyan/black, white/green, etc.).
5. **Tighter NLP via `compromise.js`** — use a real POS-tagger CDN library to identify verbs vs. nouns and make the "main line" detection even smarter.
6. **Optional LLM hook** — if the host app ever allows an OpenAI/Gemini proxy, a one-shot prompt could dramatically improve hook detection for unusual songs.

## 🧠 Data Model (in-memory only)

No backend / database — fully client-side. The internal "moment" shape the renderer consumes:

```js
{
  type: 'verse' | 'solo' | 'punch',
  ctx:        [string],   // red small lines
  big:        string,     // cream slab text
  extra:      string,     // red short tail OR cream extra
  punchLines: [string],   // used only when type === 'punch'
  sub:        string      // subtitle under punchline
}
```

The analyzer (`autoAnalyze(rawText)`) emits an array of these; the renderer (`renderMoment`) consumes them one by one.

## 🎨 Project Goals

Give any music / mood / motivational creator a tool to turn plain lyrics into a styled kinetic-typography reel in under 10 seconds — no annotation, no timeline editing, just paste and play.
