/**
 * CMCD (Common Media Client Data) Plugin
 *
 * Enables CTA-5004 CMCD reporting on outgoing media requests.
 * Sends standardized client metrics (buffer length, bitrate, object type, etc.)
 * to the CDN via query parameters or request headers.
 *
 * CMCD keys transmitted:
 *   - br  : Encoded bitrate (kbps)
 *   - bl  : Buffer length (ms)
 *   - d   : Object duration (ms)
 *   - dl  : Deadline (ms) — time until buffer underrun
 *   - mtp : Measured throughput (kbps)
 *   - ot  : Object type (m=manifest, v=video, a=audio, i=init)
 *   - sf  : Streaming format (h=HLS, d=DASH)
 *   - sid : Session ID (GUID)
 *   - cid : Content ID
 *   - st  : Stream type (v=VOD, l=live)
 *   - su  : Startup flag
 *   - pr  : Playback rate
 *
 * Usage:
 *   import cmcdPlugin from './plugins/cmcd.js';
 *   const player = new OpenVideoPlayer(el, {
 *     plugins: [cmcdPlugin({ contentId: 'my-video-123', useHeaders: false })],
 *   });
 *
 * Configuration:
 *   contentId  : (string) Identifier for the content being played
 *   sessionId  : (string) Custom session ID. Auto-generated UUID if omitted
 *   useHeaders : (boolean) Send via HTTP headers instead of query params. Default: false
 *   enabled    : (boolean) Enable/disable CMCD. Default: true
 */

