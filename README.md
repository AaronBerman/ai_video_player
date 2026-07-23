# OpenVideo Player

A lightweight, plugin-based video player supporting HLS and DASH adaptive streaming with built-in playback diagnostics.

## Features

- **HLS & DASH** — Adaptive bitrate streaming via hls.js and dash.js
- **Plugin architecture** — Extend functionality with simple function plugins
- **Skin system** — Swappable visual themes (modern, light, dark, minimal, cinema, rounded, high-contrast, retro, default)
- **Custom control bar** — Play/pause, mute, volume slider, time display, speed control, fullscreen
- **Keyboard shortcuts** — Full keyboard navigation (Space, F, M, S, arrows, J/L)
- **Fullscreen support** — Toggle via button or keyboard, with proper fullscreen styling
- **Playback speed** — 0.25x to 2x with cycle control
- **Loading states** — Animated spinner during buffering/seeking
- **Error UI** — On-screen error messages with auto-recovery feedback
- **Subtitle support** — WebVTT tracks with configurable cue styling themes
- **Playback diagnostics** — Real-time quality overlay, session logging, network monitoring, buffer visualization, error classification, and live latency tracking
- **Metrics graphs** — Live canvas-based sparkline charts for bitrate, buffer health, dropped frames, and latency
- **Log export** — Download all player logs as JSON or POST them to a remote endpoint for diagnostics and validation testing
- **Responsive design** — Mobile-friendly layout with adaptive controls
- **Theme system** — Light, dark, and sepia page themes
- **Passthrough params** — Append query parameters to stream URLs (useful for token auth, CDN routing)
- **Destroy/cleanup** — Clean teardown of all DOM, intervals, and listeners
- **Chromecast support** — Cast video to Chromecast devices with automatic session management
- **Fire TV (DIAL)** — Best-effort casting to Fire TV via DIAL-compatible receiver apps

## Quick Start

No build step required. Serve the project directory with any static file server:

```bash
# Python
python3 -m http.server 8000

# Node (npx)
npx serve .
```

Then open `http://localhost:8000` in your browser.

## Project Structure

```
├── index.html              # Main entry point and UI wiring
├── src/
│   └── player.js           # Core OpenVideoPlayer class
├── plugins/
│   ├── cast.js             # Chromecast + Fire TV casting plugin
│   ├── cmcd.js             # CMCD (CTA-5004) client metrics plugin
│   ├── drm.js              # DRM configuration plugin (Widevine, PlayReady, FairPlay)
│   ├── log-export.js       # Log export — download or POST logs to a remote endpoint
│   ├── metrics.js          # Real-time playback metric graphs (canvas sparklines)
│   ├── qrcode.js           # QR code overlay for stream URLs
│   ├── skins.js            # Skin registration plugin
│   └── watermark.js        # Watermark overlay plugin
├── styles/
│   └── player.css          # All styles (layout, themes, diagnostics, metrics, cast UI)
└── README.md
```

## Usage

### Basic Initialization

```javascript
import OpenVideoPlayer from './src/player.js';

const player = new OpenVideoPlayer(document.getElementById('player-container'), {
  autoplay: false,
  controls: true,
  skin: 'modern',
  subtitleTheme: 'default',
  plugins: [],
});

player.load('https://example.com/stream.m3u8');
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoplay` | boolean | `false` | Auto-start playback |
| `controls` | boolean | `true` | Show native video controls (set to `false` when using custom control bar) |
| `skin` | string | `'default'` | Visual skin (`modern`, `light`, `dark`, `minimal`, `cinema`, `rounded`, `high-contrast`, `retro`, `default`) |
| `subtitleTheme` | string | `'default'` | Cue styling (`default`, `light`, `high-contrast`) |
| `poster` | string | `''` | Poster image URL |
| `plugins` | array | `[]` | Plugin functions to apply |
| `passthroughParams` | string | `''` | Query params appended to stream URLs |

### Loading Streams

```javascript
// HLS
player.load('https://example.com/live.m3u8');

// DASH
player.load('https://example.com/manifest.mpd');

// Direct MP4
player.load('https://example.com/video.mp4');

// With subtitles
player.load('https://example.com/stream.m3u8', [
  { label: 'English', srclang: 'en', src: '/subs/en.vtt', default: true },
  { label: 'Spanish', srclang: 'es', src: '/subs/es.vtt' },
]);
```

