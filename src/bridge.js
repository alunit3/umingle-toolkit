/*
 * Umingle Toolkit - isolated-world core.
 *
 * Everything that does not have to run inside the page's own JavaScript
 * world: the Premium skin, the real country filter, the city line, the
 * connection HUD, the shadowban banner, the daily statistics and the bridge
 * to the MAIN-world hooks.
 *
 * Test seams are limited to `location.hostname === 127.0.0.1` so the page
 * cannot reach into the extension from umingle.com.
 */
(function () {
  'use strict';

  const MARK = 'uming-sync';
  const ORIGIN = location.origin;
  const U = globalThis.UMINGLE;
  if (!U) return;

  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.info('[umingle-toolkit]', ...a); };

  const SKIP_SETTLE_MS = 320;
  const SKIP_PRESS_GAP_MS = 650;
  const SKIP_COOLDOWN_MS = 1500;
  const EXPIRY_KEY = 'vip_expiry';
  const IP_BOOK_KEY = 'strangerIps';
  const BAN_KEY = 'lastBan';
  const NOTE_MAX = 500;
  const SELF_VIEWS = ['mirror', 'normal', 'hidden'];
  const BOOSTS = [1, 1.5, 2];

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  let settings = U.mergeSettings({});
  let settingsLoaded = false;

  const state = {
    connected: false,
    matchAccepted: false,
    match: null,
    lastPageSeq: 0,
    lastEndSeq: 0,
    sb: false,
    sbDismissedSeq: 0,
    geoText: '',
    geoSeq: 0,
    net: null,
    socketOpen: false,
    realVip: false,
    moderator: false,
    lastSkipAt: 0,
    lastAutoStopAt: 0,
    throttleAt: 0,
    searchAt: 0,
    stats: { days: {} },
    statsLoaded: false,
    booted: false,
    pageReady: false,
    helpOpen: false,
    videoSeen: false,
    sbUnblankToast: false,
    injectionToast: false,
    lastRimageAt: 0,
    rimageSpoofed: false,
    lastRcAt: 0,
    lastNewIdentityAt: 0,
    ban: null,
    publicIp: '',
    publicIpAt: 0,
    publicIpWaiters: [],
    iceBySeq: {},
    ipBook: null,
    ipBookLoaded: false,
    ipBookSave: 0,
    noteIp: '',
    reportToast: false,
    navToast: false,
  };

  // Chat transcript (in memory only, offered by the download button).
  const chatLog = [];
  const seenChat = new WeakSet();
  const CHAT_LOG_MAX = 800;
  let chatObserver = null;
  let pageTitle = '';
  let greetSeq = 0;

  const listeners = {
    settings: [],
    match: [],
    accepted: [],
    end: [],
    net: [],
    skip: [],
    throttle: [],
    vip: [],
    help: [],
  };

  function on(name, fn) {
    if (!listeners[name] || typeof fn !== 'function') return () => {};
    listeners[name].push(fn);
    return () => {
      const i = listeners[name].indexOf(fn);
      if (i !== -1) listeners[name].splice(i, 1);
    };
  }

  function emit(name, data) {
    (listeners[name] || []).slice().forEach((fn) => {
      try { fn(data); } catch (e) { log('listener failed', name, e); }
    });
  }

  // =========================================================================
  // Settings
  // =========================================================================
  function storageArea(name) {
    try {
      return chrome && chrome.storage ? chrome.storage[name] : null;
    } catch (e) {
      return null;
    }
  }

  function loadSettings() {
    const area = storageArea('sync');
    if (!area) {
      settingsLoaded = true;
      afterSettings();
      return;
    }
    try {
      area.get(U.SETTINGS_KEY, (res) => {
        settings = U.mergeSettings(res && res[U.SETTINGS_KEY]);
        settingsLoaded = true;
        afterSettings();
      });
    } catch (e) {
      settingsLoaded = true;
      afterSettings();
    }
  }

  function afterSettings() {
    writeGate();
    applySettings();
    sendSettings();
    emit('settings', settings);
  }

  let saveQueued = false;
  function persistSettings() {
    if (saveQueued) return;
    saveQueued = true;
    setTimeout(() => {
      saveQueued = false;
      const area = storageArea('sync');
      if (!area) return;
      try {
        const payload = {};
        payload[U.SETTINGS_KEY] = settings;
        area.set(payload);
      } catch (e) { /* extension reloaded */ }
    }, 60);
  }

  function setSettings(patch, opts) {
    if (!patch || typeof patch !== 'object') return settings;
    settings = U.mergeSettings(Object.assign({}, settings, patch));
    if (!(opts && opts.quiet)) {
      persistSettings();
      applySettings();
      sendSettings();
      emit('settings', settings);
    }
    return settings;
  }

  function applySettings() {
    const root = document.documentElement;
    if (root) {
      root.classList.toggle('utk-hide-throttle', !!settings.hideThrottle);
      root.classList.toggle('utk-hide-report', !!settings.antiReport);
      root.classList.toggle('utk-disabled', !settings.enabled);
    }
    applyPremium();
    applySelfView();
    if (!settings.ipHistory) {
      hideRevisitLine();
      hideNoteLine();
    }
    updateToolbarVisibility();
    updateHudVisibility();
    watchChat();
    syncTitle();
    if (settings.rememberFilter) scheduleFilterRestore();
    if (!settings.cityLookup) hideGeoLine();
    if (!settings.hideThrottle) restoreThrottleElement(document.getElementById('premiumThrottle'));
  }

  function sendSettings() {
    // Mirror first: the MAIN world may have started before this message and
    // reads the localStorage copy at document_start.
    U.writeBootFlag(settings);
    postToPage('settings', U.settingsForPage(settings));
  }

  // =========================================================================
  // Page bus
  // =========================================================================
  function postToPage(type, data) {
    try {
      window.postMessage({ __uming: MARK, dir: 'bridge', type, data: data || null }, ORIGIN);
    } catch (e) { /* never break the page */ }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const msg = ev.data;
    if (!msg || msg.__uming !== MARK || msg.dir !== 'page') return;
    try { handlePageMessage(msg.type, msg.data || {}); } catch (e) { log('page message', msg.type, e); }
  });

  function handlePageMessage(type, data) {
    switch (type) {
      case 'hello':
        state.pageReady = true;
        sendSettings();
        break;
      case 'conn':
        state.lastPageSeq = Number(data.seq) || state.lastPageSeq;
        setTimeout(() => {
          if (data.seq && Number(data.seq) !== state.lastPageSeq) return;
          if (data.seq && Number(data.seq) === state.lastEndSeq) return;
          handleConn(data);
        }, SKIP_SETTLE_MS);
        break;
      case 'end':
        state.lastEndSeq = Number(data.seq) || state.lastEndSeq;
        handleEnd(data);
        break;
      case 'stop':
        handlePageStop(data);
        break;
      case 'search':
        state.searchAt = Number(data.at) || Date.now();
        break;
      case 'throttle':
        handleThrottle(data);
        break;
      case 'ws':
        handleSocket(data);
        break;
      case 'geo':
        handleGeo(data);
        break;
      case 'net':
        handleNet(data);
        break;
      case 'filter':
        if (Array.isArray(data.values)) state.siteCountries = data.values.slice();
        break;
      case 'ice':
        handleIce(data);
        break;
      case 'publicIp':
        handlePublicIp(data);
        break;
      case 'ban':
      case 'banned':
        noteBan(data);
        break;
      case 'navBlocked':
        if (!state.navToast) {
          state.navToast = true;
          toast('Server navigation blocked', 'muted', 2200);
        }
        break;
      case 'loginBlocked':
        toast('Login prompt suppressed', 'muted', 2200);
        break;
      case 'premiumKept':
        toast('Premium kept', 'muted', 2400);
        break;
      case 'reportBlocked':
        if (!state.reportToast) {
          state.reportToast = true;
          toast('Report blocked (anti-report is on)', 'ok', 2200);
        }
        break;
      case 'interestsKept':
        break;
      case 'blocked':
        toast('Umingle blocked this network exit (VPN/proxy)', 'warn');
        break;
      case 'othertab':
        toast('Another tab is using this visitor session', 'warn');
        break;
      case 'vip':
        handleVipEvent(data);
        break;
      case 'moderator':
        state.moderator = true;
        applyPremium();
        break;
      case 'sbunblank':
        if (!state.sbUnblankToast) {
          state.sbUnblankToast = true;
          toast('Shadowban cleared for this page', 'ok', 2600);
        }
        break;
      case 'injection':
        if (!state.injectionToast) {
          state.injectionToast = true;
          toast('Blocked injected code', 'warn', 2800);
        }
        break;
      case 'rimage':
        state.lastRimageAt = Number(data.at) || Date.now();
        state.rimageSpoofed = !!data.spoofed;
        break;
      case 'rc':
        state.lastRcAt = Number(data.at) || Date.now();
        break;
      case 'changeCountry':
        if (state.match && data.name) state.match.countryName = data.name;
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // Premium simulation
  // =========================================================================
  function premiumExpiry() {
    const now = Date.now();
    let exp = 0;
    try { exp = parseInt(localStorage.getItem(EXPIRY_KEY) || '0', 10); } catch (e) { exp = 0; }
    const hours = Math.max(1, Math.min(720, Number(settings.premiumHours) || 24));
    if (!isFinite(exp) || exp < now + 3600 * 1000) {
      exp = now + hours * 3600 * 1000;
      try { localStorage.setItem(EXPIRY_KEY, String(exp)); } catch (e) { /* private mode */ }
    }
    return exp;
  }

  /** The site's country filter gate reads only this key (and E.cm). */
  function writeGate() {
    if (!(settings.premium || settings.autoSkip || settings.rememberFilter || state.realVip)) return;
    premiumExpiry();
  }

  function expiresSoon(exp) {
    return exp - Date.now() < 3600 * 1000;
  }

  function shortLeft(exp) {
    const s = Math.max(0, Math.floor((exp - Date.now()) / 1000));
    if (s >= 86400) {
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      return h ? d + 'd ' + h + 'h' : d + 'd';
    }
    if (s >= 3600) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return m ? h + 'h ' + m + 'm' : h + 'h';
    }
    const m = Math.ceil(s / 60);
    return m >= 60 ? '1h' : m + 'm';
  }

  function exactLeft(exp) {
    let s = Math.max(0, Math.floor((exp - Date.now()) / 1000));
    let h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    if (h >= 24) {
      const d = Math.floor(h / 24);
      h %= 24;
      return d + 'd ' + h + 'h ' + pad(m) + 'm';
    }
    return pad(h) + ':' + pad(m) + ':' + pad(sec);
  }

  function setText(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
  }

  let upgradeOriginal = null;

  function applyPremium() {
    const body = document.body;
    if (!body) return;
    const show = settings.enabled && (settings.premium || state.realVip || state.moderator);

    if (!show) {
      body.classList.remove('is-vip');
      const badge = document.getElementById('vipStatusBadge');
      if (badge) badge.style.display = 'none';
      const banner = document.getElementById('vipActiveBanner');
      if (banner) banner.style.display = 'none';
      const reassure = document.getElementById('extendReassurance');
      if (reassure) reassure.style.display = 'none';
      const header = document.getElementById('checkoutHeaderText');
      if (header && header.textContent.indexOf('Extend') !== -1) header.textContent = 'Get Premium';
      const upgrade = document.querySelector('.premium-upgrade-btn');
      if (upgrade && upgradeOriginal != null) {
        upgrade.innerHTML = upgradeOriginal;
        upgradeOriginal = null;
      }
      return;
    }

    const exp = premiumExpiry();
    if (expiresSoon(exp) && !state.realVip) {
      // Keep the fake subscription rolling.
      try { localStorage.setItem(EXPIRY_KEY, String(Date.now() + (Number(settings.premiumHours) || 24) * 3600 * 1000)); } catch (e) {}
    }

    body.classList.add('is-vip');
    const badge = document.getElementById('vipStatusBadge');
    if (badge && badge.style.display !== 'flex') badge.style.display = 'flex';
    setText(document.getElementById('vipTimeLeft'), shortLeft(exp));
    setText(document.getElementById('checkoutExactTimer'), exactLeft(exp));

    const header = document.getElementById('checkoutHeaderText');
    if (header && header.textContent.indexOf('Extend') === -1) header.textContent = '\u26A1 Extend Premium';

    const banner = document.getElementById('vipActiveBanner');
    if (banner && banner.style.display !== 'block') banner.style.display = 'block';
    const reassure = document.getElementById('extendReassurance');
    if (reassure && reassure.style.display !== 'block') reassure.style.display = 'block';

    const upgrade = document.querySelector('.premium-upgrade-btn');
    if (upgrade && !/extend/i.test(upgrade.textContent)) {
      if (upgradeOriginal == null) upgradeOriginal = upgrade.innerHTML;
      upgrade.innerHTML = '<span class="premium-bolt">\u26A1</span> Extend';
    }
  }

  function handleVipEvent(data) {
    if (data && data.active) {
      state.realVip = true;
      const seconds = Math.max(0, Number(data.seconds) || 0);
      if (seconds) {
        try { localStorage.setItem(EXPIRY_KEY, String(Date.now() + seconds * 1000)); } catch (e) {}
      }
      applyPremium();
      toast('Premium activated by the server', 'ok');
    } else {
      state.realVip = false;
      applyPremium();
    }
    emit('vip', data);
  }

  // =========================================================================
  // Server skip throttle
  // =========================================================================
  let throttleObserver = null;
  const throttlePrev = new WeakMap();

  function hideThrottleElement(el) {
    if (!el) return;
    const value = el.style.getPropertyValue('display');
    const priority = el.style.getPropertyPriority('display');
    const ours = value === 'none' && priority === 'important';
    if (!ours) {
      // Remember what the page wanted before our rule replaced it.
      throttlePrev.set(el, { value, priority });
    }
    if (!ours) el.style.setProperty('display', 'none', 'important');
  }

  /** Put back exactly the display the page had before we touched it. */
  function restoreThrottleElement(el) {
    if (!el) return;
    const prev = throttlePrev.get(el);
    if (!prev) return;
    throttlePrev.delete(el);
    if (el.style.getPropertyValue('display') !== 'none' ||
        el.style.getPropertyPriority('display') !== 'important') {
      return; // already changed since; leave the page's value alone
    }
    if (prev.value) el.style.setProperty('display', prev.value, prev.priority);
    else el.style.removeProperty('display');
  }

  function watchThrottle() {
    const el = document.getElementById('premiumThrottle');
    if (!el || throttleObserver) return;
    if (settings.hideThrottle) hideThrottleElement(el);
    try {
      throttleObserver = new MutationObserver(() => {
        if (settings.enabled && settings.hideThrottle) hideThrottleElement(el);
      });
      throttleObserver.observe(el, { attributes: true, attributeFilter: ['style'] });
    } catch (e) { /* old browser */ }
  }

  /** The page's signaling socket opened/closed (MAIN world notification). */
  function handleSocket(data) {
    state.socketOpen = !!(data && data.open);
  }

  function handleThrottle(data) {
    if (!state.throttleAt) state.throttleAt = Date.now();
    bumpStat('throttles', 1);
    if (settings.enabled && settings.hideThrottle) {
      hideThrottleElement(document.getElementById('premiumThrottle'));
    }
    emit('throttle', data);
  }

  function closeThrottleWait() {
    if (!state.throttleAt) return;
    const ms = Math.max(0, Date.now() - state.throttleAt);
    state.throttleAt = 0;
    bumpStat('waitMs', ms);
  }

  // =========================================================================
  // Stats (chrome.storage.local, one object, local calendar days)
  // =========================================================================
  function dayKey(d) {
    const t = d || new Date();
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }

  function blankDay() {
    return {
      matches: 0,
      skips: 0,
      sb: 0,
      throttles: 0,
      waitMs: 0,
      talkMs: 0,
      countries: {},
      reasons: {},
      firstAt: 0,
      lastAt: 0,
    };
  }

  function todayStats(create) {
    if (!state.stats || typeof state.stats !== 'object') state.stats = { days: {} };
    if (!state.stats.days || typeof state.stats.days !== 'object') state.stats.days = {};
    const key = dayKey();
    if (!state.stats.days[key]) {
      if (!create) return blankDay();
      state.stats.days[key] = blankDay();
    }
    return state.stats.days[key];
  }

  function loadStats() {
    const area = storageArea('local');
    if (!area) { state.statsLoaded = true; return; }
    try {
      area.get('stats', (res) => {
        const raw = res && res.stats;
        if (raw && raw.days && typeof raw.days === 'object') state.stats = raw;
        pruneStats();
        state.statsLoaded = true;
        emit('stats', state.stats);
      });
    } catch (e) { state.statsLoaded = true; }
  }

  function pruneStats() {
    const keys = Object.keys(state.stats.days || {});
    if (keys.length <= 45) return;
    const cutoff = Date.now() - 45 * 86400 * 1000;
    keys.forEach((key) => {
      const t = Date.parse(key + 'T00:00:00');
      if (!isFinite(t) || t < cutoff) delete state.stats.days[key];
    });
  }

  let statsTimer = 0;
  function saveStats() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = 0;
      writeStats();
    }, 1200);
  }

  function writeStats() {
    const area = storageArea('local');
    if (!area) return;
    try { area.set({ stats: state.stats }); } catch (e) { /* ignore */ }
  }

  /** Write pending stats now (a call ended: do not lose it with the tab). */
  function flushStats() {
    if (statsTimer) {
      clearTimeout(statsTimer);
      statsTimer = 0;
    }
    writeStats();
  }

  function bumpStat(key, amount) {
    if (!settings.stats) return;
    const day = todayStats(true);
    const n = Number(amount) || 0;
    day[key] = (Number(day[key]) || 0) + n;
    day.lastAt = Date.now();
    if (!day.firstAt) day.firstAt = day.lastAt;
    saveStats();
  }

  function bumpCountry(code, name) {
    if (!settings.stats) return;
    const day = todayStats(true);
    const key = String(code || '??').toUpperCase();
    const entry = day.countries[key] || { n: 0, name: name || '' };
    entry.n += 1;
    if (name) entry.name = name;
    day.countries[key] = entry;
  }

  function bumpReason(reason) {
    if (!settings.stats) return;
    const day = todayStats(true);
    const key = String(reason || 'user');
    day.reasons[key] = (Number(day.reasons[key]) || 0) + 1;
  }

  // =========================================================================
  // Match lifecycle
  // =========================================================================
  function currentCountry() {
    return state.match ? state.match.country : '';
  }

  function finalizeMatch(reason) {
    const match = state.match;
    if (!match) return;
    if (match.accepted) bumpStat('talkMs', Math.max(0, Date.now() - match.at));
    state.match = null;
    state.connected = false;
    state.matchAccepted = false;
    state.net = null;
    hideGeoLine();
    hideRevisitLine();
    hideNoteLine();
    hideShadowban();
    ensureHud();
    updateHudVisibility();
    updateToolbarVisibility();
    if (state.throttleAt) closeThrottleWait();
    flushStats();
    syncTitle();
    emit('end', { match, reason });
  }

  function handleConn(data) {
    if (!settings.enabled) return;
    if (state.match) finalizeMatch('replaced');
    closeThrottleWait();

    const seq = Number(data.seq) || 0;
    const country = String(data.country || '').toUpperCase();
    const countryName = String(data.countryName || '');
    const match = {
      seq,
      at: Date.now(),
      country,
      countryName,
      sb: !!data.sb,
      id: String(data.connectionID || ''),
      interests: Array.isArray(data.interests) ? data.interests : [],
      accepted: false,
      skipping: false,
      pendingSkip: null,
    };

    state.match = match;
    state.connected = true;
    state.sb = match.sb;
    state.geoText = '';
    state.geoSeq = seq;
    state.videoSeen = false;
    hideNoteLine();

    bumpStat('matches', 1);
    bumpCountry(country, countryName);
    if (match.sb) bumpStat('sb', 1);

    emit('match', match);

    if (match.sb && settings.shadowbanAlert) showShadowban(match);

    if (isBlockedCountry(country)) {
      requestSkip('blocked', { toast: 'Skipped ' + (countryName || country) + ' (blocked country)' });
      return;
    }
    if (!country && settings.skipUnknownCountry) {
      requestSkip('unknown', { toast: 'Skipped a stranger with no country' });
      return;
    }
    if (settings.autoSkip && shouldSkipCountry(country)) {
      requestSkip('country', { toast: 'Skipped ' + (countryName || country || 'stranger') + ' (filter)' });
      return;
    }
    if (match.sb && settings.skipShadowbanned) {
      requestSkip('shadowban', { toast: 'Skipped a shadowbanned stranger' });
      return;
    }

    match.accepted = true;
    state.matchAccepted = true;
    postToPage('accept', { seq });
    if (state.ban) clearBan();

    const ice = state.iceBySeq[seq];
    if (ice && ice.ip) {
      match.ipSeen = true;
      match.ip = ice.ip;
      rememberStranger(match, ice.ip);
    }

    updateHudVisibility();
    updateToolbarVisibility();
    watchChat();
    syncTitle();
    emit('accepted', match);
    scheduleAutoGreet(match);

    const video = document.getElementById('otherVideo');
    if (video && globalThis.UTK && globalThis.UTK.applyBoost) {
      try { globalThis.UTK.applyBoost(video); } catch (e) { /* toolkit not ready */ }
    }
  }

  function handleEnd(data) {
    if (state.match) {
      finalizeMatch('left');
    } else {
      state.connected = false;
      state.matchAccepted = false;
      hideGeoLine();
      hideNoteLine();
      hideShadowban();
    }
    closeThrottleWait();
    ensureHud();
    updateHudVisibility();
    updateToolbarVisibility();
  }

  function handlePageStop() {
    if (Date.now() - state.lastAutoStopAt < 2500) return;
    if (!state.match || !state.match.accepted) return;
    bumpStat('skips', 1);
    bumpReason('user');
    emit('skip', { match: state.match, reason: 'user' });
    finalizeMatch('user');
  }

  // =========================================================================
  // Country filter (client-side: the server ignores searchCountries)
  // =========================================================================
  function selectedCountries() {
    const out = [];
    $$('.cf-option.selected[data-country]').forEach((el) => {
      const code = String(el.getAttribute('data-country') || '').toUpperCase();
      if (code && code !== 'ANY' && out.indexOf(code) === -1) out.push(code);
    });
    return out.sort();
  }

  /** The countries the filter is currently enforcing.
   *
   * The page's own selection is authoritative, but a `conn` can arrive
   * before the country list was restored (or before it exists at all), so the
   * saved list stands in while the DOM shows nothing.
   */
  function activeFilter() {
    const dom = selectedCountries();
    if (dom.length) return dom;
    if (!settings.rememberFilter) return [];
    return (settings.filterCountries || [])
      .map((c) => String(c || '').toUpperCase())
      .filter((c) => c && c !== 'ANY');
  }

  function shouldSkipCountry(code) {
    const wanted = activeFilter();
    if (!wanted.length) return false;
    const c = String(code || '').toUpperCase();
    if (!c) return false; // unknown country is let through, like --only-country
    return wanted.indexOf(c) === -1;
  }

  function normalizeCode(value) {
    const c = String(value || '').trim().toUpperCase();
    return /^[A-Z]{2}$/.test(c) && c !== 'ANY' ? c : '';
  }

  function blockedCountries() {
    return (settings.blockCountries || []).map(normalizeCode).filter(Boolean);
  }

  function isBlockedCountry(code) {
    const c = normalizeCode(code);
    return !!c && blockedCountries().indexOf(c) !== -1;
  }

  function skipButton() {
    return document.querySelector('.skipButton');
  }

  function buttonLabel(btn) {
    const label = btn && btn.querySelector('.mainText');
    return label ? label.textContent.trim().toLowerCase() : '';
  }

  function pressSkip(btn) {
    try {
      btn.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
      }));
    } catch (e) { /* ignore */ }
  }

  function pressSkipSequence(btn) {
    // Easy skip: the page world performs both presses at once. The event is
    // cancelable and preventDefault() means it handled the skip.
    if (settings.easySkip) {
      try {
        const ev = new CustomEvent('utk-easy-skip', { bubbles: false, cancelable: true });
        document.dispatchEvent(ev);
        if (ev.defaultPrevented) return true;
      } catch (e) { /* fall through to the two-step sequence */ }
    }
    const text = buttonLabel(btn);
    if (text === 'really?' || text === 'really') {
      pressSkip(btn);
      return true;
    }
    if (text !== 'skip') return false;
    pressSkip(btn); // Skip -> Really?
    setTimeout(() => {
      if (!btn.isConnected) return;
      const next = buttonLabel(btn);
      if (next === 'really?' || next === 'really') pressSkip(btn);
    }, SKIP_PRESS_GAP_MS);
    return true;
  }

  /**
   * Leave the current stranger.
   *   reason: country | shadowban | stall | user | refresh
   * Returns false when there is nothing to skip (or the page button is not
   * ready yet, in which case the caller may retry).
   */
  function requestSkip(reason, opts) {
    const match = state.match;
    if (!match) return false;
    if ((match.skipTries = (match.skipTries || 0) + 1) > 20) {
      match.pendingSkip = null;
      return false;
    }

    if (Date.now() - state.lastSkipAt < SKIP_COOLDOWN_MS) {
      // A quick second wrong-country match: finish the cooldown, then skip.
      match.pendingSkip = { reason, opts };
      setTimeout(() => {
        if (state.match !== match) return;
        const pending = match.pendingSkip;
        match.pendingSkip = null;
        requestSkip(pending ? pending.reason : reason, pending ? pending.opts : opts);
      }, SKIP_COOLDOWN_MS + 60);
      return true;
    }

    const btn = skipButton();
    if (!btn) {
      match.pendingSkip = { reason, opts };
      setTimeout(() => {
        if (state.match !== match) return;
        const pending = match.pendingSkip;
        match.pendingSkip = null;
        requestSkip(pending ? pending.reason : reason, pending ? pending.opts : opts);
      }, 300);
      return true;
    }

    const text = buttonLabel(btn);
    if (text !== 'skip' && text !== 'really?' && text !== 'really') {
      // The site may still be switching the button over after `conn`.
      match.pendingSkip = { reason, opts };
      setTimeout(() => {
        if (state.match !== match) return;
        const pending = match.pendingSkip;
        match.pendingSkip = null;
        requestSkip(pending ? pending.reason : reason, pending ? pending.opts : opts);
      }, 350);
      return true;
    }

    if (match.skipping) return true;
    match.skipping = true;
    state.lastSkipAt = Date.now();
    state.lastAutoStopAt = Date.now();

    bumpStat('skips', 1);
    bumpReason(reason);
    emit('skip', { match, reason });

    const label = opts && opts.toast;
    finalizeMatch(reason);
    if (label) toast(label, 'muted', 1500);

    pressSkipSequence(btn);
    return true;
  }

  function scheduleFilterRestore() {
    if (!settingsLoaded || !settings.enabled) return;
    if (!settings.rememberFilter || !settings.filterCountries.length) return;
    if (filterRestored || filterRestoring) return;
    filterRestoring = true;

    let tries = 0;
    const attempt = () => {
      if (!settingsLoaded || !settings.rememberFilter) { filterRestoring = false; return; }
      const options = $$('.cf-option[data-country]');
      if (!options.length) {
        if (++tries > 20) { filterRestoring = false; return; }
        setTimeout(attempt, 500);
        return;
      }
      try {
        restoreFilterNow();
      } finally {
        filterRestoring = false;
      }
    };
    setTimeout(attempt, 400);
  }

  function restoreFilterNow() {
    const wanted = (settings.filterCountries || [])
      .map((c) => String(c || '').toUpperCase())
      .filter((c) => c && c !== 'ANY');
    if (!wanted.length) return;

    // The site's own click gate reads vip_expiry; write it before clicking.
    premiumExpiry();

    const multi = document.getElementById('cf-multi-toggle');
    if (multi) multi.checked = wanted.length > 1;

    const current = selectedCountries();
    const same = current.length === wanted.length && current.every((c, i) => c === wanted[i]);
    if (!same) {
      const click = (code) => {
        const el = document.querySelector('.cf-option[data-country="' + code + '"]');
        if (!el) return;
        try {
          el.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
          }));
        } catch (e) { /* ignore */ }
      };

      if (wanted.length === 1) {
        if (multi) multi.checked = false;
        click(wanted[0]);
      } else {
        current.forEach((code) => { if (wanted.indexOf(code) === -1) click(code); });
        wanted.forEach((code) => { if (current.indexOf(code) === -1) click(code); });
      }
    }

    filterRestored = true;
    setTimeout(saveFilterSelection, 150);
    log('filter restored', wanted, 'was', current);
  }

  function saveFilterSelection() {
    if (!settings.rememberFilter || !settingsLoaded) return;
    const selected = selectedCountries();
    const before = (settings.filterCountries || []).map((c) => String(c).toUpperCase()).sort();
    if (selected.length === before.length && selected.every((c, i) => c === before[i])) return;
    settings = U.mergeSettings(Object.assign({}, settings, { filterCountries: selected }));
    persistSettings();
    emit('settings', settings);
    sendSettings();
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target && ev.target.closest
      ? ev.target.closest('.cf-option[data-country], #cf-reset-btn')
      : null;
    if (!el) return;
    // Let the page's own handler run first.
    setTimeout(saveFilterSelection, 120);
  }, true);

  // =========================================================================
  // City / ISP line (the IP itself is collected in the MAIN world)
  // =========================================================================
  function ensureGeoLine() {
    let el = document.querySelector('.cityGuessLine');
    if (el && el.isConnected) return el;
    const anchor = document.querySelector('.countryInfo') || document.getElementById('info');
    if (!anchor || !anchor.parentNode) return null;
    el = document.createElement('div');
    el.className = 'cityGuessLine';
    el.style.display = 'none';
    el.setAttribute('aria-live', 'polite');
    el.title = 'Approximate, based on their public IP';
    el.innerHTML =
      '<svg class="utk-geo-pin" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.2" aria-hidden="true"><path d="M6 1.3a3.2 3.2 0 0 0-3.2 3.2c0 2.4 3.2 6 3.2 6' +
      's3.2-3.6 3.2-6A3.2 3.2 0 0 0 6 1.3Z"/><circle cx="6" cy="4.5" r="1.05"/></svg>' +
      '<span class="utk-geo-text"></span>';
    anchor.insertAdjacentElement('afterend', el);
    return el;
  }

  function setGeoLine(text) {
    const el = ensureGeoLine();
    if (!el) return;
    const node = el.querySelector('.utk-geo-text');
    if (node) node.textContent = text;
    else el.textContent = text;
    el.style.display = 'flex';
  }

  function hideGeoLine() {
    const el = document.querySelector('.cityGuessLine');
    if (el) el.style.display = 'none';
  }

  function syncGeoVisibility() {
    const el = ensureGeoLine();
    if (!el) return;
    const info = document.querySelector('.countryInfo');
    const infoHidden = info && getComputedStyle(info).display === 'none';
    const match = state.match;
    if (!settings.enabled || !settings.cityLookup || !match || !match.accepted ||
        !state.geoText || infoHidden) {
      if (el.style.display !== 'none') el.style.display = 'none';
      return;
    }
    const text = state.geoText;
    const node = el.querySelector('.utk-geo-text');
    if (node && node.textContent !== text) node.textContent = text;
    if (el.style.display === 'none') el.style.display = 'flex';
  }

  function handleGeo(data) {
    const seq = Number(data.seq) || 0;
    if (state.match && seq && state.match.seq !== seq) return;
    if (!state.match || !state.match.accepted) return;

    if (data.pending) {
      state.geoText = 'Guessing location\u2026';
      setGeoLine('Guessing location\u2026');
      return;
    }
    const text = String(data.text || '').trim();
    state.geoText = text;
    if (!text) {
      hideGeoLine();
      return;
    }
    setGeoLine(text);
  }

  // =========================================================================
  // Shadowban banner
  // =========================================================================
  function ensureShadowban() {
    let el = document.querySelector('.utk-sb-banner');
    if (el && el.isConnected) return el;
    const host = document.querySelector('.chatWindow') || document.querySelector('.mainBox') ||
      document.getElementById('premiumThrottle') || document.body;
    if (!host) return null;
    el = document.createElement('div');
    el.className = 'utk-sb-banner';
    el.style.display = 'none';
    el.innerHTML =
      '<div class="utk-sb-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M8 2.2 14.4 13.2H1.6z"/><path d="M8 6.2v3.2"/><path d="M8 11.6v.1"/></svg></div>' +
      '<div class="utk-sb-copy"><strong>Shadowbanned match</strong>' +
      '<span>They cannot see or hear you. This call is a dead end.</span></div>' +
      '<div class="utk-sb-actions">' +
      '<button type="button" class="utk-sb-skip">Skip</button>' +
      '<button type="button" class="utk-sb-close" aria-label="Dismiss">' +
      '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
      '<path d="M2.2 2.2 9.8 9.8M9.8 2.2 2.2 9.8"/></svg></button>' +
      '</div>';
    el.querySelector('.utk-sb-skip').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      requestSkip('shadowban', { toast: 'Skipped a shadowbanned stranger' });
    });
    el.querySelector('.utk-sb-close').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (state.match) state.sbDismissedSeq = state.match.seq;
      el.style.display = 'none';
    });
    const anchor = document.getElementById('premiumThrottle');
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', el);
    else host.insertBefore(el, host.firstChild);
    return el;
  }

  function showShadowban(match) {
    if (!match || match.seq === state.sbDismissedSeq) return;
    const el = ensureShadowban();
    if (!el) {
      setTimeout(() => {
        if (state.match === match) showShadowban(match);
      }, 300);
      return;
    }
    el.style.display = 'flex';
  }

  function hideShadowban() {
    const el = document.querySelector('.utk-sb-banner');
    if (el) el.style.display = 'none';
  }

  // =========================================================================
  // Own preview (mirror / normal / hidden)
  // =========================================================================
  function selfViewMode() {
    return SELF_VIEWS.indexOf(settings.selfView) === -1 ? 'mirror' : settings.selfView;
  }

  function applySelfView() {
    const root = document.documentElement;
    if (!root) return;
    const mode = settings.enabled ? selfViewMode() : 'mirror';
    root.classList.toggle('utk-self-normal', mode === 'normal');
    root.classList.toggle('utk-self-hidden', mode === 'hidden');
  }

  function setSelfView(mode) {
    if (SELF_VIEWS.indexOf(mode) === -1) return;
    setSettings({ selfView: mode });
  }

  function cycleSelfView() {
    const i = SELF_VIEWS.indexOf(selfViewMode());
    const next = SELF_VIEWS[(i + 1) % SELF_VIEWS.length];
    setSelfView(next);
    return next;
  }

  // =========================================================================
  // Stranger IP memory
  //
  // The page world reports the first public (srflx/prflx) address in every
  // match's ICE candidates. That address is a proxy exit more often than a
  // home IP, so it identifies a stranger only loosely; it is still the same
  // signal the site itself sees, and a repeat is worth a heads-up.
  // =========================================================================
  function readIpBook(raw) {
    const out = { v: 1, ips: {} };
    const src = raw && typeof raw === 'object' && raw.ips && typeof raw.ips === 'object'
      ? raw.ips : {};
    Object.keys(src).forEach((ip) => {
      const e = src[ip];
      if (!e || typeof e !== 'object') return;
      const last = Number(e.last) || 0;
      if (!last) return;
      out.ips[ip] = {
        n: Math.max(1, Number(e.n) || 1),
        first: Number(e.first) || last,
        last,
        cc: String(e.cc || '').toUpperCase().slice(0, 2),
        note: String(e.note || '').slice(0, NOTE_MAX),
      };
    });
    return out;
  }

  let ipBookQueue = [];

  function drainIpBookQueue() {
    const queue = ipBookQueue;
    ipBookQueue = [];
    queue.forEach((fn) => { try { fn(state.ipBook); } catch (e) {} });
  }

  function loadIpBook(fn) {
    if (state.ipBook) {
      if (fn) fn(state.ipBook);
      return;
    }
    if (fn) ipBookQueue.push(fn);
    if (state.ipBookLoaded) return;
    state.ipBookLoaded = true;
    const area = storageArea('local');
    if (!area) {
      state.ipBook = readIpBook(null);
      drainIpBookQueue();
      return;
    }
    try {
      area.get(IP_BOOK_KEY, (res) => {
        state.ipBook = readIpBook(res && res[IP_BOOK_KEY]);
        drainIpBookQueue();
      });
    } catch (e) {
      state.ipBook = readIpBook(null);
      drainIpBookQueue();
    }
  }

  /** Read-modify-write so a second tab's records are not overwritten. */
  function writeIpBook(mutate) {
    const write = (cur) => {
      const book = readIpBook(cur);
      mutate(book);
      state.ipBook = book;
      const area = storageArea('local');
      if (!area) return;
      const payload = {};
      payload[IP_BOOK_KEY] = book;
      try { area.set(payload); } catch (e) { /* extension reloaded */ }
    };
    const area = storageArea('local');
    if (!area) { write(state.ipBook); return; }
    try {
      area.get(IP_BOOK_KEY, (res) => write(res && res[IP_BOOK_KEY]));
    } catch (e) {
      write(state.ipBook);
    }
  }

  function saveIpBook(ip, entry) {
    writeIpBook((book) => {
      const mine = book.ips[ip];
      const next = mine && (mine.last || 0) > (entry.last || 0) ? mine : entry;
      if (entry.note === undefined && mine && mine.note) next.note = mine.note;
      book.ips[ip] = next;
    });
  }

  function setStrangerNote(ip, note) {
    if (!ip) return;
    const text = String(note || '').slice(0, NOTE_MAX).trim();
    writeIpBook((book) => {
      const now = Date.now();
      const match = state.match;
      const entry = book.ips[ip] || {
        n: 1,
        first: now,
        last: now,
        cc: (match && match.country) || '',
        note: '',
      };
      entry.note = text;
      book.ips[ip] = entry;
    });
    showNoteLine(text);
    toast(text ? 'Note saved' : 'Note deleted', 'ok', 1800);
  }

  function ordinal(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return n + 'th';
    if (n % 10 === 1) return n + 'st';
    if (n % 10 === 2) return n + 'nd';
    if (n % 10 === 3) return n + 'rd';
    return n + 'th';
  }

  function ensureRevisitLine() {
    let el = document.querySelector('.utk-revisit');
    if (el && el.isConnected) return el;
    const anchor = document.querySelector('.cityGuessLine') ||
      document.querySelector('.countryInfo') || document.getElementById('info');
    if (!anchor || !anchor.parentNode) return null;
    el = document.createElement('div');
    el.className = 'utk-revisit';
    el.setAttribute('aria-live', 'polite');
    el.title = 'You met this stranger before';
    anchor.insertAdjacentElement('afterend', el);
    return el;
  }

  function setRevisitLine(prev, entry) {
    const el = ensureRevisitLine();
    if (!el) return;
    let text = '\u21A9 Seen before \u00B7 ' + ordinal(entry.n) + ' time';
    const first = Number(prev && prev.first) || 0;
    if (first) {
      try { text += ' \u00B7 first ' + new Date(first).toLocaleDateString(); } catch (e) {}
    }
    el.textContent = text;
    el.style.display = 'flex';
  }

  function hideRevisitLine() {
    const el = document.querySelector('.utk-revisit');
    if (el) el.style.display = 'none';
  }

  function ensureNoteLine() {
    let el = document.querySelector('.utk-stranger-note');
    if (el && el.isConnected) return el;
    const anchor = document.querySelector('.utk-revisit') ||
      document.querySelector('.cityGuessLine') ||
      document.querySelector('.countryInfo') || document.getElementById('info');
    if (!anchor || !anchor.parentNode) return null;
    el = document.createElement('div');
    el.className = 'utk-stranger-note';
    el.title = 'Your note about this stranger \u2014 click to edit';
    el.innerHTML =
      '<svg class="utk-note-ico" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.2" aria-hidden="true"><path d="M8.4 1.6 10.4 3.6 3.9 10.1 1.6 10.4 1.9 8.1Z" ' +
      'stroke-linejoin="round"/></svg><span class="utk-note-body"></span>';
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openNoteEditor();
    });
    anchor.insertAdjacentElement('afterend', el);
    return el;
  }

  function showNoteLine(text) {
    if (!settings.ipHistory || !text) { hideNoteLine(); return; }
    const el = ensureNoteLine();
    if (!el) return;
    const node = el.querySelector('.utk-note-body');
    if (node) node.textContent = text;
    el.style.display = 'flex';
  }

  function hideNoteLine() {
    const el = document.querySelector('.utk-stranger-note');
    if (el) el.style.display = 'none';
  }

  function currentStrangerIp() {
    const match = state.match;
    if (!match || !match.accepted) return '';
    if (match.ip) return match.ip;
    const ice = state.iceBySeq[match.seq];
    return ice && ice.ip ? ice.ip : '';
  }

  function noteEditor() {
    let el = document.querySelector('.utk-note');
    if (el && el.isConnected) return el;
    el = document.createElement('div');
    el.className = 'utk-help utk-note';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Note about this stranger');
    el.innerHTML =
      '<form class="utk-help-card utk-note-card" novalidate>' +
        '<div class="utk-note-head"><strong>Note about this stranger</strong>' +
        '<span>Saved on this device. Shows again when you meet this stranger.</span></div>' +
        '<textarea class="utk-note-input" maxlength="' + NOTE_MAX + '" rows="4" ' +
          'placeholder="Anything worth remembering"></textarea>' +
        '<div class="utk-note-actions">' +
          '<button type="button" class="utk-note-btn danger" data-note="delete">Delete</button>' +
          '<span class="utk-note-spacer"></span>' +
          '<button type="button" class="utk-note-btn" data-note="cancel">Cancel</button>' +
          '<button type="submit" class="utk-note-btn primary">Save</button>' +
        '</div>' +
      '</form>';
    el.addEventListener('click', (ev) => {
      if (ev.target === el) { closeNoteEditor(); return; }
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-note]') : null;
      if (!btn) return;
      if (btn.getAttribute('data-note') === 'cancel') closeNoteEditor();
      if (btn.getAttribute('data-note') === 'delete') {
        const ip = state.noteIp;
        closeNoteEditor();
        setStrangerNote(ip, '');
      }
    });
    el.querySelector('form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const ip = state.noteIp;
      const text = el.querySelector('textarea').value;
      closeNoteEditor();
      setStrangerNote(ip, text);
    });
    el.querySelector('textarea').addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeNoteEditor();
      } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        const ip = state.noteIp;
        const text = ev.target.value;
        closeNoteEditor();
        setStrangerNote(ip, text);
      }
    });
    document.body.appendChild(el);
    return el;
  }

  function closeNoteEditor() {
    const el = document.querySelector('.utk-note');
    if (el) el.style.display = 'none';
  }

  function openNoteEditor() {
    if (!settings.ipHistory) {
      toast('Turn on stranger memory in the popup to keep notes', 'warn', 3200);
      return;
    }
    const ip = currentStrangerIp();
    if (!ip) {
      toast('Waiting for the stranger\u2019s address', 'muted', 2400);
      return;
    }
    const el = noteEditor();
    state.noteIp = ip;
    const area = el.querySelector('textarea');
    area.value = '';
    loadIpBook((book) => {
      if (state.noteIp !== ip) return;
      const entry = book.ips[ip];
      const note = (entry && entry.note) || '';
      area.value = note;
      const del = el.querySelector('[data-note="delete"]');
      if (del) del.hidden = !note;
    });
    el.style.display = 'flex';
    setTimeout(() => {
      try {
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      } catch (e) { /* not focusable */ }
    }, 30);
  }

  function rememberStranger(match, ip) {
    if (!settings.ipHistory) return;
    loadIpBook((book) => {
      if (!state.match || state.match.seq !== match.seq) return;
      const prev = book.ips[ip] || null;
      const now = Date.now();
      const entry = {
        n: prev ? Math.max(1, Number(prev.n) || 1) + 1 : 1,
        first: prev ? (Number(prev.first) || now) : now,
        last: now,
        cc: match.country || '',
      };
      if (prev) {
        setRevisitLine(prev, entry);
        toast('Met this stranger before \u2014 ' + ordinal(entry.n) + ' time', 'warn', 3600);
      }
      showNoteLine(prev && prev.note);
      saveIpBook(ip, entry);
    });
  }

  function pruneIce() {
    const keys = Object.keys(state.iceBySeq);
    if (keys.length <= 12) return;
    keys.sort((a, b) => a - b);
    keys.slice(0, keys.length - 12).forEach((k) => { delete state.iceBySeq[k]; });
  }

  function handleIce(data) {
    const ip = String(data.ip || '').trim();
    const seq = Number(data.seq) || 0;
    if (!ip || !seq) return;
    const at = Number(data.at) || Date.now();
    if (!state.iceBySeq[seq]) state.iceBySeq[seq] = { ip, at };
    pruneIce();

    const match = state.match;
    if (!match || match.seq !== seq || !match.accepted || match.ipSeen) return;
    match.ipSeen = true;
    match.ip = ip;
    rememberStranger(match, ip);
  }

  // =========================================================================
  // Own public IP (only fetched for the ban gate and about once per 5 min)
  // =========================================================================
  const PUBLIC_IP_TTL_MS = 5 * 60 * 1000;
  const PUBLIC_IP_WAIT_MS = 5000;

  function currentPublicIp() {
    return state.publicIp && Date.now() - state.publicIpAt < PUBLIC_IP_TTL_MS
      ? state.publicIp : '';
  }

  function flushPublicIpWaiters() {
    const waiters = state.publicIpWaiters;
    state.publicIpWaiters = [];
    waiters.forEach((fn) => { try { fn(currentPublicIp()); } catch (e) {} });
  }

  function requestPublicIp(force) {
    if (!force) {
      const hit = currentPublicIp();
      if (hit) return Promise.resolve(hit);
    }
    return new Promise((resolve) => {
      state.publicIpWaiters.push(resolve);
      if (state.publicIpWaiters.length > 1) return;
      postToPage('publicIp', { at: Date.now(), force: !!force });
      setTimeout(flushPublicIpWaiters, PUBLIC_IP_WAIT_MS);
    });
  }

  function handlePublicIp(data) {
    const ip = String(data.ip || '').trim();
    state.publicIp = ip;
    state.publicIpAt = ip ? (Number(data.at) || Date.now()) : 0;
    flushPublicIpWaiters();
  }

  // =========================================================================
  // Ban gate
  //
  // The server ban sticks to the exit IP. Changing the visitor cookie while
  // the IP stays the same only burns a fresh id, so New identity waits until
  // the address has actually changed. Unknown addresses are allowed through.
  // =========================================================================
  const BAN_TTL_MS = 12 * 3600 * 1000;

  function readBan(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const at = Number(raw.at) || 0;
    if (!at || Date.now() - at > BAN_TTL_MS) return null;
    return {
      at,
      kind: String(raw.kind || 'banned'),
      reason: String(raw.reason || ''),
      ip: String(raw.ip || ''),
    };
  }

  function loadBan() {
    const area = storageArea('local');
    if (!area) return;
    try {
      area.get(BAN_KEY, (res) => { state.ban = readBan(res && res[BAN_KEY]); });
    } catch (e) { /* extension reloaded */ }
  }

  function saveBan(ban) {
    const area = storageArea('local');
    if (!area) return;
    const payload = {};
    payload[BAN_KEY] = ban;
    try { area.set(payload); } catch (e) { /* extension reloaded */ }
  }

  function clearBan() {
    state.ban = null;
    const area = storageArea('local');
    if (!area) return;
    try { area.remove(BAN_KEY); } catch (e) { /* extension reloaded */ }
  }

  let lastBanNote = { at: 0, kind: '', reason: '' };

  function noteBan(data) {
    if (!settings.enabled) return;
    const now = Date.now();
    const kind = String(data.kind || 'banned');
    const reason = String(data.reason || '');
    if (lastBanNote.at && lastBanNote.kind === kind && lastBanNote.reason === reason &&
        now - lastBanNote.at < 3000) {
      return;
    }
    lastBanNote = { at: now, kind, reason };

    const ban = { at: now, kind, reason, ip: currentPublicIp() };
    state.ban = ban;
    saveBan(ban);

    requestPublicIp().then((ip) => {
      if (state.ban && state.ban.at === ban.at && ip) {
        state.ban.ip = ip;
        saveBan(state.ban);
      }
    });

    if (data.suppressed) {
      toast('Ban notice hidden \u2014 change your IP, then use New identity', 'warn', 5000);
    } else {
      toast('Banned' + (ban.reason ? ': ' + ban.reason : '') +
        ' \u2014 change your IP, then use New identity', 'warn', 5200);
    }
  }

  // =========================================================================
  // Connection HUD
  // =========================================================================
  function ensureHud() {
    let el = document.querySelector('.utk-hud');
    if (el && el.isConnected) return el;
    const host = document.querySelector('.videoWrapper.remote');
    if (!host) return null;
    el = document.createElement('div');
    el.className = 'utk-hud';
    el.style.display = 'none';
    el.innerHTML =
      '<span class="utk-hud-mode">P2P</span>' +
      '<span class="utk-hud-res">\u2014</span>' +
      '<span class="utk-hud-fps">\u2014</span>' +
      '<span class="utk-hud-rate">\u2014</span>' +
      '<span class="utk-hud-out"></span>' +
      '<span class="utk-hud-rtt"></span>' +
      '<span class="utk-hud-time"></span>';
    host.appendChild(el);
    return el;
  }

  function clockText(ms) {
    const total = Math.max(0, Math.floor(Number(ms) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return (m < 10 ? '0' + m : String(m)) + ':' + (s < 10 ? '0' + s : String(s));
  }

  function updateHudVisibility() {
    const el = ensureHud();
    if (!el) return;
    const show = settings.enabled && settings.hud && state.matchAccepted && !!state.net &&
      state.net.state !== 'idle' && !!(state.net.width || state.net.kbps || state.net.bytes);
    el.style.display = show ? 'flex' : 'none';
    const tools = document.querySelector('.utk-tools');
    if (tools) tools.style.display = settings.enabled && settings.toolbar ? 'flex' : 'none';
  }

  function handleNet(data) {
    state.net = data && typeof data === 'object' ? data : null;
    if (state.net && (state.net.fps > 0 || state.net.kbps > 0)) state.videoSeen = true;
    renderHud();
    emit('net', state.net);
  }

  function renderHud() {
    const el = ensureHud();
    if (!el) return;
    const net = state.net;
    const show = settings.enabled && settings.hud && state.matchAccepted && net &&
      net.state !== 'idle' && !!(net.width || net.kbps || net.bytes);
    if (!show) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    const mode = net.mode === 'relay' ? 'TURN' : 'P2P';
    const res = net.width && net.height ? net.width + '\u00D7' + net.height : '\u2014';
    const fps = net.fps ? (Math.round(net.fps * 10) / 10) + ' fps' : '\u2014 fps';
    const kbps = net.kbps ? net.kbps + ' kbps' : '\u2014 kbps';
    const out = net.outKbps ? '\u2191 ' + net.outKbps + ' kbps' : '';
    const rtt = net.rtt ? net.rtt + ' ms' : '';
    const timer = state.match && state.match.accepted
      ? clockText(Date.now() - state.match.at) : '';
    const put = (sel, text) => {
      const node = el.querySelector(sel);
      if (node && node.textContent !== text) node.textContent = text;
    };
    put('.utk-hud-mode', mode);
    put('.utk-hud-res', res);
    put('.utk-hud-fps', fps);
    put('.utk-hud-rate', kbps);
    put('.utk-hud-out', out);
    put('.utk-hud-rtt', rtt);
    put('.utk-hud-time', timer);
    el.classList.toggle('utk-relay', net.mode === 'relay');
  }

  function updateToolbarVisibility() {
    const tools = document.querySelector('.utk-tools');
    if (!tools) return;
    tools.style.display = settings.enabled && settings.toolbar ? 'flex' : 'none';
  }

  // =========================================================================
  // Tab title (country + match timer)
  // =========================================================================
  function syncTitle() {
    if (!pageTitle) pageTitle = document.title || 'Umingle';
    if (!settings.enabled || !settings.matchTitle) {
      if (pageTitle && document.title !== pageTitle) document.title = pageTitle;
      return;
    }
    const match = state.match;
    if (!match) {
      if (pageTitle && document.title !== pageTitle) document.title = pageTitle;
      return;
    }
    const where = match.countryName || match.country || 'Stranger';
    const head = match.accepted
      ? clockText(Date.now() - match.at) + ' \u00B7 ' + where
      : 'Connecting\u2026';
    const next = head + ' \u2014 ' + (pageTitle || 'Umingle');
    if (document.title !== next) document.title = next;
  }

  // =========================================================================
  // Chat: transcript, auto-greeting, sending
  // =========================================================================
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function stamp(ms) {
    const d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fileStamp() {
    const d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  /** Read one message node the way the site builds them (pw / dx). */
  function readChatNode(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.classList.contains('tempMessage')) return null;
    if (el.classList.contains('disconnectMessage')) {
      const t = (el.textContent || '').trim();
      return t ? { who: 'System', text: t } : null;
    }
    if (el.classList.contains('serverMessage')) {
      const t = (el.textContent || '').trim();
      return t ? { who: 'Server', text: t } : null;
    }
    const span = el.querySelector('span');
    if (!span) return null;
    let who = '';
    if (span.classList.contains('You')) who = 'You';
    else if (span.classList.contains('Partner')) who = 'Partner';
    else who = (span.textContent || '').trim();
    if (!who) return null;

    let text = el.textContent || '';
    const at = text.indexOf(who);
    if (at !== -1) text = text.slice(at + who.length);
    text = text.replace(/^\s+/, '').replace(/\s+$/, '');
    if (!text && el.querySelector('img')) text = '[GIF]';
    return { who, text };
  }

  function noteChatNode(el) {
    if (!el || el.nodeType !== 1) return;
    if (seenChat.has(el)) return;
    seenChat.add(el);
    if (!settings.enabled || !settings.chatLog) return;
    const item = readChatNode(el);
    if (!item || !item.text) return;
    const match = state.match;
    chatLog.push({
      at: Date.now(),
      seq: match ? match.seq : 0,
      country: match ? match.country : '',
      countryName: match ? match.countryName : '',
      who: item.who,
      text: item.text,
    });
    if (chatLog.length > CHAT_LOG_MAX) chatLog.splice(0, chatLog.length - CHAT_LOG_MAX);
    emit('chat', item);
  }

  function watchChat() {
    const host = document.getElementById('mainMessages');
    if (!host) return;
    if (!chatObserver) {
      try {
        chatObserver = new MutationObserver((records) => {
          records.forEach((rec) => {
            if (!rec.addedNodes) return;
            Array.prototype.forEach.call(rec.addedNodes, noteChatNode);
          });
        });
        chatObserver.observe(host, { childList: true });
      } catch (e) { /* ignore */ }
    }
    Array.prototype.forEach.call(host.children, noteChatNode);
  }

  function chatText() {
    if (!chatLog.length) return '';
    const lines = ['Umingle chat transcript', 'Saved ' + new Date().toLocaleString()];
    let lastSeq = -1;
    chatLog.forEach((e) => {
      if (e.seq && e.seq !== lastSeq) {
        lastSeq = e.seq;
        lines.push('');
        lines.push('--- ' + (e.countryName || e.country || 'Stranger') + ' \u00B7 ' + stamp(e.at) + ' ---');
      }
      lines.push('[' + stamp(e.at) + '] ' + e.who + ': ' + e.text);
    });
    return lines.join('\r\n') + '\r\n';
  }

  function saveBlob(name, blob) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { a.remove(); } catch (e) { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      }, 1500);
      return true;
    } catch (e) {
      log('download failed', e);
      return false;
    }
  }

  function downloadChatLog() {
    if (!settings.enabled) return false;
    const text = chatText();
    if (!text) {
      toast('No chat to save yet', 'muted', 1500);
      return false;
    }
    if (!saveBlob('umingle-chat-' + fileStamp() + '.txt',
      new Blob([text], { type: 'text/plain;charset=utf-8' }))) {
      toast('Could not save the chat', 'warn', 1800);
      return false;
    }
    toast('Chat transcript saved', 'ok', 1600);
    return true;
  }

  // =========================================================================
  // Snapshot (the stranger's current frame as PNG)
  // =========================================================================
  function snapshotName() {
    const match = state.match;
    const where = (match && (match.country || match.countryName)) || 'stranger';
    const safe = String(where).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 24);
    return 'umingle-' + safe + '-' + fileStamp() + '.png';
  }

  function takeSnapshot() {
    if (!settings.enabled) return false;
    const video = document.getElementById('otherVideo');
    const w = video ? video.videoWidth : 0;
    const h = video ? video.videoHeight : 0;
    if (!video || !video.srcObject || !w || !h) {
      toast('No stranger video to capture yet', 'muted', 1700);
      return false;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(video, 0, 0, w, h);
      const done = (blob) => {
        if (!blob) {
          toast('Could not save the snapshot', 'warn', 1800);
          return;
        }
        if (saveBlob(snapshotName(), blob)) toast('Snapshot saved', 'ok', 1500);
        else toast('Could not save the snapshot', 'warn', 1800);
      };
      if (typeof canvas.toBlob === 'function') canvas.toBlob(done, 'image/png');
      else {
        const url = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = snapshotName();
        a.click();
        toast('Snapshot saved', 'ok', 1500);
      }
      return true;
    } catch (e) {
      log('snapshot failed', e);
      toast('Could not save the snapshot', 'warn', 1800);
      return false;
    }
  }

  /** Type into the site's own chat field and press its send button. */
  function sendSiteChat(text) {    const value = String(text || '').trim();
    if (!value) return false;
    const input = document.querySelector('.messageInput');
    const send = document.querySelector('.sb');
    if (!input || !send) return false;
    const active = document.activeElement;
    try {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      send.click();
    } catch (e) {
      return false;
    }
    // pq() focuses the input. Put the focus back so the toolkit hotkeys keep
    // working, and never leave a greeting behind in the field.
    setTimeout(() => {
      try {
        if (input.value === value) input.value = '';
        if (active && active !== input && active.isConnected &&
            typeof active.focus === 'function') {
          active.focus({ preventScroll: true });
        } else if (document.activeElement === input) {
          input.blur();
        }
      } catch (e) { /* ignore */ }
    }, 250);
    return true;
  }

  function pickGreeting() {
    const raw = String(settings.greetText || '').trim();
    if (!raw) return '';
    const options = raw.split('|').map((s) => s.trim()).filter(Boolean);
    if (!options.length) return '';
    return options[Math.floor(Math.random() * options.length)];
  }

  function scheduleAutoGreet(match) {
    if (!settings.autoGreet || !match) return;
    const text = pickGreeting();
    if (!text) return;
    const seq = match.seq;
    greetSeq = seq;
    setTimeout(() => {
      if (greetSeq !== seq) return;
      if (!state.match || state.match.seq !== seq || !state.match.accepted) return;
      sendSiteChat(text);
    }, 900 + Math.floor(Math.random() * 500));
  }

  // =========================================================================
  // New visitor identity
  // =========================================================================
  const IDENTITY_COOLDOWN_MS = 8000;

  /** Drop the accountless visitor id the site stores in `user`. */
  function clearVisitorIdentity() {
    try { document.cookie = 'user=; Max-Age=0; Path=/; Secure'; } catch (e) {}
    try {
      document.cookie = 'user=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure';
    } catch (e) {}
    try { document.cookie = 'user=; Max-Age=0; Path=/'; } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
  }

  /**
   * Rotate the visitor identity and reload. Only the cookie-issued id is
   * cleared: interests, camera choice and a real `account_sid` login are
   * kept. When the last ban came from the address this browser still uses,
   * the rotation is refused: a fresh visitor id on the same IP is pointless.
   */
  async function newIdentity(source) {
    const now = Date.now();
    if (now - state.lastNewIdentityAt < IDENTITY_COOLDOWN_MS) {
      toast('New identity was requested a moment ago', 'muted', 1800);
      return false;
    }
    const ban = state.ban && now - state.ban.at < BAN_TTL_MS ? state.ban : null;
    if (ban) {
      const ip = await requestPublicIp(true);
      if (ban.ip && ip && ban.ip === ip) {
        toast('Still on the banned IP \u2014 change your IP first, then try again', 'warn', 4600);
        return false;
      }
    }
    state.lastNewIdentityAt = Date.now();
    if (state.ban) clearBan();
    clearVisitorIdentity();
    toast('New visitor identity \u2014 reloading\u2026', 'ok', 1800);
    try { emit('identity', { at: state.lastNewIdentityAt, source: String(source || '') }); } catch (e) {}
    setTimeout(() => {
      try { location.reload(); } catch (e) { /* ignore */ }
    }, 420);
    return true;
  }

  // =========================================================================
  // Toasts
  // =========================================================================
  let lastToast = { text: '', at: 0 };

  function toast(text, kind, ms) {
    const value = String(text || '').trim();
    if (!value || !document.body) return;
    const now = Date.now();
    if (lastToast.text === value && now - lastToast.at < 700) return;
    lastToast = { text: value, at: now };

    let host = document.querySelector('.utk-toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'utk-toasts';
      host.setAttribute('role', 'status');
      document.body.appendChild(host);
    }
    const item = document.createElement('div');
    item.className = 'utk-toast' + (kind ? ' utk-toast-' + kind : '');
    item.textContent = value;
    host.appendChild(item);
    setTimeout(() => { item.classList.add('utk-out'); }, Math.max(500, (ms || 2400) - 260));
    setTimeout(() => { if (item.parentNode) item.parentNode.removeChild(item); }, ms || 2400);
  }

  // =========================================================================
  // Boot
  // =========================================================================
  let filterRestored = false;
  let filterRestoring = false;

  function boot() {
    if (state.booted) return;
    state.booted = true;

    if (document.documentElement) {
      document.documentElement.classList.toggle('utk-hide-throttle', !!settings.hideThrottle);
    }

    watchThrottle();
    applyPremium();
    ensureGeoLine();
    watchChat();

    setInterval(() => {
      if (!settings.enabled) return;
      applyPremium();
      if (settings.hideThrottle) hideThrottleElement(document.getElementById('premiumThrottle'));
      applySelfView();
      ensureGeoLine();
      syncGeoVisibility();
      updateHudVisibility();
      watchChat();
      syncTitle();
      if (state.matchAccepted) renderHud();
    }, 1000);

    setInterval(syncGeoVisibility, 400);
    setInterval(() => {
      if (settings.rememberFilter && !filterRestored) scheduleFilterRestore();
    }, 2500);
  }

  function whenBody(fn) {
    if (document.body) { fn(); return; }
    let tries = 0;
    const tick = () => {
      if (document.body) { fn(); return; }
      if (++tries > 200) return;
      setTimeout(tick, 50);
    };
    tick();
  }

  // Keep trying until the MAIN world answers; it may have loaded first.
  let helloPing = 0;
  const helloTimer = setInterval(() => {
    if (state.pageReady || ++helloPing > 12) { clearInterval(helloTimer); return; }
    sendSettings();
  }, 1500);

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes[U.SETTINGS_KEY]) return;
      settings = U.mergeSettings(changes[U.SETTINGS_KEY].newValue);
      settingsLoaded = true;
      applySettings();
      sendSettings();
      emit('settings', settings);
    });
  } catch (e) { /* extension context invalidated */ }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (!msg || msg.utk !== 'identity') return undefined;
      newIdentity('popup').then((ok) => {
        if (typeof reply === 'function') reply({ ok: !!ok });
      }, () => {
        if (typeof reply === 'function') reply({ ok: false });
      });
      return true;
    });
  } catch (e) { /* extension context invalidated */ }

  globalThis.UTK = {
    MARK,
    ORIGIN,
    state,
    on,
    emit,
    get settings() { return settings; },
    get settingsLoaded() { return settingsLoaded; },
    setSettings,
    persistSettings,
    toast,
    requestSkip,
    selectedCountries,
    applyPremium,
    sendSettings,
    renderHud,
    updateHudVisibility,
    updateToolbarVisibility,
    ensureHud,
    ensureGeoLine,
    syncGeoVisibility,
    showShadowban,
    hideShadowban,
    bumpStat,
    bumpReason,
    todayStats,
    dayKey,
    selfViewMode,
    setSelfView,
    cycleSelfView,
    applySelfView,
    syncTitle,
    clockText,
    chatText,
    downloadChatLog,
    chatCount: () => chatLog.length,
    takeSnapshot,
    sendSiteChat,
    newIdentity,
    clearVisitorIdentity,
    openStrangerNote: openNoteEditor,
    blockedCountries,
    isBlockedCountry,
    normalizeCode,
    isEnabled: () => !!settings.enabled,
  };

  loadSettings();
  loadStats();
  loadIpBook();
  loadBan();

  whenBody(() => {
    boot();
  });

  // The site's premium UI is built by inline scripts near the end of the
  // document; boot may run before those. Retry a few times.
  [0, 600, 1800, 4000].forEach((delay) => setTimeout(() => {
    if (!settingsLoaded) return;
    applyPremium();
    watchThrottle();
    ensureGeoLine();
  }, delay));
})();
