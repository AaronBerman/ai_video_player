/**
 * DRM Plugin for OpenVideo Player
 *
 * Configures Widevine, PlayReady, and FairPlay DRM for HLS (via hls.js EME)
 * and DASH (via dash.js native DRM support).
 *
 * Usage:
 *   import drmPlugin from './plugins/drm.js';
 *   const player = new OpenVideoPlayer(container, {
 *     plugins: [drmPlugin({ widevine: { url: '...' }, playready: { url: '...' }, fairplay: { url: '...', cert: '...' } })]
 *   });
 *
 * You can also update DRM config at runtime:
 *   player.drmConfig = { widevine: { url: 'https://...', headers: {} } };
 */

export default function drmPlugin(config = {}) {
  return function (player) {
    // Store DRM config on the player instance for access during load
    player.drmConfig = {
      widevine: config.widevine || null,   // { url, headers? }
      playready: config.playready || null, // { url, headers? }
      fairplay: config.fairplay || null,   // { url, certificateUrl?, headers? }
    };

    /**
     * Build hls.js emeEnabled + drmSystems config
     * hls.js v1.4+ supports native EME via config
     */
    player._getDrmHlsConfig = function () {
      const drm = this.drmConfig;
      if (!drm || (!drm.widevine && !drm.playready && !drm.fairplay)) return {};

      const hlsDrm = { emeEnabled: true, drmSystems: {} };

      if (drm.widevine && drm.widevine.url) {
        hlsDrm.drmSystems['com.widevine.alpha'] = {
          licenseUrl: drm.widevine.url,
        };
        if (drm.widevine.headers) {
          hlsDrm.licenseXhrSetup = function (xhr) {
            Object.entries(drm.widevine.headers).forEach(([k, v]) => {
              xhr.setRequestHeader(k, v);
            });
          };
        }
      }

      if (drm.fairplay && drm.fairplay.url) {
        hlsDrm.drmSystems['com.apple.fps.1_0'] = {
          licenseUrl: drm.fairplay.url,
          serverCertificateUrl: drm.fairplay.certificateUrl || undefined,
        };
      }

      if (drm.playready && drm.playready.url) {
        hlsDrm.drmSystems['com.microsoft.playready'] = {
          licenseUrl: drm.playready.url,
        };
      }

      return hlsDrm;
    };

    /**
     * Build dash.js protection data object
     */
    player._getDrmDashConfig = function () {
      const drm = this.drmConfig;
      if (!drm || (!drm.widevine && !drm.playready && !drm.fairplay)) return null;

      const protection = {};

      if (drm.widevine && drm.widevine.url) {
        protection['com.widevine.alpha'] = {
          serverURL: drm.widevine.url,
        };
        if (drm.widevine.headers) {
          protection['com.widevine.alpha'].httpRequestHeaders = drm.widevine.headers;
        }
      }

      if (drm.playready && drm.playready.url) {
        protection['com.microsoft.playready'] = {
          serverURL: drm.playready.url,
        };
        if (drm.playready.headers) {
          protection['com.microsoft.playready'].httpRequestHeaders = drm.playready.headers;
        }
      }

      if (drm.fairplay && drm.fairplay.url) {
        protection['com.apple.fps.1_0'] = {
          serverURL: drm.fairplay.url,
        };
        if (drm.fairplay.certificateUrl) {
          protection['com.apple.fps.1_0'].serverCertificateURL = drm.fairplay.certificateUrl;
        }
        if (drm.fairplay.headers) {
          protection['com.apple.fps.1_0'].httpRequestHeaders = drm.fairplay.headers;
        }
      }

      return protection;
    };

    player._logSession?.('drm-plugin-loaded', { systems: Object.keys(config).filter(k => config[k]) });
  };
}
