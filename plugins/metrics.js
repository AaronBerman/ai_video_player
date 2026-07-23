/**
 * Metrics Plugin for OpenVideo Player
 *
 * Renders real-time canvas-based graphs for common playback metrics:
 * - Bitrate (kbps)
 * - Buffer ahead (seconds)
 * - Dropped frames (cumulative)
 * - Live latency (seconds, when applicable)
 *
 * Usage:
 *   import metricsPlugin from './plugins/metrics.js';
 *   // Default (renders into a container with id="ovp-metrics-panel"):
 *   metricsPlugin(player)
 *   // With options:
 *   metricsPlugin({ targetId: 'my-panel', historySize: 120, pollInterval: 500 })(player)
 */

export default function metricsPlugin(optionsOrPlayer) {
  if (optionsOrPlayer && optionsOrPlayer.container && optionsOrPlayer.video) {
    return _initMetrics({}, optionsOrPlayer);
  }
  const options = optionsOrPlayer || {};
  return function (player) {
    return _initMetrics(options, player);
  };
}

function _initMetrics(options, player) {
  const config = {
    targetId: options.targetId || 'ovp-metrics-panel',
    historySize: options.historySize || 90,   // data points to retain
    pollInterval: options.pollInterval || 1000, // ms between samples
  };

  // Data buffers
  const history = {
    bitrate: [],
    buffer: [],
    droppedFrames: [],
    latency: [],
  };

  // Chart definitions
  const charts = [
    { key: 'bitrate', label: 'Bitrate (kbps)', color: '#4fc3f7', unit: 'kbps', format: v => v.toFixed(0) },
    { key: 'buffer', label: 'Buffer Ahead (s)', color: '#81c784', unit: 's', format: v => v.toFixed(1) },
    { key: 'droppedFrames', label: 'Dropped Frames', color: '#e57373', unit: '', format: v => v.toFixed(0) },
    { key: 'latency', label: 'Live Latency (s)', color: '#ffb74d', unit: 's', format: v => v.toFixed(2) },
  ];

  // Canvas references
  const canvases = {};

  // ─── Build DOM ──────────────────────────────────────────────

  function _buildUI() {
    const target = document.getElementById(config.targetId);
    if (!target) return null;

    target.innerHTML = '';
    target.classList.add('ovp-metrics-container');

    charts.forEach(chart => {
      const wrapper = document.createElement('div');
      wrapper.className = 'ovp-metric-chart';
      wrapper.dataset.metric = chart.key;

      const header = document.createElement('div');
      header.className = 'ovp-metric-header';

      const labelEl = document.createElement('span');
      labelEl.className = 'ovp-metric-label';
      labelEl.textContent = chart.label;

      const valueEl = document.createElement('span');
      valueEl.className = 'ovp-metric-value';
      valueEl.id = `ovp-metric-val-${chart.key}`;
      valueEl.textContent = '--';

      header.appendChild(labelEl);
      header.appendChild(valueEl);

      const canvas = document.createElement('canvas');
      canvas.className = 'ovp-metric-canvas';
      canvas.width = 280;
      canvas.height = 60;
      canvas.setAttribute('aria-label', `${chart.label} graph`);
      canvas.setAttribute('role', 'img');

      wrapper.appendChild(header);
      wrapper.appendChild(canvas);
      target.appendChild(wrapper);

      canvases[chart.key] = { canvas, valueEl, chart };
    });

    return target;
  }

  // ─── Render a single sparkline ──────────────────────────────

  function _drawChart(key) {
    const entry = canvases[key];
    if (!entry) return;

    const { canvas, valueEl, chart } = entry;
    const ctx = canvas.getContext('2d');
    const data = history[key];
    const w = canvas.width;
    const h = canvas.height;

    // Clear
    ctx.clearRect(0, 0, w, h);

    if (data.length < 2) {
      valueEl.textContent = '--';
      return;
    }

    // Update current value
    const current = data[data.length - 1];
    valueEl.textContent = `${chart.format(current)} ${chart.unit}`;
    valueEl.style.color = chart.color;

    // Calculate range
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;

    // Draw filled area + line
    const step = w / (config.historySize - 1);

    ctx.beginPath();
    ctx.moveTo(0, h);

    data.forEach((val, i) => {
      const x = (i + (config.historySize - data.length)) * step;
      const y = h - ((val - min) / range) * (h - 4) - 2;
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    // Close fill area
    const lastX = (data.length - 1 + (config.historySize - data.length)) * step;
    ctx.lineTo(lastX, h);
    ctx.closePath();

    // Fill gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, chart.color + '40'); // 25% opacity
    gradient.addColorStop(1, chart.color + '08'); // ~3% opacity
    ctx.fillStyle = gradient;
    ctx.fill();

    // Stroke line on top
    ctx.beginPath();
    data.forEach((val, i) => {
      const x = (i + (config.historySize - data.length)) * step;
      const y = h - ((val - min) / range) * (h - 4) - 2;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = chart.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Draw horizontal baseline guide
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();
  }

  // ─── Sample metrics ─────────────────────────────────────────

  function _sample() {
    // Bitrate
    const quality = player.getQualityInfo?.();
    const bitrateKbps = quality ? quality.bitrate / 1000 : 0;
    history.bitrate.push(bitrateKbps);

    // Buffer
    const bufferHealth = player.getBufferHealth?.();
    history.buffer.push(bufferHealth ? bufferHealth.ahead : 0);

    // Dropped frames
    const frames = player.getDroppedFrames?.();
    history.droppedFrames.push(frames ? frames.dropped : 0);

    // Latency
    const latency = player.getLiveLatency?.();
    history.latency.push(latency != null ? latency : 0);

    // Trim history
    Object.keys(history).forEach(key => {
      if (history[key].length > config.historySize) {
        history[key].shift();
      }
    });

    // Redraw all charts
    charts.forEach(c => _drawChart(c.key));
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  const panel = _buildUI();
  let intervalId = null;

  if (panel) {
    intervalId = setInterval(_sample, config.pollInterval);
    player._intervals.push(intervalId);
  }

  // Expose API
  player.metricsHistory = history;
  player.resetMetrics = function () {
    Object.keys(history).forEach(key => { history[key].length = 0; });
  };

  player._logSession('metrics-ready', { charts: charts.map(c => c.key) });
}
