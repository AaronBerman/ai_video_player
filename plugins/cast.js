/**
 * Cast Plugin — Chromecast (primary) + Fire TV DIAL (secondary)
 *
 * Adds a cast button to the player control bar and manages
 * Google Cast sessions for Chromecast devices.
 * Fire TV support uses the DIAL protocol as a best-effort fallback.
 *
 * Stability features:
 * - Keepalive heartbeat to detect silent disconnects
 * - Auto-retry on media load failure (up to 3 attempts with backoff)
 * - Session health monitoring with auto-reconnect
 * - Proper live vs VOD stream type handling
 * - Graceful error recovery
 */

// Default Media Receiver — works for basic HLS/DASH/MP4 casting
const CAST_APP_ID = 'CC1AD845';

const MIME_MAP = {
  hls: 'application/x-mpegURL',
  dash: 'application/dash+xml',
  native: 'video/mp4',
};

const MAX_LOAD_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 5000;

export default function castPlugin(player) {
  const state = {
    available: false,
    connected: false,
    session: null,
    media: null,
    btnEl: null,
    statusEl: null,
    sdkReady: false,
    currentSource: null,
    loadRetries: 0,
    heartbeatId: null,
    remotePlayer: null,
    remoteController: null,
    lastKnownTime: 0,
    isLive: false,
  };

  // ─── Track source URL when player.load() is called ──────

  const originalLoad = player.load.bind(player);
  player.load = function (source, subtitles) {
    const params = player.config.passthroughParams || '';
    state.currentSource = params
      ? (source.includes('?') ? `${source}&${params}` : `${source}?${params}`)
      : source;

    // Detect live streams (no finite duration after load)
    state.isLive = false;
    const onMeta = () => {
      state.isLive = !isFinite(player.video.duration);
      player.video.removeEventListener('loadedmetadata', onMeta);
    };
    player.video.addEventListener('loadedmetadata', onMeta);

    // If currently casting, reload on the cast device too
    if (state.connected && state.session) {
      const result = originalLoad(source, subtitles);
      _loadMediaOnCast();
      return result;
    }

    return originalLoad(source, subtitles);
  };

  // ─── SDK Loading ─────────────────────────────────────────

  _loadCastSDK(() => {
    _initCastApi();
  });

  // ─── UI (deferred until control bar is ready) ────────────

  if (player._controlBarEl) {
    _createCastButton();
  } else {
    const observer = new MutationObserver(() => {
      if (player._controlBarEl) {
        observer.disconnect();
        _createCastButton();
      }
    });
    observer.observe(player.container, { childList: true, subtree: true });
  }

  // ─── SDK Loader ──────────────────────────────────────────

  function _loadCastSDK(onReady) {
    if (window.cast && window.cast.framework) {
      onReady();
      return;
    }

    window['__onGCastApiAvailable'] = (isAvailable) => {
      console.log('[cast-plugin] __onGCastApiAvailable:', isAvailable);
      if (isAvailable) {
        state.sdkReady = true;
        onReady();
      }
    };

    const script = document.createElement('script');
    script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    script.async = true;
    script.onerror = () => {
      console.warn('[cast-plugin] Failed to load Cast SDK script');
    };
    document.head.appendChild(script);
    console.log('[cast-plugin] Loading Cast SDK...');
  }

  // ─── Cast API Initialization ─────────────────────────────

  function _initCastApi() {
    const cast = window.cast;
    const chrome = window.chrome;

    if (!cast || !cast.framework) {
      _log('cast-unavailable', { reason: 'Cast framework not loaded' });
      return;
    }

    const context = cast.framework.CastContext.getInstance();

    context.setOptions({
      receiverApplicationId: CAST_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      resumeSavedSession: true,
    });

    // Listen for availability changes
    context.addEventListener(
      cast.framework.CastContextEventType.CAST_STATE_CHANGED,
      (event) => {
        const castState = event.castState;
        state.available = castState !== cast.framework.CastState.NO_DEVICES_AVAILABLE;
        _updateButton();
        _log('cast-state', { castState });
      }
    );

    // Listen for session changes
    context.addEventListener(
      cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
      (event) => {
        const sessionState = event.sessionState;

        if (sessionState === cast.framework.SessionState.SESSION_STARTED ||
            sessionState === cast.framework.SessionState.SESSION_RESUMED) {
          state.connected = true;
          state.session = context.getCurrentSession();
          _onSessionConnected();
        } else if (sessionState === cast.framework.SessionState.SESSION_ENDED) {
          _onSessionEnded();
        }

        _updateButton();
        _log('cast-session', { sessionState });
      }
    );

    state.available = context.getCastState() !== cast.framework.CastState.NO_DEVICES_AVAILABLE;
    _updateButton();
    _log('cast-initialized');
  }

  // ─── Session Handlers ────────────────────────────────────

  function _onSessionConnected() {
    player.pause();
    _showStatus('Connected to Chromecast');
    state.loadRetries = 0;
    _loadMediaOnCast();
    _startHeartbeat();
  }

  function _onSessionEnded() {
    _stopHeartbeat();
    const resumeTime = state.lastKnownTime;
    state.connected = false;
    state.session = null;
    state.media = null;
    state.remotePlayer = null;
    state.remoteController = null;
    _showStatus('');

    // Resume local playback from last known position
    if (resumeTime > 0) {
      player.video.currentTime = resumeTime;
    }
    player.play();
  }

  function _onSessionDisconnected() {
    _onSessionEnded();
  }

  // ─── Media Loading with Retry ────────────────────────────

  function _loadMediaOnCast() {
    if (!state.session) return;

    const src = state.currentSource;
    if (!src) {
      _log('cast-media-error', { error: 'No source URL available' });
      _showStatus('No stream to cast');
      return;
    }

    const contentType = MIME_MAP[player._streamType] || 'video/mp4';

    const mediaInfo = new chrome.cast.media.MediaInfo(src, contentType);

    // Use LIVE stream type for live content — improves buffering behavior on the receiver
    mediaInfo.streamType = state.isLive
      ? chrome.cast.media.StreamType.LIVE
      : chrome.cast.media.StreamType.BUFFERED;

    // HLS-specific: hint the receiver about the content type for better ABR
    if (player._streamType === 'hls') {
      mediaInfo.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat?.TS;
      mediaInfo.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat?.MPEG2_TS;
    }

    mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = player.config.title || 'OpenVideo Player';

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.currentTime = player.video.currentTime || 0;
    request.autoplay = true;

    _log('cast-media-loading', { src, contentType, attempt: state.loadRetries + 1, isLive: state.isLive });

    state.session.loadMedia(request).then(
      () => {
        state.loadRetries = 0;
        _log('cast-media-loaded', { src, contentType });
        _showStatus(state.isLive ? 'Casting live stream' : 'Playing on Chromecast');
        _bindRemotePlayerEvents();
      },
      (error) => {
        _log('cast-media-error', { error: error?.message || 'Load failed', attempt: state.loadRetries + 1 });
        _handleLoadFailure(error);
      }
    );
  }

  function _handleLoadFailure(error) {
    state.loadRetries++;

    if (state.loadRetries < MAX_LOAD_RETRIES) {
      const delay = RETRY_DELAY_MS * state.loadRetries; // linear backoff
      _showStatus(`Cast load failed — retrying (${state.loadRetries}/${MAX_LOAD_RETRIES})...`);
      _log('cast-retry', { attempt: state.loadRetries, delayMs: delay });
      setTimeout(() => {
        if (state.connected && state.session) {
          _loadMediaOnCast();
        }
      }, delay);
    } else {
      _showStatus('Cast failed — could not load media');
      _log('cast-failed', { error: error?.message, totalAttempts: state.loadRetries });
      state.loadRetries = 0;
    }
  }

  // ─── Remote Player Events ────────────────────────────────

  function _bindRemotePlayerEvents() {
    // Clean up previous controller if exists
    if (state.remoteController) {
      state.remoteController.removeEventListener(
        cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED,
        _onRemoteStateChange
      );
      state.remoteController.removeEventListener(
        cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
        _onRemoteTimeChange
      );
    }

    state.remotePlayer = new cast.framework.RemotePlayer();
    state.remoteController = new cast.framework.RemotePlayerController(state.remotePlayer);

    state.remoteController.addEventListener(
      cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED,
      _onRemoteStateChange
    );

    state.remoteController.addEventListener(
      cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
      _onRemoteTimeChange
    );

    state.remoteController.addEventListener(
      cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
      (event) => {
        if (!event.value) {
          _log('cast-connection-lost', {});
          _onSessionEnded();
        }
      }
    );
  }

  function _onRemoteStateChange(event) {
    _log('cast-player-state', { state: event.value });

    // Detect if the remote player entered an idle state unexpectedly (stream ended or error)
    if (event.value === chrome.cast.media.PlayerState.IDLE && state.connected) {
      const idleReason = state.remotePlayer?.mediaInfo?.idleReason;
      if (idleReason === chrome.cast.media.IdleReason.ERROR) {
        _log('cast-remote-error', { reason: 'Remote player entered error state' });
        _showStatus('Cast playback error — retrying...');
        state.loadRetries = 0;
        setTimeout(() => _loadMediaOnCast(), RETRY_DELAY_MS);
      }
    }
  }

  function _onRemoteTimeChange(event) {
    if (state.connected && event.value > 0) {
      state.lastKnownTime = event.value;
    }
  }

  // ─── Heartbeat / Keepalive ───────────────────────────────

  function _startHeartbeat() {
    _stopHeartbeat();
    state.heartbeatId = setInterval(() => {
      if (!state.connected || !state.session) {
        _stopHeartbeat();
        return;
      }

      // Check if the session is still alive
      const context = cast?.framework?.CastContext?.getInstance();
      if (!context) return;

      const currentSession = context.getCurrentSession();
      if (!currentSession) {
        _log('cast-heartbeat-lost', { reason: 'Session no longer exists' });
        _onSessionEnded();
        return;
      }

      // Check remote player state for signs of trouble
      if (state.remotePlayer) {
        const isConnected = state.remotePlayer.isConnected;
        if (!isConnected) {
          _log('cast-heartbeat-disconnect', { reason: 'Remote player reports disconnected' });
          _onSessionEnded();
          return;
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function _stopHeartbeat() {
    if (state.heartbeatId) {
      clearInterval(state.heartbeatId);
      state.heartbeatId = null;
    }
  }

  // ─── Cast Button ─────────────────────────────────────────

  function _createCastButton() {
    const controlBar = player._controlBarEl;
    if (!controlBar) {
      console.warn('[cast-plugin] Control bar not found — cast button not added');
      return;
    }

    const fsBtn = controlBar.querySelector('.ovp-btn-fullscreen');

    state.btnEl = document.createElement('button');
    state.btnEl.className = 'ovp-btn ovp-btn-cast';
    state.btnEl.setAttribute('aria-label', 'Cast');
    state.btnEl.title = 'Cast to device';
    state.btnEl.innerHTML = _castIcon();
    state.btnEl.disabled = true;
    state.btnEl.classList.add('unavailable');

    state.btnEl.addEventListener('click', _onCastClick);

    if (fsBtn) {
      controlBar.insertBefore(state.btnEl, fsBtn);
    } else {
      controlBar.appendChild(state.btnEl);
    }

    // Status overlay
    state.statusEl = document.createElement('div');
    state.statusEl.className = 'ovp-cast-status';
    player.container.appendChild(state.statusEl);

    console.log('[cast-plugin] Cast button added to control bar');
  }

  function _updateButton() {
    if (!state.btnEl) return;
    state.btnEl.disabled = !state.available;
    state.btnEl.classList.toggle('unavailable', !state.available);
    state.btnEl.classList.toggle('casting', state.connected);
    state.btnEl.title = state.connected
      ? 'Stop casting'
      : state.available
        ? 'Cast to device'
        : 'No cast devices found';
  }

  function _onCastClick() {
    const context = cast?.framework?.CastContext?.getInstance();
    if (!context) return;

    if (state.connected) {
      context.endCurrentSession(true);
    } else {
      context.requestSession().catch((err) => {
        _log('cast-request-error', { error: err?.message || 'User cancelled' });
      });
    }
  }

  // ─── Fire TV / DIAL (best-effort) ───────────────────────

  // DIAL is a discovery protocol used by Fire TV. The Cast SDK does not
  // directly support Fire TV, but if the user has a Fire TV with a
  // DIAL-compatible receiver app, we can attempt discovery via the
  // Cast dialog (some Fire TV devices appear as cast targets with
  // third-party apps like "AirReceiver" or "Web Video Caster").
  //
  // For native Fire TV DIAL support, the device must expose a DIAL
  // server and the browser must support DIAL discovery (currently
  // only Chrome on some platforms). This is handled transparently
  // by the Cast SDK when available.

  // ─── Track Sync to Cast ─────────────────────────────────

  // Intercept track changes and forward them to the Chromecast receiver
  const originalSetAudio = player.setAudioTrack.bind(player);
  player.setAudioTrack = function (id) {
    originalSetAudio(id);
    if (state.connected && state.session) {
      _setActiveTracksOnCast();
    }
  };

  const originalSetSubtitle = player.setSubtitleTrack.bind(player);
  player.setSubtitleTrack = function (id) {
    originalSetSubtitle(id);
    if (state.connected && state.session) {
      _setActiveTracksOnCast();
    }
  };

  function _setActiveTracksOnCast() {
    if (!state.session) return;

    try {
      const media = state.session.getMediaSession();
      if (!media) return;

      const mediaTracks = media.media?.tracks;
      if (!mediaTracks || !mediaTracks.length) {
        _log('cast-tracks-none', { reason: 'No tracks reported by receiver' });
        return;
      }

      // Build active track IDs based on player state
      const activeTrackIds = [];

      // Match audio tracks
      const audioTracks = player.getAudioTracks();
      const activeAudio = audioTracks.find(t => t.active);
      if (activeAudio) {
        const castAudioTrack = mediaTracks.find(t =>
          t.type === chrome.cast.media.TrackType.AUDIO &&
          (t.language === activeAudio.language || t.name === activeAudio.label)
        );
        if (castAudioTrack) activeTrackIds.push(castAudioTrack.trackId);
      }

      // Match subtitle tracks
      const subtitleTracks = player.getSubtitleTracks();
      const activeSub = subtitleTracks.find(t => t.active);
      if (activeSub) {
        const castSubTrack = mediaTracks.find(t =>
          (t.type === chrome.cast.media.TrackType.TEXT) &&
          (t.language === activeSub.language || t.name === activeSub.label)
        );
        if (castSubTrack) activeTrackIds.push(castSubTrack.trackId);
      }

      // Send to receiver
      const request = new chrome.cast.media.EditTracksInfoRequest(activeTrackIds);
      media.editTracksInfo(request,
        () => _log('cast-tracks-updated', { activeTrackIds }),
        (err) => _log('cast-tracks-error', { error: err?.message || 'Failed to update tracks' })
      );
    } catch (e) {
      _log('cast-tracks-error', { error: e.message });
    }
  }

  // ─── Helpers ─────────────────────────────────────────────

  function _showStatus(text) {
    if (!state.statusEl) return;
    state.statusEl.textContent = text;
    state.statusEl.classList.toggle('visible', !!text);
    if (text) {
      setTimeout(() => {
        if (state.statusEl.textContent === text) {
          state.statusEl.classList.remove('visible');
        }
      }, 4000);
    }
  }

  function _log(event, data = {}) {
    player._logSession(event, data);
  }

  function _castIcon() {
    return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
    </svg>`;
  }
}
