const Hls = window.Hls;
const dashjs = window.dashjs;

const SUBTITLE_THEMES = {
  light: { bg: 'rgba(255,255,255,0.8)', color: '#000', size: '1.2em', extra: '' },
  'high-contrast': { bg: 'yellow', color: 'black', size: '1.4em', extra: 'font-weight:bold;border:2px solid black;' },
  default: { bg: 'rgba(0,0,0,0.6)', color: '#fff', size: '1.2em', extra: 'text-shadow:1px 1px 2px black;' },
};

const ERROR_CATEGORIES = {
  network: ['manifestLoadError', 'manifestLoadTimeOut', 'levelLoadError', 'levelLoadTimeOut', 'fragLoadError', 'fragLoadTimeOut'],
  decode: ['fragParsingError', 'bufferAppendError', 'bufferAppendingError'],
  media: ['bufferFullError', 'bufferStalledError', 'bufferNudgeOnStall'],
  source: ['manifestParsingError', 'manifestIncompatibleCodecsError', 'levelSwitchError'],
};

const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export default class OpenVideoPlayer {
  constructor(container, config = {}) {
    this.container = container;
    this.config = config;
    this.plugins = config.plugins || [];
    this.video = document.createElement('video');
    this.video.controls = config.controls ?? true;
    this.video.autoplay = config.autoplay ?? false;
    this.video.poster = config.poster || '';
    this.video.style.width = '100%';
    this.container.appendChild(this.video);

    this._hls = null;
    this._dash = null;
    this._currentSkin = null;
    this._subtitleStyle = null;
    this._destroyed = false;
    this._boundKeyHandler = null;
    this._intervals = [];

    // Diagnostics state
    this._sessionLog = [];
    this._networkLog = [];
    this._overlayVisible = false;
    this._overlayEl = null;
    this._streamType = null;

    // UI elements
    this._spinnerEl = null;
    this._errorEl = null;
    this._controlBarEl = null;

    this._applyPlugins();
    this._applySkin(config.skin || 'default');
    this._applySubtitleStyling(config.subtitleTheme || 'default');
    this._initDiagnostics();
    this._initCustomControls();
    this._initKeyboard();
  }

  // ─── Public API ─────────────────────────────────────────────

  load(source, subtitles = []) {
    this._clearError();
    this._logSession('load', { source });
    if (source.endsWith('.m3u8')) {
      this._streamType = 'hls';
      this._loadHLS(source);
    } else if (source.endsWith('.mpd')) {
      this._streamType = 'dash';
      this._loadDASH(source);
    } else {
      this._streamType = 'native';
      this._destroyInstances();
      this.video.src = source;
    }
    this._loadSubtitles(subtitles);
  }

  play() { this.video.play(); }
  pause() { this.video.pause(); }
  get element() { return this.video; }

  use(pluginFn) {
    if (typeof pluginFn === 'function') pluginFn(this);
  }

  destroy() {
    this._destroyed = true;
    this._destroyInstances();

    // Clear all intervals
    this._intervals.forEach(id => clearInterval(id));
    this._intervals = [];

    // Remove keyboard handler
    if (this._boundKeyHandler) {
      document.removeEventListener('keydown', this._boundKeyHandler);
      this._boundKeyHandler = null;
    }

    // Remove DOM
    this.container.innerHTML = '';

    this._logSession('destroyed');
  }

  // ─── Fullscreen ─────────────────────────────────────────────

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      this.container.requestFullscreen?.() ||
      this.container.webkitRequestFullscreen?.();
    }
  }

  get isFullscreen() {
    return document.fullscreenElement === this.container;
  }

  // ─── Audio Tracks ────────────────────────────────────────────

  getAudioTracks() {
    if (this._streamType === 'hls' && this._hls) {
      return (this._hls.audioTracks || []).map((t, i) => ({
        id: t.id ?? i,
        label: t.name || t.lang || `Track ${i + 1}`,
        language: t.lang || '',
        active: i === this._hls.audioTrack,
      }));
    }
    if (this._streamType === 'dash' && this._dash) {
      try {
        const tracks = this._dash.getTracksFor('audio') || [];
        const current = this._dash.getCurrentTrackFor('audio');
        return tracks.map((t, i) => ({
          id: t.index ?? i,
          label: t.labels?.[0]?.text || t.lang || `Track ${i + 1}`,
          language: t.lang || '',
          active: current && current.index === t.index,
        }));
      } catch (e) { return []; }
    }
    // Native: use HTMLMediaElement audioTracks if available
    const native = this.video.audioTracks;
    if (native && native.length) {
      return Array.from(native).map((t, i) => ({
        id: t.id ?? i,
        label: t.label || t.language || `Track ${i + 1}`,
        language: t.language || '',
        active: t.enabled,
      }));
    }
    return [];
  }

  setAudioTrack(id) {
    if (this._streamType === 'hls' && this._hls) {
      this._hls.audioTrack = id;
      this._logSession('audio-track-change', { id });
      return;
    }
    if (this._streamType === 'dash' && this._dash) {
      const tracks = this._dash.getTracksFor('audio') || [];
      const target = tracks.find(t => (t.index ?? 0) === id);
      if (target) {
        this._dash.setCurrentTrack(target);
        this._logSession('audio-track-change', { id });
      }
      return;
    }
    // Native audioTracks
    const native = this.video.audioTracks;
    if (native && native.length) {
      for (let i = 0; i < native.length; i++) {
        native[i].enabled = (native[i].id == id || i === id);
      }
      this._logSession('audio-track-change', { id });
    }
  }

  // ─── Subtitle / Text Tracks ─────────────────────────────────

  getSubtitleTracks() {
    if (this._streamType === 'hls' && this._hls) {
      return (this._hls.subtitleTracks || []).map((t, i) => ({
        id: t.id ?? i,
        label: t.name || t.lang || `Subtitle ${i + 1}`,
        language: t.lang || '',
        active: i === this._hls.subtitleTrack,
      }));
    }
    if (this._streamType === 'dash' && this._dash) {
      try {
        const tracks = this._dash.getTracksFor('text') || [];
        const current = this._dash.getCurrentTrackFor('text');
        return tracks.map((t, i) => ({
          id: t.index ?? i,
          label: t.labels?.[0]?.text || t.lang || `Subtitle ${i + 1}`,
          language: t.lang || '',
          active: current && current.index === t.index,
        }));
      } catch (e) { return []; }
    }
    // Native text tracks
    const tracks = this.video.textTracks;
    if (tracks && tracks.length) {
      return Array.from(tracks).map((t, i) => ({
        id: i,
        label: t.label || t.language || `Subtitle ${i + 1}`,
        language: t.language || '',
        active: t.mode === 'showing',
      }));
    }
    return [];
  }

  setSubtitleTrack(id) {
    if (this._streamType === 'hls' && this._hls) {
      this._hls.subtitleTrack = id; // -1 to disable
      this._logSession('subtitle-track-change', { id });
      return;
    }
    if (this._streamType === 'dash' && this._dash) {
      if (id === -1) {
        this._dash.setTextTrack(-1);
      } else {
        const tracks = this._dash.getTracksFor('text') || [];
        const target = tracks.find(t => (t.index ?? 0) === id);
        if (target) this._dash.setCurrentTrack(target);
      }
      this._logSession('subtitle-track-change', { id });
      return;
    }
    // Native text tracks
    const tracks = this.video.textTracks;
    if (tracks && tracks.length) {
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].mode = (i === id) ? 'showing' : 'hidden';
      }
      this._logSession('subtitle-track-change', { id });
    }
  }

  // ─── Playback Speed ─────────────────────────────────────────

  setSpeed(rate) {
    const clamped = Math.max(0.25, Math.min(4, rate));
    this.video.playbackRate = clamped;
    this._logSession('speed-change', { rate: clamped });
    this._updateSpeedDisplay();
  }

  getSpeed() {
    return this.video.playbackRate;
  }

  cycleSpeed() {
    const current = this.video.playbackRate;
    const idx = PLAYBACK_SPEEDS.indexOf(current);
    const next = idx === -1 || idx === PLAYBACK_SPEEDS.length - 1
      ? PLAYBACK_SPEEDS[0]
      : PLAYBACK_SPEEDS[idx + 1];
    this.setSpeed(next);
  }

  // ─── Volume ─────────────────────────────────────────────────

  setVolume(level) {
    this.video.volume = Math.max(0, Math.min(1, level));
    this.video.muted = false;
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    this._logSession(this.video.muted ? 'muted' : 'unmuted');
  }

  // ─── Diagnostics Public API ─────────────────────────────────

  toggleOverlay() {
    this._overlayVisible = !this._overlayVisible;
    if (this._overlayEl) {
      this._overlayEl.style.display = this._overlayVisible ? 'block' : 'none';
    }
    if (this._overlayVisible) this._updateOverlay();
  }

  getSessionLog() { return [...this._sessionLog]; }
  getNetworkLog() { return [...this._networkLog]; }

  getBufferHealth() {
    const buffered = this.video.buffered;
    if (!buffered.length) return { ahead: 0, ranges: [] };
    const current = this.video.currentTime;
    const ranges = [];
    let ahead = 0;
    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);
      ranges.push({ start, end });
      if (current >= start && current <= end) {
        ahead = end - current;
      }
    }
    return { ahead: Math.round(ahead * 100) / 100, ranges };
  }

  getLiveLatency() {
    if (this._streamType === 'hls' && this._hls) {
      return Math.round((this._hls.latency || 0) * 100) / 100;
    }
    if (this._streamType === 'dash' && this._dash) {
      try {
        return Math.round((this._dash.getCurrentLiveLatency() || 0) * 100) / 100;
      } catch (e) { return null; }
    }
    return null;
  }

  getQualityInfo() {
    if (this._streamType === 'hls' && this._hls) {
      const level = this._hls.levels[this._hls.currentLevel];
      if (!level) return null;
      return {
        bitrate: level.bitrate,
        width: level.width,
        height: level.height,
        codec: level.codecSet || level.videoCodec || 'unknown',
        currentLevel: this._hls.currentLevel,
        totalLevels: this._hls.levels.length,
      };
    }
    if (this._streamType === 'dash' && this._dash) {
      try {
        const quality = this._dash.getQualityFor('video');
        const info = this._dash.getBitrateInfoListFor('video')[quality];
        if (!info) return null;
        return {
          bitrate: info.bitrate,
          width: info.width,
          height: info.height,
          codec: info.codec || 'unknown',
          currentLevel: quality,
          totalLevels: this._dash.getBitrateInfoListFor('video').length,
        };
      } catch (e) { return null; }
    }
    return null;
  }

  getDroppedFrames() {
    const quality = this.video.getVideoPlaybackQuality?.();
    if (!quality) return { dropped: 0, total: 0 };
    return {
      dropped: quality.droppedVideoFrames || 0,
      total: quality.totalVideoFrames || 0,
    };
  }

  // ─── Custom Controls ────────────────────────────────────────

  _initCustomControls() {
    this.container.style.position = 'relative';

    // Spinner
    this._spinnerEl = document.createElement('div');
    this._spinnerEl.className = 'ovp-spinner';
    this._spinnerEl.setAttribute('aria-hidden', 'true');
    this.container.appendChild(this._spinnerEl);

    // Error display
    this._errorEl = document.createElement('div');
    this._errorEl.className = 'ovp-error';
    this._errorEl.setAttribute('role', 'alert');
    this.container.appendChild(this._errorEl);

    // Custom control bar
    this._controlBarEl = document.createElement('div');
    this._controlBarEl.className = 'ovp-control-bar';
    this._controlBarEl.innerHTML = `
      <button class="ovp-btn ovp-btn-play" aria-label="Play/Pause" title="Play/Pause (Space)">▶</button>
      <button class="ovp-btn ovp-btn-mute" aria-label="Mute" title="Mute (M)">🔊</button>
      <input type="range" class="ovp-volume-slider" min="0" max="1" step="0.05" value="1" aria-label="Volume">
      <span class="ovp-time">0:00 / 0:00</span>
      <span class="ovp-spacer"></span>
      <button class="ovp-btn ovp-btn-tracks" aria-label="Audio & Subtitles" title="Tracks">CC</button>
      <button class="ovp-btn ovp-btn-speed" aria-label="Playback speed" title="Speed (S)">1x</button>
      <button class="ovp-btn ovp-btn-fullscreen" aria-label="Fullscreen" title="Fullscreen (F)">⛶</button>
    `;
    this.container.appendChild(this._controlBarEl);

    // Track menu (hidden by default)
    this._trackMenuEl = document.createElement('div');
    this._trackMenuEl.className = 'ovp-track-menu';
    this._trackMenuEl.setAttribute('role', 'menu');
    this.container.appendChild(this._trackMenuEl);

    this._bindControlEvents();
    this._bindLoadingStates();
  }

  _bindControlEvents() {
    const bar = this._controlBarEl;

    // Play/Pause
    const playBtn = bar.querySelector('.ovp-btn-play');
    playBtn.addEventListener('click', () => {
      this.video.paused ? this.video.play() : this.video.pause();
    });
    this.video.addEventListener('play', () => { playBtn.textContent = '⏸'; });
    this.video.addEventListener('pause', () => { playBtn.textContent = '▶'; });

    // Mute
    const muteBtn = bar.querySelector('.ovp-btn-mute');
    muteBtn.addEventListener('click', () => this.toggleMute());
    this.video.addEventListener('volumechange', () => {
      muteBtn.textContent = this.video.muted || this.video.volume === 0 ? '🔇' : '🔊';
    });

    // Volume slider
    const volSlider = bar.querySelector('.ovp-volume-slider');
    volSlider.addEventListener('input', (e) => {
      this.setVolume(parseFloat(e.target.value));
    });
    this.video.addEventListener('volumechange', () => {
      volSlider.value = this.video.muted ? 0 : this.video.volume;
    });

    // Time display
    const timeEl = bar.querySelector('.ovp-time');
    const updateTime = () => {
      const cur = this._formatTime(this.video.currentTime);
      const dur = this._formatTime(this.video.duration || 0);
      timeEl.textContent = `${cur} / ${dur}`;
    };
    this.video.addEventListener('timeupdate', updateTime);
    this.video.addEventListener('loadedmetadata', updateTime);

    // Speed
    const speedBtn = bar.querySelector('.ovp-btn-speed');
    speedBtn.addEventListener('click', () => this.cycleSpeed());

    // Tracks menu
    const tracksBtn = bar.querySelector('.ovp-btn-tracks');
    tracksBtn.addEventListener('click', () => this._toggleTrackMenu());

    // Close track menu when clicking outside
    document.addEventListener('click', (e) => {
      if (this._trackMenuEl && !this._trackMenuEl.contains(e.target) && e.target !== tracksBtn) {
        this._trackMenuEl.classList.remove('visible');
      }
    });

    // Fullscreen
    const fsBtn = bar.querySelector('.ovp-btn-fullscreen');
    fsBtn.addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => {
      fsBtn.textContent = this.isFullscreen ? '⛶' : '⛶';
      this.container.classList.toggle('ovp-fullscreen', this.isFullscreen);
    });
  }

  _bindLoadingStates() {
    // Show spinner on waiting/loading
    this.video.addEventListener('waiting', () => {
      this._spinnerEl.classList.add('visible');
    });
    this.video.addEventListener('playing', () => {
      this._spinnerEl.classList.remove('visible');
    });
    this.video.addEventListener('canplay', () => {
      this._spinnerEl.classList.remove('visible');
    });
    this.video.addEventListener('seeking', () => {
      this._spinnerEl.classList.add('visible');
    });
    this.video.addEventListener('seeked', () => {
      this._spinnerEl.classList.remove('visible');
    });

    // Show error state
    this.video.addEventListener('error', () => {
      this._showError(this.video.error?.message || 'Playback error occurred');
    });
  }

  _showError(message) {
    this._errorEl.textContent = `⚠ ${message}`;
    this._errorEl.classList.add('visible');
  }

  _clearError() {
    this._errorEl.classList.remove('visible');
    this._errorEl.textContent = '';
  }

  _updateSpeedDisplay() {
    const btn = this._controlBarEl?.querySelector('.ovp-btn-speed');
    if (btn) btn.textContent = `${this.video.playbackRate}x`;
  }

  _toggleTrackMenu() {
    if (!this._trackMenuEl) return;
    const isVisible = this._trackMenuEl.classList.toggle('visible');
    if (isVisible) this._renderTrackMenu();
  }

  _renderTrackMenu() {
    const menu = this._trackMenuEl;
    const audioTracks = this.getAudioTracks();
    const subtitleTracks = this.getSubtitleTracks();

    let html = '';

    // Subtitle section
    html += '<div class="ovp-track-section">';
    html += '<div class="ovp-track-section-title">Subtitles</div>';
    html += `<button class="ovp-track-option${subtitleTracks.every(t => !t.active) ? ' active' : ''}" data-type="subtitle" data-id="-1">Off</button>`;
    subtitleTracks.forEach(t => {
      html += `<button class="ovp-track-option${t.active ? ' active' : ''}" data-type="subtitle" data-id="${t.id}">${t.label}</button>`;
    });
    html += '</div>';

    // Audio section (only show if multiple audio tracks)
    if (audioTracks.length > 1) {
      html += '<div class="ovp-track-section">';
      html += '<div class="ovp-track-section-title">Audio</div>';
      audioTracks.forEach(t => {
        html += `<button class="ovp-track-option${t.active ? ' active' : ''}" data-type="audio" data-id="${t.id}">${t.label}</button>`;
      });
      html += '</div>';
    }

    if (!subtitleTracks.length && audioTracks.length <= 1) {
      html = '<div class="ovp-track-section"><div class="ovp-track-section-title">No tracks available</div></div>';
    }

    menu.innerHTML = html;

    // Bind click events
    menu.querySelectorAll('.ovp-track-option').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const type = e.target.dataset.type;
        const id = parseInt(e.target.dataset.id, 10);
        if (type === 'subtitle') {
          this.setSubtitleTrack(id);
        } else if (type === 'audio') {
          this.setAudioTrack(id);
        }
        this._renderTrackMenu(); // re-render to update active state
      });
    });
  }

  _formatTime(seconds) {
    if (!isFinite(seconds)) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ─── Keyboard Shortcuts ─────────────────────────────────────

  _initKeyboard() {
    this._boundKeyHandler = (e) => {
      // Don't capture if user is typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (this._destroyed) return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          this.video.paused ? this.video.play() : this.video.pause();
          break;
        case 'f':
          e.preventDefault();
          this.toggleFullscreen();
          break;
        case 'm':
          e.preventDefault();
          this.toggleMute();
          break;
        case 'arrowleft':
          e.preventDefault();
          this.video.currentTime = Math.max(0, this.video.currentTime - 5);
          break;
        case 'arrowright':
          e.preventDefault();
          this.video.currentTime = Math.min(this.video.duration || 0, this.video.currentTime + 5);
          break;
        case 'arrowup':
          e.preventDefault();
          this.setVolume(this.video.volume + 0.1);
          break;
        case 'arrowdown':
          e.preventDefault();
          this.setVolume(this.video.volume - 0.1);
          break;
        case 's':
          e.preventDefault();
          this.cycleSpeed();
          break;
        case 'j':
          e.preventDefault();
          this.video.currentTime = Math.max(0, this.video.currentTime - 10);
          break;
        case 'l':
          e.preventDefault();
          this.video.currentTime = Math.min(this.video.duration || 0, this.video.currentTime + 10);
          break;
        case '0':
        case 'home':
          e.preventDefault();
          this.video.currentTime = 0;
          break;
      }
    };
    document.addEventListener('keydown', this._boundKeyHandler);
  }

  // ─── Diagnostics Internals ──────────────────────────────────

  _initDiagnostics() {
    this._createOverlay();
    this._bindVideoEvents();
    this._startBufferMonitor();
  }

  _createOverlay() {
    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'ovp-debug-overlay';
    this._overlayEl.style.display = 'none';
    this.container.style.position = 'relative';
    this.container.appendChild(this._overlayEl);

    const id = setInterval(() => {
      if (this._overlayVisible) this._updateOverlay();
    }, 1000);
    this._intervals.push(id);
  }

  _updateOverlay() {
    const quality = this.getQualityInfo();
    const buffer = this.getBufferHealth();
    const frames = this.getDroppedFrames();
    const latency = this.getLiveLatency();

    let html = '<div class="ovp-debug-title">Stream Diagnostics</div>';

    if (quality) {
      html += `<div class="ovp-debug-row"><span>Bitrate:</span> ${(quality.bitrate / 1000).toFixed(0)} kbps</div>`;
      html += `<div class="ovp-debug-row"><span>Resolution:</span> ${quality.width}×${quality.height}</div>`;
      html += `<div class="ovp-debug-row"><span>Codec:</span> ${quality.codec}</div>`;
      html += `<div class="ovp-debug-row"><span>Level:</span> ${quality.currentLevel + 1}/${quality.totalLevels}</div>`;
    }

    html += `<div class="ovp-debug-row"><span>Buffer:</span> ${buffer.ahead}s ahead</div>`;
    html += `<div class="ovp-debug-row"><span>Dropped frames:</span> ${frames.dropped}/${frames.total}</div>`;

    if (latency !== null) {
      html += `<div class="ovp-debug-row"><span>Live latency:</span> ${latency}s</div>`;
    }

    html += `<div class="ovp-debug-row"><span>Speed:</span> ${this.video.playbackRate}x</div>`;
    html += `<div class="ovp-debug-row"><span>Type:</span> ${this._streamType || 'none'}</div>`;

    this._overlayEl.innerHTML = html;
  }

  _startBufferMonitor() {
    const id = setInterval(() => {
      const buffer = this.getBufferHealth();
      if (buffer.ahead > 0 && buffer.ahead < 2 && !this.video.paused) {
        this._logSession('buffer-warning', { ahead: buffer.ahead });
      }
    }, 2000);
    this._intervals.push(id);
  }

  _bindVideoEvents() {
    const events = ['play', 'pause', 'seeking', 'seeked', 'waiting', 'stalled', 'ended', 'canplay', 'loadedmetadata'];
    events.forEach(evt => {
      this.video.addEventListener(evt, () => {
        this._logSession(evt, { currentTime: Math.round(this.video.currentTime * 100) / 100 });
      });
    });

    this.video.addEventListener('error', () => {
      const err = this.video.error;
      this._logSession('error', {
        category: 'media',
        code: err?.code,
        message: err?.message || 'Unknown media error',
      });
    });
  }

  _classifyError(errorType, details) {
    for (const [category, types] of Object.entries(ERROR_CATEGORIES)) {
      if (types.includes(errorType)) {
        return { category, type: errorType, details };
      }
    }
    return { category: 'unknown', type: errorType, details };
  }

  _logSession(event, data = {}) {
    const entry = {
      timestamp: Date.now(),
      time: new Date().toISOString(),
      event,
      ...data,
    };
    this._sessionLog.push(entry);
    if (this._sessionLog.length > 500) this._sessionLog.shift();
    this.video.dispatchEvent(new CustomEvent('ovp-session-log', { detail: entry }));
  }

  _logNetwork(entry) {
    this._networkLog.push(entry);
    if (this._networkLog.length > 200) this._networkLog.shift();
    this.video.dispatchEvent(new CustomEvent('ovp-network-log', { detail: entry }));
  }

  _destroyInstances() {
    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }
    if (this._dash) {
      this._dash.reset();
      this._dash = null;
    }
  }

  _loadHLS(src) {
    this._destroyInstances();
    if (Hls.isSupported()) {
      // Merge DRM config if available (from drm plugin)
      const drmConfig = typeof this._getDrmHlsConfig === 'function' ? this._getDrmHlsConfig() : {};
      this._hls = new Hls(drmConfig);
      this._bindHLSEvents(this._hls);
      this._hls.loadSource(this._appendPassthroughParams(src));
      this._hls.attachMedia(this.video);
      if (drmConfig.emeEnabled) {
        this._logSession('drm-active', { protocol: 'hls', systems: Object.keys(drmConfig.drmSystems || {}) });
      }
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = this._appendPassthroughParams(src);
    } else {
      console.error('HLS is not supported in this browser');
      this._logSession('error', { category: 'source', message: 'HLS not supported' });
      this._showError('HLS playback is not supported in this browser');
    }
  }

  _bindHLSEvents(hls) {
    hls.on(Hls.Events.MANIFEST_LOADED, (_, data) => {
      this._logSession('manifest-loaded', { levels: data.levels?.length || 0 });
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      const level = hls.levels[data.level];
      this._logSession('quality-switch', {
        level: data.level,
        bitrate: level?.bitrate,
        resolution: level ? `${level.width}x${level.height}` : 'unknown',
      });
    });

    hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
      const frag = data.frag;
      const stats = data.stats || frag.stats;
      this._logNetwork({
        timestamp: Date.now(),
        type: 'segment',
        url: frag.url,
        duration: frag.duration,
        level: frag.level,
        loadTimeMs: stats ? stats.loading.end - stats.loading.start : null,
        bytes: stats?.total || null,
      });
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      const classified = this._classifyError(data.details, {
        fatal: data.fatal,
        type: data.type,
        reason: data.reason,
        url: data.frag?.url || data.url,
        response: data.response ? { code: data.response.code } : null,
      });
      this._logSession('error', classified);

      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            this._logSession('recovery-attempt', { action: 'startLoad' });
            this._showError('Network error — attempting recovery...');
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            this._logSession('recovery-attempt', { action: 'recoverMediaError' });
            this._showError('Media error — attempting recovery...');
            hls.recoverMediaError();
            break;
          default:
            this._logSession('fatal-error', { message: 'Cannot recover' });
            this._showError('Fatal playback error — cannot recover');
            break;
        }
      }
    });

    hls.on(Hls.Events.BUFFER_APPENDED, () => {
      const buffer = this.getBufferHealth();
      if (buffer.ahead < 1 && !this.video.paused) {
        this._logSession('buffer-critical', { ahead: buffer.ahead });
      }
    });

    // Clear error on successful recovery
    hls.on(Hls.Events.FRAG_LOADED, () => {
      this._clearError();
    });
  }

  _loadDASH(src) {
    this._destroyInstances();
    this._dash = dashjs.MediaPlayer().create();

    // Apply DRM protection data if available (from drm plugin)
    const drmProtection = typeof this._getDrmDashConfig === 'function' ? this._getDrmDashConfig() : null;
    if (drmProtection) {
      this._dash.setProtectionData(drmProtection);
      this._logSession('drm-active', { protocol: 'dash', systems: Object.keys(drmProtection) });
    }

    this._bindDASHEvents(this._dash);
    this._dash.initialize(this.video, this._appendPassthroughParams(src), this.config.autoplay ?? false);
  }

  _bindDASHEvents(player) {
    player.on(dashjs.MediaPlayer.events.MANIFEST_LOADED, () => {
      this._logSession('manifest-loaded', { type: 'dash' });
    });

    player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, (e) => {
      if (e.mediaType === 'video') {
        const info = player.getBitrateInfoListFor('video')[e.newQuality];
        this._logSession('quality-switch', {
          level: e.newQuality,
          bitrate: info?.bitrate,
          resolution: info ? `${info.width}x${info.height}` : 'unknown',
        });
      }
    });

    player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, (e) => {
      if (e.request) {
        this._logNetwork({
          timestamp: Date.now(),
          type: 'segment',
          url: e.request.url,
          mediaType: e.request.mediaType,
          duration: e.request.duration,
          loadTimeMs: e.request.requestEndDate - e.request.requestStartDate,
          bytes: e.request.bytesTotal || null,
        });
      }
    });

    player.on(dashjs.MediaPlayer.events.ERROR, (e) => {
      this._logSession('error', {
        category: 'network',
        type: e.error?.code || 'dash-error',
        message: e.error?.message || 'DASH playback error',
      });
      this._showError(e.error?.message || 'DASH playback error');
    });
  }

  _loadSubtitles(tracks) {
    this.video.querySelectorAll('track').forEach(t => t.remove());
    tracks.forEach(track => {
      const el = Object.assign(document.createElement('track'), {
        kind: track.kind || 'subtitles',
        label: track.label,
        srclang: track.srclang,
        src: track.src,
        default: !!track.default,
      });
      this.video.appendChild(el);
    });
  }

  _applySubtitleStyling(theme) {
    if (!this._subtitleStyle) {
      this._subtitleStyle = document.createElement('style');
      document.head.appendChild(this._subtitleStyle);
    }
    const t = SUBTITLE_THEMES[theme] || SUBTITLE_THEMES.default;
    this._subtitleStyle.textContent = `video::cue { background:${t.bg}; color:${t.color}; font-size:${t.size}; padding:0.2em 0.4em; border-radius:0.2em; ${t.extra} }`;
  }

  _applySkin(skin) {
    if (this._currentSkin) this.video.classList.remove(this._currentSkin);
    this._currentSkin = `skin-${skin}`;
    this.video.classList.add(this._currentSkin);
  }

  _applyPlugins() {
    this.plugins.forEach(p => this.use(p));
  }

  _appendPassthroughParams(src) {
    const params = this.config.passthroughParams || '';
    if (!params) return src;
    return src.includes('?') ? `${src}&${params}` : `${src}?${params}`;
  }
}