function generateSessionId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function cmcdPlugin(options = {}) {
  const config = {
    contentId: options.contentId || '',
    sessionId: options.sessionId || generateSessionId(),
    useHeaders: options.useHeaders || false,
    enabled: options.enabled !== false,
  };

  return function (player) {
    if (!config.enabled) return;

    // Store config on player for external access
    player._cmcdConfig = config;
    player._cmcdEnabled = true;

    // Patch the HLS loader
    const originalLoadHLS = player._loadHLS.bind(player);
    player._loadHLS = function (src) {
      player._destroyInstances();
      const Hls = window.Hls;

      if (Hls.isSupported()) {
        const hlsConfig = {
          cmcd: {
            sessionId: config.sessionId,
            contentId: config.contentId,
            useHeaders: config.useHeaders,
          },
        };

        player._hls = new Hls(hlsConfig);
        player._bindHLSEvents(player._hls);
        player._hls.loadSource(player._appendPassthroughParams(src));
        player._hls.attachMedia(player.video);

        player._logSession('cmcd-enabled', {
          transport: config.useHeaders ? 'headers' : 'query',
          sessionId: config.sessionId,
          contentId: config.contentId,
          format: 'hls',
        });
      } else if (player.video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS — CMCD not available
        player.video.src = player._appendPassthroughParams(src);
        player._logSession('cmcd-unavailable', { reason: 'native-hls' });
      } else {
        console.error('HLS is not supported in this browser');
        player._logSession('error', { category: 'source', message: 'HLS not supported' });
        player._showError('HLS playback is not supported in this browser');
      }
    };

    // Patch the DASH loader
    const originalLoadDASH = player._loadDASH.bind(player);
    player._loadDASH = function (src) {
      player._destroyInstances();
      const dashjs = window.dashjs;
      player._dash = dashjs.MediaPlayer().create();

      // Enable CMCD in dash.js
      player._dash.updateSettings({
        streaming: {
          cmcd: {
            enabled: true,
            sid: config.sessionId,
            cid: config.contentId,
            mode: config.useHeaders ? 'header' : 'query',
          },
        },
      });

      player._bindDASHEvents(player._dash);
      player._dash.initialize(
        player.video,
        player._appendPassthroughParams(src),
        player.config.autoplay ?? false
      );

      player._logSession('cmcd-enabled', {
        transport: config.useHeaders ? 'headers' : 'query',
        sessionId: config.sessionId,
        contentId: config.contentId,
        format: 'dash',
      });
    };

    // ─── CMCD Payload Logger ─────────────────────────────────
    // Logs the computed CMCD payload with each network request

    player.video.addEventListener('ovp-network-log', (e) => {
      if (!config.enabled) return;

      const entry = e.detail;
      const buffer = player.getBufferHealth();
      const quality = player.getQualityInfo();
      const streamFormat = player._streamType === 'hls' ? 'h' : 'd';

      // Determine object type from URL
      let objectType = 'v'; // default video
      const url = (entry.url || '').toLowerCase();
      if (url.includes('.m3u8') || url.includes('.mpd')) objectType = 'm';
      else if (url.includes('init') || url.includes('.mp4?')) objectType = 'i';
      else if (entry.mediaType === 'audio') objectType = 'a';

      // Determine stream type
      const latency = player.getLiveLatency();
      const streamType = latency !== null && latency > 0 ? 'l' : 'v';

      // Compute measured throughput from the request
      const mtp = (entry.bytes && entry.loadTimeMs && entry.loadTimeMs > 0)
        ? Math.round((entry.bytes * 8) / entry.loadTimeMs) // kbps
        : null;

      // Build CMCD payload object
      const cmcdPayload = {
        br: quality ? Math.round(quality.bitrate / 1000) : null,
        bl: Math.round(buffer.ahead * 1000),
        d: entry.duration ? Math.round(entry.duration * 1000) : null,
        dl: buffer.ahead > 0 ? Math.round(buffer.ahead * 1000) : null,
        mtp,
        ot: objectType,
        sf: streamFormat,
        sid: config.sessionId,
        cid: config.contentId || undefined,
        st: streamType,
        su: player.video.readyState < 3, // startup if not enough data
        pr: player.video.playbackRate !== 1 ? player.video.playbackRate : undefined,
      };

      // Remove null/undefined values for cleaner log
      const cleanPayload = {};
      for (const [key, val] of Object.entries(cmcdPayload)) {
        if (val !== null && val !== undefined) cleanPayload[key] = val;
      }

      // Encode as CMCD query string format for display
      const cmcdString = encodeCmcdPayload(cleanPayload);

      player._logSession('cmcd-sent', {
        url: getFilename(entry.url),
        payload: cleanPayload,
        encoded: cmcdString,
      });
    });

    // ─── Public API ──────────────────────────────────────────

    player.getCmcdConfig = function () {
      return { ...config };
    };

    player.getCmcdSnapshot = function () {
      const buffer = player.getBufferHealth();
      const quality = player.getQualityInfo();
      const latency = player.getLiveLatency();
      return {
        br: quality ? Math.round(quality.bitrate / 1000) : null,
        bl: Math.round(buffer.ahead * 1000),
        mtp: null, // only available per-request
        sf: player._streamType === 'hls' ? 'h' : 'd',
        sid: config.sessionId,
        cid: config.contentId,
        st: latency !== null && latency > 0 ? 'l' : 'v',
        pr: player.video.playbackRate,
      };
    };

    player.setCmcdEnabled = function (enabled) {
      config.enabled = enabled;
      player._cmcdEnabled = enabled;
      player._logSession('cmcd-toggled', { enabled });
    };

    player.setCmcdContentId = function (contentId) {
      config.contentId = contentId;
    };

    player._logSession('cmcd-initialized', {
      sessionId: config.sessionId,
      contentId: config.contentId,
      useHeaders: config.useHeaders,
    });
  };
}

// ─── CMCD Encoding Helpers ──────────────────────────────────

function encodeCmcdPayload(payload) {
  const parts = [];
  const keyOrder = ['br', 'bl', 'd', 'dl', 'mtp', 'ot', 'sf', 'st', 'su', 'pr', 'cid', 'sid'];

  for (const key of keyOrder) {
    if (!(key in payload)) continue;
    const val = payload[key];

    if (typeof val === 'boolean') {
      if (val) parts.push(key); // booleans omit =true per spec
    } else if (typeof val === 'string') {
      parts.push(`${key}="${val}"`);
    } else if (typeof val === 'number') {
      parts.push(`${key}=${val}`);
    }
  }

  return parts.join(',');
}

function getFilename(url) {
  if (!url) return '';
  const parts = url.split('/');
  return parts[parts.length - 1]?.split('?')[0] || url;
}