### Playback Controls API

```javascript
// Fullscreen
player.toggleFullscreen();
player.isFullscreen; // → true/false

// Playback speed
player.setSpeed(1.5);
player.getSpeed();     // → 1.5
player.cycleSpeed();   // cycles through 0.25x–2x

// Volume
player.setVolume(0.8); // 0–1
player.toggleMute();

// Cleanup (removes all DOM, intervals, listeners)
player.destroy();
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` / `K` | Play / Pause |
| `F` | Toggle fullscreen |
| `M` | Toggle mute |
| `S` | Cycle playback speed |
| `←` / `→` | Seek ±5 seconds |
| `J` / `L` | Seek ±10 seconds |
| `↑` / `↓` | Volume up/down |
| `0` / `Home` | Restart from beginning |

Shortcuts are disabled when focus is on an input field.

### Diagnostics API

```javascript
// Toggle stats overlay on the video
player.toggleOverlay();

// Get current quality info
player.getQualityInfo();
// → { bitrate: 2500000, width: 1920, height: 1080, codec: 'avc1.64001f', currentLevel: 3, totalLevels: 5 }

// Get buffer health
player.getBufferHealth();
// → { ahead: 12.45, ranges: [{ start: 0, end: 45.2 }] }

// Get dropped frames
player.getDroppedFrames();
// → { dropped: 2, total: 1840 }

// Get live stream latency (seconds behind live edge)
player.getLiveLatency();
// → 3.24

// Get full session event log
player.getSessionLog();

// Get network request log
player.getNetworkLog();
```

### Custom Events

The player dispatches custom events on the video element for external listeners:

```javascript
player.element.addEventListener('ovp-session-log', (e) => {
  console.log('Session event:', e.detail);
});

player.element.addEventListener('ovp-network-log', (e) => {
  console.log('Network request:', e.detail);
});
```

## Writing Plugins

Plugins are functions that receive the player instance:

```javascript
export default function myPlugin(player) {
  // Access the video element
  player.video.addEventListener('play', () => {
    console.log('Playing!');
  });

  // Access the container
  player.container.appendChild(someElement);

  // Access config
  console.log(player.config);
}
```

Register plugins at construction time or later:

```javascript
// At init
new OpenVideoPlayer(el, { plugins: [myPlugin] });

// After init
player.use(myPlugin);
```

## CMCD (Common Media Client Data)

