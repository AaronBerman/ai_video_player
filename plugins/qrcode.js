/**
 * QR Code Plugin for OpenVideo Player
 *
 * Generates a QR code overlay encoding the current stream URL so you can
 * scan it with your phone camera to capture the ingest URL.
 *
 * Requires qrcode-generator library loaded via CDN (window.qrcode).
 *
 * Usage:
 *   import qrcodePlugin from './plugins/qrcode.js';
 *   const player = new OpenVideoPlayer(container, { plugins: [qrcodePlugin] });
 *
 * The plugin adds:
 *   - player.showQRCode()   — show the QR overlay with the current URL
 *   - player.hideQRCode()   — hide the QR overlay
 *   - player.toggleQRCode() — toggle visibility
 */

export default function qrcodePlugin(player) {
  // Create overlay container
  const overlay = document.createElement('div');
  overlay.className = 'ovp-qr-overlay';
  overlay.setAttribute('aria-label', 'QR code for stream URL');
  overlay.setAttribute('role', 'img');

  // QR canvas container
  const qrContainer = document.createElement('div');
  qrContainer.className = 'ovp-qr-canvas';
  overlay.appendChild(qrContainer);

  // URL label below QR
  const urlLabel = document.createElement('div');
  urlLabel.className = 'ovp-qr-url';
  overlay.appendChild(urlLabel);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ovp-qr-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close QR code');
  closeBtn.addEventListener('click', () => player.hideQRCode());
  overlay.appendChild(closeBtn);

  player.container.style.position = 'relative';
  player.container.appendChild(overlay);

  // Track the current source URL
  let currentUrl = '';

  // Intercept load to track URL
  const originalLoad = player.load.bind(player);
  player.load = function (source, subtitles) {
    currentUrl = source;
    originalLoad(source, subtitles);
  };

  /**
   * Generate QR code using qrcode-generator library
   */
  function generateQR(text) {
    qrContainer.innerHTML = '';

    const qrGen = window.qrcode;
    if (!qrGen) {
      qrContainer.textContent = 'QR library not loaded';
      return;
    }

    // Auto-detect error correction and type number
    const qr = qrGen(0, 'M');
    qr.addData(text);
    qr.make();

    // Render as an img element (SVG data URI for crisp scaling)
    const cellSize = 4;
    const margin = 4;
    const moduleCount = qr.getModuleCount();
    const size = moduleCount * cellSize + margin * 2;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.imageRendering = 'pixelated';

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';

    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(
            col * cellSize + margin,
            row * cellSize + margin,
            cellSize,
            cellSize
          );
        }
      }
    }

    qrContainer.appendChild(canvas);
  }

  player.showQRCode = function () {
    const url = currentUrl || 'No URL loaded';
    generateQR(url);

    // Truncate display URL for readability
    const displayUrl = url.length > 60 ? url.substring(0, 57) + '...' : url;
    urlLabel.textContent = displayUrl;
    urlLabel.title = url;

    overlay.classList.add('visible');
    player._logSession?.('qr-shown', { url });
  };

  player.hideQRCode = function () {
    overlay.classList.remove('visible');
    player._logSession?.('qr-hidden');
  };

  player.toggleQRCode = function () {
    if (overlay.classList.contains('visible')) {
      player.hideQRCode();
    } else {
      player.showQRCode();
    }
  };

  player._logSession?.('qrcode-plugin-loaded');
}
