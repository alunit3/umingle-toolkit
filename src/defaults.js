/*
 * Umingle Toolkit - shared defaults.
 *
 * Loaded by:
 *   - the isolated-world bridge (content script)
 *   - the popup (plain <script> before popup.js)
 *   - the service worker (importScripts)
 *
 * Everything lives under chrome.storage.sync as individual keys so a
 * storage.onChanged listener can react to one setting at a time.
 */
(function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    // Master switch. When off, every runtime feature and every injected
    // element is disabled (the page itself is left alone).
    enabled: true,

    // --- Premium simulation -------------------------------------------------
    // Draw the Premium skin (badge, banner, "Extend" button). The vip_expiry
    // key is still written while autoSkip is on, because the site's own
    // country-filter click gate reads it.
    premium: true,
    premiumHours: 24,
    // Hide the free-skip nag. The wait itself is server-side.
    hideThrottle: true,

    // --- Matching -----------------------------------------------------------
    // Make the country filter real: leave strangers whose country is not
    // selected in the site's own filter UI.
    autoSkip: true,
    // One click on the Skip button leaves the stranger at once. The page's own
    // flow needs two presses ("Skip" then "Really?"); the toolkit sends both
    // in the same instant and hides the confirmation step.
    easySkip: true,
    // Restore the last selected countries after a reload.
    rememberFilter: true,
    filterCountries: [],
    // Never talk to strangers from these countries (2-letter codes).
    blockCountries: [],
    // Leave a stranger whose country the server did not report.
    skipUnknownCountry: false,
    // Auto-leave a stranger the server marked as shadowbanned (they cannot
    // see or hear you, so the call is dead). Off by default; the banner still
    // offers a Skip button.
    skipShadowbanned: false,
    // Leave a call that never produces video (or freezes) for N seconds.
    skipStalled: false,
    stallSeconds: 10,

    // --- Display ------------------------------------------------------------
    // IP-based city/ISP/local-time line under the country row.
    cityLookup: true,
    // Connection HUD (P2P/TURN, resolution, fps, in/out bitrate, RTT, timer).
    hud: true,
    // Tab title shows the current country and match time.
    matchTitle: true,
    // Own preview: mirror (site default) | normal (unmirrored) | hidden.
    selfView: 'mirror',
    // Banner when the server marks this stranger as shadowbanned.
    shadowbanAlert: true,
    // In-video toolbar (PiP, volume boost, mute, HUD, snapshot, menu).
    toolbar: true,
    // Remember stranger ICE addresses and flag a stranger met before.
    ipHistory: true,

    // --- Media / call -------------------------------------------------------
    volumeBoost: 1, // 1 | 1.5 | 2
    // Keep the screen awake while a stranger is connected.
    wakeLock: true,
    // Ask before closing the tab in the middle of a call.
    leaveGuard: true,

    // --- Chat ---------------------------------------------------------------
    // Send a greeting as soon as a stranger is accepted. Alternatives can be
    // separated with | (one is picked at random).
    autoGreet: false,
    greetText: 'hey!|hi!|hello!',
    // Keep an in-memory copy of the chat, offered by the download button.
    chatLog: true,

    // --- Stealth ------------------------------------------------------------
    // Replace /static/vision.js with a worker that always finds a face.
    faceStub: true,
    // Present virtual cameras under a physical camera's label.
    cameraSpoof: true,

    // --- Page-world stealth -------------------------------------------------
    // Hide the toolkit's own UI while the server's `ss` screenshot is taken.
    // Only the extension's elements are hidden; the page is untouched.
    stealthScreenshot: true,
    // Answer the server's `rc` eval probes from real page values instead of
    // letting it run code inside the page. Unknown probes reply `null`.
    stealthRc: true,
    // Drop `injection` payloads (server HTML/scripts inserted into the page).
    stealthInjection: false,
    // Make the page-world wrappers look native: no own `send`, native
    // toString(), native length/name.
    stealthHooks: true,

    // --- Session tricks -----------------------------------------------------
    // Force relay-only ICE so no host/srflx candidate carries this address.
    relayOnly: false,
    // Give this tab its own visitor session: private `user` cookie, private
    // BroadcastChannel, no `newtab` shutdown.
    multiTab: false,
    // Ask the page to treat the session as a moderator (`cm`).
    moderatorMode: false,
    // Keep searching after a stranger leaves (the site's auto-skip).
    autoNext: true,
    // Escape leaves the current stranger at once.
    escapeSkip: true,
    // Show a shadowbanned stranger's video anyway (rewrites `conn.sb`).
    sbUnblank: false,
    // Send a neutral picture as the webcam moderation snapshot.
    moderationSpoof: false,

    // --- Session safety (v3.3) ----------------------------------------------
    // Suppress the server's `banned` / `ageBlock` notices before the page sees
    // them. The page keeps searching; an IP or account ban still stands.
    banBypass: false,
    // Drop outgoing `report` frames and hide the site's report button.
    antiReport: false,
    // Start every matchmaking socket without the stored `user` cookie, so the
    // server hands out a fresh visitor id per connection.
    freshVisitor: false,
    // Ignore server navigation: `redirect` URLs and the raw `vm` reload.
    blockRedirects: false,
    // Ignore `requireLogin` so the login overlay cannot block searching.
    noLoginGate: false,
    // Ignore `ncm` / `premiumExpired` so the simulated Premium is not cleared.
    keepPremium: false,
    // Ignore `clearInterests` (the server asking the page to wipe interests).
    keepInterests: false,

    // --- Misc ---------------------------------------------------------------
    hotkeys: true,
    stats: true,
  });

  const SETTINGS_KEY = 'settings';
  // The MAIN world runs at document_start, before chrome.storage answers, so
  // the bridge mirrors the page-relevant settings here synchronously.
  const BOOT_KEY = 'umingle_toolkit_boot';

  function clone(value) {
    if (Array.isArray(value)) return value.slice();
    if (value && typeof value === 'object') return Object.assign({}, value);
    return value;
  }

  /**
   * Merge a raw storage object over the defaults, keeping only known keys
   * and coercing obvious types. Unknown keys are ignored so an old build
   * cannot resurrect a retired option.
   */
  function mergeSettings(raw) {
    const out = {};
    const src = raw && typeof raw === 'object' ? raw : {};
    Object.keys(DEFAULTS).forEach((key) => {
      const def = DEFAULTS[key];
      let value = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : def;
      if (typeof def === 'boolean') value = !!value;
      else if (typeof def === 'number') {
        const n = Number(value);
        value = Number.isFinite(n) ? n : def;
      } else if (Array.isArray(def)) {
        value = Array.isArray(value) ? value.slice() : clone(def);
      } else if (typeof def === 'string') {
        value = value == null ? def : String(value);
      }
      out[key] = value;
    });
    return out;
  }

  function settingsForPage(settings) {
    return {
      enabled: !!settings.enabled,
      cityLookup: !!settings.cityLookup,
      hud: !!settings.hud,
      easySkip: !!settings.easySkip,
      faceStub: !!settings.faceStub,
      cameraSpoof: !!settings.cameraSpoof,
      stealthScreenshot: !!settings.stealthScreenshot,
      stealthRc: !!settings.stealthRc,
      stealthInjection: !!settings.stealthInjection,
      stealthHooks: !!settings.stealthHooks,
      relayOnly: !!settings.relayOnly,
      multiTab: !!settings.multiTab,
      moderatorMode: !!settings.moderatorMode,
      autoNext: !!settings.autoNext,
      sbUnblank: !!settings.sbUnblank,
      moderationSpoof: !!settings.moderationSpoof,
      banBypass: !!settings.banBypass,
      antiReport: !!settings.antiReport,
      freshVisitor: !!settings.freshVisitor,
      blockRedirects: !!settings.blockRedirects,
      noLoginGate: !!settings.noLoginGate,
      keepPremium: !!settings.keepPremium,
      keepInterests: !!settings.keepInterests,
    };
  }

  /** Mirror the page settings into localStorage for the document_start read. */
  function writeBootFlag(settings, storage) {
    try {
      const area = storage || globalThis.localStorage;
      if (!area) return false;
      area.setItem(BOOT_KEY, JSON.stringify(settingsForPage(settings)));
      return true;
    } catch (e) {
      return false; // private mode / storage disabled
    }
  }

  /** Read the mirror in the MAIN world (document_start). */
  function readBootFlag(storage) {
    try {
      const area = storage || globalThis.localStorage;
      if (!area) return null;
      const raw = area.getItem(BOOT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  const api = {
    DEFAULTS,
    SETTINGS_KEY,
    BOOT_KEY,
    mergeSettings,
    settingsForPage,
    writeBootFlag,
    readBootFlag,
  };

  // Service worker + popup + content script all reach this global.
  globalThis.UMINGLE = api;
})();