The player includes a CMCD plugin implementing the [CTA-5004](https://cdn.cta.tech/cta/media/media/resources/standards/pdfs/cta-5004-final.pdf) specification. CMCD sends standardized client metrics with each media request so CDNs can make better delivery decisions.

### Enabling CMCD

```javascript
import cmcdPlugin from './plugins/cmcd.js';

const player = new OpenVideoPlayer(el, {
  plugins: [
    cmcdPlugin({
      contentId: 'my-video-123',      // Identifier for the content
      sessionId: 'custom-session-id',  // Optional — auto-generated UUID if omitted
      useHeaders: false,               // false = query params (default), true = HTTP headers
      enabled: true,                   // Enable/disable (default: true)
    }),
  ],
});
```

### CMCD Keys Transmitted

| Key | Description |
|-----|-------------|
| `br` | Encoded bitrate (kbps) |
| `bl` | Buffer length (ms) |
| `d` | Object duration (ms) |
| `dl` | Deadline — time until buffer underrun (ms) |
| `mtp` | Measured throughput (kbps) |
| `ot` | Object type (m=manifest, v=video, a=audio, i=init) |
| `sf` | Streaming format (h=HLS, d=DASH) |
| `sid` | Session ID |
| `cid` | Content ID |
| `st` | Stream type (v=VOD, l=live) |
| `su` | Startup flag |
| `pr` | Playback rate |

### CMCD API

```javascript
// Get current CMCD configuration
player.getCmcdConfig();
// → { contentId: 'my-video-123', sessionId: '...', useHeaders: false, enabled: true }

// Toggle CMCD on/off at runtime
player.setCmcdEnabled(false);

// Update content ID (takes effect on next load)
player.setCmcdContentId('new-content-456');
```

### Transport Modes

- **Query parameters** (default): CMCD data appended as `?CMCD=...` on each request. Works with any CDN, no CORS concerns.
- **HTTP headers**: CMCD data sent via `CMCD-Object`, `CMCD-Request`, `CMCD-Session`, `CMCD-Status` headers. Requires CDN to allow these headers via CORS.

### CDN Integration

CMCD data enables CDNs to:
- Prioritize requests for low-buffer clients
- Identify startup vs steady-state requests
- Correlate client sessions with server logs
- Make informed cache/routing decisions based on bitrate and object type

## Casting (Chromecast + Fire TV)

The player includes a cast plugin that adds Chromecast support using the Google Cast SDK, with best-effort Fire TV support via the DIAL protocol.

### Enabling Cast

```javascript
import castPlugin from './plugins/cast.js';

const player = new OpenVideoPlayer(el, {
  plugins: [castPlugin],
});
```

### How It Works

1. The plugin dynamically loads the Google Cast SDK (`cast_sender.js`)
2. A cast icon appears in the control bar when devices are detected on the network
3. Clicking the icon opens Chrome's native device picker
4. Once connected, local playback pauses and the stream is sent to the cast device
5. When casting ends, local playback resumes from where the cast left off

### Requirements

- **Browser**: Google Chrome (Cast SDK is Chrome-only)
- **Network**: Chromecast / Fire TV must be on the same network as the browser
- **Stream URL**: Must be accessible from the cast device's network (not `localhost`)

### Fire TV Support

Fire TV devices don't natively appear in the Cast picker, but they can with a DIAL-compatible receiver app installed on the Fire Stick:

- [AirReceiver](https://www.amazon.com/dp/B00LAX04DY) — popular option, shows Fire TV as a cast target
- [Web Video Caster](https://www.amazon.com/dp/B01N0C3GS4) — alternative receiver

Once one of these apps is running on the Fire TV, it will appear alongside Chromecasts in the device picker.

### Cast Events in Session Log

The plugin emits these events via the player's standard `ovp-session-log` system:

| Event | Description |
|-------|-------------|
| `cast-initialized` | Cast SDK ready |
| `cast-state` | Device availability changed |
| `cast-session` | Session started/ended/resumed |
| `cast-media-loaded` | Media successfully loaded on cast device |
| `cast-media-error` | Failed to load media on cast device |
| `cast-player-state` | Remote player state changed |
| `cast-request-error` | Session request failed (user cancelled, etc.) |

## Log Export

The log export plugin captures all session and network events and provides two export paths: downloading a JSON file locally, or sending logs to a remote endpoint via POST.

### Enabling Log Export

```javascript
import logExportPlugin from './plugins/log-export.js';

// Download-only (no remote endpoint):
const player = new OpenVideoPlayer(el, {
  plugins: [logExportPlugin],
});

// With a remote diagnostics endpoint:
const player = new OpenVideoPlayer(el, {
  plugins: [
    logExportPlugin({
      endpoint: 'https://your-server.com/api/player-logs',
      headers: { 'X-Api-Key': 'your-key' },
      maxEntries: 1000,        // max log entries to buffer (default: 1000)
      includeMetadata: true,   // include player state metadata (default: true)
    }),
  ],
});
```

### Log Export API

```javascript
// Download logs as a JSON file
player.downloadLogs();

// POST logs to the configured endpoint
const result = await player.sendLogs();
// → { success: true, status: 200 }

// Get the raw payload without exporting
player.getLogPayload();
// → { sessionLogs: [...], networkLogs: [...], metadata: { ... } }

// Clear buffered logs
player.clearLogs();
```

### Exported Payload Structure

```json
{
  "sessionLogs": [
    { "timestamp": 1700000000000, "time": "2024-01-01T00:00:00.000Z", "event": "load", "source": "..." },
    { "timestamp": 1700000001000, "time": "...", "event": "quality-switch", "bitrate": 2500000 }
  ],
  "networkLogs": [
    { "timestamp": 1700000000500, "url": "...", "bytes": 524288, "loadTimeMs": 120 }
  ],
  "metadata": {
    "exportedAt": "2024-01-01T00:01:30.000Z",
    "userAgent": "Mozilla/5.0 ...",
    "url": "http://localhost:8000",
    "streamType": "hls",
    "duration": 120.5,
    "currentTime": 45.2,
    "videoSrc": "https://example.com/stream.m3u8",
    "readyState": 4,
    "paused": false,
    "buffered": [{ "start": 0, "end": 58.4 }]
  }
}
```

### UI

A 📋 button is added to the control bar. Clicking it downloads the log file (and sends to the remote endpoint if configured).

### Log Export Events in Session Log

| Event | Description |
|-------|-------------|
| `log-export-ready` | Plugin initialized |
| `logs-exported` | Logs successfully downloaded or sent |
| `logs-export-failed` | Remote send failed (includes error message) |
| `logs-cleared` | Log buffers cleared |

## Playback Metrics Graphs

The metrics plugin renders real-time canvas-based sparkline graphs for key playback health indicators. These appear in the side panel and update every second.

### Enabling Metrics

```javascript
import metricsPlugin from './plugins/metrics.js';

// Default (renders into #ovp-metrics-panel):
const player = new OpenVideoPlayer(el, {
  plugins: [metricsPlugin],
});

// With custom options:
const player = new OpenVideoPlayer(el, {
  plugins: [
    metricsPlugin({
      targetId: 'ovp-metrics-panel',  // DOM element ID to render into
      historySize: 90,                // data points to retain (default: 90)
      pollInterval: 1000,             // sampling interval in ms (default: 1000)
    }),
  ],
});
```

### Metrics Displayed

| Graph | Color | Source | Description |
|-------|-------|--------|-------------|
| Bitrate (kbps) | Blue | `getQualityInfo()` | Current ABR level, visualizes quality switches |
| Buffer Ahead (s) | Green | `getBufferHealth()` | Buffered content ahead of playhead |
| Dropped Frames | Red | `getDroppedFrames()` | Cumulative frame drops (decoder stress) |
| Live Latency (s) | Orange | `getLiveLatency()` | Glass-to-glass latency for live streams |

Each graph shows a rolling window of history (default 90 seconds) with gradient-filled sparklines.

### Metrics API

```javascript
// Access raw metric history arrays
player.metricsHistory;
// → { bitrate: [1200, 1200, 2500, ...], buffer: [8.2, 8.5, ...], ... }

// Reset all metric history (clears charts)
player.resetMetrics();
```

### HTML Requirement

The plugin renders into a DOM element with a specific ID. Add this to your page:

```html
<div id="ovp-metrics-panel"></div>
```

The `index.html` demo page already includes this in the side panel.

## Diagnostics Features

### Stats Overlay
Click the "⚙ Stats" button on the video to show real-time stream info: bitrate, resolution, codec, quality level, buffer length, dropped frames, and live latency.

### Session Log
Timestamped timeline of all player events including play, pause, seek, stalls, quality switches, manifest loads, buffer warnings, errors, and automatic recovery attempts.

### Network Monitor
Logs every segment fetch with download speed (KB/s), filename, and timing. Useful for identifying slow segments or CDN issues.

### Buffer Visualizer
Color-coded bar showing buffer health. Turns orange/red when buffer drops below 3 seconds (stall risk).

### Error Classification
Errors are automatically categorized:

| Category | Examples |
|----------|----------|
| **network** | Manifest/segment load errors, timeouts |
| **decode** | Fragment parsing errors, buffer append failures |
| **media** | Buffer stalls, nudge-on-stall events |
| **source** | Manifest parsing errors, incompatible codecs |

### Auto-Recovery
Fatal HLS errors trigger automatic recovery:
- Network errors → `hls.startLoad()`
- Media errors → `hls.recoverMediaError()`
- Unrecoverable → logged as fatal

## Dependencies

Loaded via CDN (no install required):

- [hls.js](https://github.com/video-dev/hls.js) v1.5.8 — HLS playback
- [dash.js](https://github.com/Dash-Industry-Forum/dash.js) latest — DASH playback
- [Google Cast SDK](https://developers.google.com/cast/docs/web_sender) — Loaded dynamically by the cast plugin (Chrome only)

## Browser Support

Works in any modern browser. HLS native playback (Safari/iOS) falls back gracefully when hls.js isn't needed.

## License

MIT
