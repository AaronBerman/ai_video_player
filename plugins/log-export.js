/**
 * Log Export Plugin for OpenVideo Player
 *
 * Captures session and network logs and provides:
 * - Download as JSON file
 * - Send to a remote endpoint (POST)
 *
 * Usage:
 *   import logExportPlugin from './plugins/log-export.js';
 *   // With defaults (download only, no remote):
 *   logExportPlugin(player)
 *   // With options:
 *   logExportPlugin({ endpoint: 'https://example.com/logs', headers: { 'X-Api-Key': '...' } })(player)
 */

export default function logExportPlugin(optionsOrPlayer) {
  // Support both direct use and curried factory pattern:
  //   logExportPlugin          → plugin function (no remote)
  //   logExportPlugin({...})   → returns plugin function (with config)
  if (optionsOrPlayer && optionsOrPlayer.container && optionsOrPlayer.video) {
    // Called directly as a plugin function (no options)
    return _initPlugin({}, optionsOrPlayer);
  }

  // Called as a factory with options
  const options = optionsOrPlayer || {};
  return function (player) {
    return _initPlugin(options, player);
  };
}

function _initPlugin(options, player) {
  const config = {
    endpoint: options.endpoint || null,
    headers: options.headers || {},
    includeMetadata: options.includeMetadata !== false,
    maxEntries: options.maxEntries || 1000,
    buttonPosition: options.buttonPosition || 'control-bar', // 'control-bar' or 'container'
  };

  // Internal log buffers (independent of player's capped buffers)
  const sessionLogs = [];
  const networkLogs = [];

  // Listen for log events
  player.video.addEventListener('ovp-session-log', (e) => {
    sessionLogs.push(e.detail);
    if (sessionLogs.length > config.maxEntries) sessionLogs.shift();
  });

  player.video.addEventListener('ovp-network-log', (e) => {
    networkLogs.push(e.detail);
    if (networkLogs.length > config.maxEntries) networkLogs.shift();
  });

  // Build the export payload
  function _buildPayload() {
    const payload = {
      sessionLogs: [...sessionLogs],
      networkLogs: [...networkLogs],
    };

    if (config.includeMetadata) {
      payload.metadata = {
        exportedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        url: location.href,
        streamType: player._streamType || 'unknown',
        duration: player.video.duration || 0,
        currentTime: player.video.currentTime || 0,
        videoSrc: player.video.currentSrc || '',
        readyState: player.video.readyState,
        paused: player.video.paused,
        buffered: _getBufferedRanges(player.video),
      };
    }

    return payload;
  }

  function _getBufferedRanges(video) {
    const ranges = [];
    for (let i = 0; i < video.buffered.length; i++) {
      ranges.push({ start: video.buffered.start(i), end: video.buffered.end(i) });
    }
    return ranges;
  }

  // ─── Download as JSON file ──────────────────────────────────

  function downloadLogs() {
    const payload = _buildPayload();
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `ovp-logs-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    player._logSession('logs-exported', { method: 'download', entries: sessionLogs.length + networkLogs.length });
  }

  // ─── Send to remote endpoint ────────────────────────────────

  async function sendLogs() {
    if (!config.endpoint) {
      console.warn('[log-export] No endpoint configured — use downloadLogs() or provide an endpoint.');
      return { success: false, reason: 'no-endpoint' };
    }

    const payload = _buildPayload();

    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers,
        },
        body: JSON.stringify(payload),
      });

      const result = { success: response.ok, status: response.status };
      player._logSession('logs-exported', {
        method: 'remote',
        endpoint: config.endpoint,
        status: response.status,
        entries: sessionLogs.length + networkLogs.length,
      });
      return result;
    } catch (err) {
      player._logSession('logs-export-failed', {
        method: 'remote',
        endpoint: config.endpoint,
        error: err.message,
      });
      return { success: false, reason: err.message };
    }
  }

  // ─── Clear collected logs ───────────────────────────────────

  function clearLogs() {
    sessionLogs.length = 0;
    networkLogs.length = 0;
    player._logSession('logs-cleared');
  }

  // ─── UI: Add export button ──────────────────────────────────

  function _insertButton() {
    const exportBtn = document.createElement('button');
    exportBtn.className = 'ovp-btn ovp-btn-export';
    exportBtn.setAttribute('aria-label', 'Export logs');
    exportBtn.setAttribute('title', 'Export Logs');
    exportBtn.textContent = '📋';

    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (config.endpoint) {
        sendLogs();
      }
      downloadLogs();
    });

    // Insert into control bar if available, otherwise append to container
    const controlBar = player.container.querySelector('.ovp-control-bar');
    if (controlBar && config.buttonPosition === 'control-bar') {
      const spacer = controlBar.querySelector('.ovp-spacer');
      if (spacer) {
        spacer.after(exportBtn);
      } else {
        controlBar.appendChild(exportBtn);
      }
    } else {
      player.container.appendChild(exportBtn);
    }
  }

  // Control bar may not exist yet (plugins init before controls),
  // so defer button insertion until DOM is ready.
  const controlBar = player.container.querySelector('.ovp-control-bar');
  if (controlBar) {
    _insertButton();
  } else {
    const observer = new MutationObserver((mutations, obs) => {
      if (player.container.querySelector('.ovp-control-bar')) {
        obs.disconnect();
        _insertButton();
      }
    });
    observer.observe(player.container, { childList: true, subtree: true });
  }

  // ─── Expose public API on the player instance ───────────────

  player.downloadLogs = downloadLogs;
  player.sendLogs = sendLogs;
  player.clearLogs = clearLogs;
  player.getLogPayload = _buildPayload;

  player._logSession('log-export-ready', { endpoint: config.endpoint || 'none (download only)' });
}
