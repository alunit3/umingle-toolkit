/*
 * Umingle Toolkit - call tools.
 *
 * Picture-in-Picture, volume boost with a limiter, mute, the in-video
 * toolbar, wake lock, the leave-page guard, stall auto-skip and hotkeys.
 *
 * Runs after bridge.js in the same isolated world and uses its UTK API.
 */
(function () {
  'use strict';

  const U = globalThis.UTK;
  if (!U) return;

  // bridge.js owns the capture/download functions; the toolbar wrappers below
  // are exposed on UTK under the same names, so keep the originals first.
  const bridgeTakeSnapshot = typeof U.takeSnapshot === 'function' ? U.takeSnapshot : null;

  const BOOSTS = [1, 1.5, 2];
  const STALL_GRACE_MS = 4000;
  const $ = (sel, root) => (root || document).querySelector(sel);

  let userActivated = false;
  let pipBound = false;
  let wake = null;
  let helpEl = null;
  let menuEl = null;
  let lastToolbarTry = 0;
  let stallSkipping = false;
  const stall = { acceptedAt: 0, lastActivity: 0, lastBytes: 0, lastSkipAt: 0 };
  const graphs = new WeakMap();
  let graphErrorShown = false;

  // =========================================================================
  // Helpers
  // =========================================================================
  function videoEl() {
    return document.getElementById('otherVideo');
  }

  function boostValue() {
    const n = Number(U.settings.volumeBoost);
    return BOOSTS.indexOf(n) === -1 ? 1 : n;
  }

  function isTypingTarget(target) {
    if (!target || !target.closest) return false;
    if (target.isContentEditable) return true;
    return !!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
  }

  function isConnectedMatch() {
    return !!(U.state.match && U.state.match.accepted);
  }

  function safeToast(text, kind) {
    try { U.toast(text, kind || 'info'); } catch (e) { /* ignore */ }
  }

  // =========================================================================
  // Toolbar
  // =========================================================================
  const ICONS = {
    pip: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="12" y="11" width="7" height="5" rx="1.2" fill="currentColor"/></svg>',
    sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h3l4-3.5v13L7 15H4z" fill="currentColor"/><path d="M15 8.5a4.6 4.6 0 0 1 0 7M17.6 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h3l4-3.5v13L7 15H4z" fill="currentColor"/><path d="M15 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    hud: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 14.5v-3m4 3V9m4 5.5v-2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6.5" width="18" height="12" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.4 6.5l1-1.4h5.2l1 1.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    identity: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.6" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.6 19.4c.6-3.2 3.2-5.1 6.4-5.1s5.8 1.9 6.4 5.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M17.6 5.2a4.6 4.6 0 0 1 1.9 3.4M18.7 3.2l.8 1.6-1.7.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="18" cy="12" r="1.5" fill="currentColor"/></svg>',
    help: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1" fill="currentColor"/></svg>',
  };

  function buildToolbar() {
    const host = document.querySelector('.videoWrapper.remote');
    if (!host) return null;
    let bar = document.querySelector('.utk-tools');
    if (bar && bar.isConnected) return bar;

    bar = document.createElement('div');
    bar.className = 'utk-tools';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Umingle Toolkit');
    bar.innerHTML =
      '<button type="button" class="utk-tool utk-tool-pip" data-act="pip" title="Picture-in-Picture (P)" aria-label="Picture-in-Picture">' + ICONS.pip + '</button>' +
      '<button type="button" class="utk-tool utk-tool-boost" data-act="boost" title="Volume boost (B)" aria-label="Volume boost">1\u00D7</button>' +
      '<button type="button" class="utk-tool utk-tool-mute" data-act="mute" title="Mute the stranger (M)" aria-label="Mute">' + ICONS.sound + '</button>' +
      '<button type="button" class="utk-tool utk-tool-hud" data-act="hud" title="Connection HUD (H)" aria-label="Connection HUD">' + ICONS.hud + '</button>' +
      '<button type="button" class="utk-tool utk-tool-shot" data-act="snapshot" title="Snapshot the stranger (C)" aria-label="Snapshot">' + ICONS.camera + '</button>' +
      '<button type="button" class="utk-tool utk-tool-identity" data-act="identity" title="New visitor identity (N)" aria-label="New visitor identity">' + ICONS.identity + '</button>' +
      '<button type="button" class="utk-tool utk-tool-more" data-act="more" title="More tools" aria-label="More tools" aria-haspopup="menu">' + ICONS.more + '</button>' +
      '<button type="button" class="utk-tool utk-tool-help" data-act="help" title="Toolkit help (?)" aria-label="Help">' + ICONS.help + '</button>';

    bar.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      runAction(btn.getAttribute('data-act'));
    });

    host.appendChild(bar);
    updateButtons();
    U.updateToolbarVisibility();
    return bar;
  }

  function updateButtons() {
    const bar = document.querySelector('.utk-tools');
    if (!bar) return;
    const boost = bar.querySelector('.utk-tool-boost');
    if (boost) {
      boost.textContent = boostValue() + '\u00D7';
      boost.classList.toggle('on', boostValue() > 1);
    }
    const hud = bar.querySelector('.utk-tool-hud');
    if (hud) hud.classList.toggle('on', !!U.settings.hud);
    const video = videoEl();
    const muted = !!(video && video.muted);
    const mute = bar.querySelector('.utk-tool-mute');
    if (mute) {
      mute.innerHTML = muted ? ICONS.muted : ICONS.sound;
      mute.classList.toggle('on', muted);
      mute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    }
    const pip = bar.querySelector('.utk-tool-pip');
    if (pip) {
      pip.classList.toggle('on', !!document.pictureInPictureElement);
      pip.disabled = !video;
    }
  }

  // =========================================================================
  // Actions
  // =========================================================================
  function runAction(action) {
    switch (action) {
      case 'pip': togglePip(); break;
      case 'boost': cycleBoost(); break;
      case 'mute': toggleMute(); break;
      case 'hud': toggleHud(); break;
      case 'snapshot': takeSnapshot(); break;
      case 'identity': rotateIdentity('toolbar'); break;
      case 'more': toggleMenu(); break;
      case 'help': openHelp(); break;
      default: break;
    }
  }

  function takeSnapshot() {
    closeMenu();
    try {
      if (bridgeTakeSnapshot) bridgeTakeSnapshot();
      else safeToast('Could not save the snapshot', 'warn');
    } catch (e) {
      safeToast('Could not save the snapshot', 'warn');
    }
  }

  function saveChatLog() {
    closeMenu();
    try { U.downloadChatLog(); } catch (e) { safeToast('Could not save the chat', 'warn'); }
  }

  function rotateIdentity(source) {
    closeMenu();
    try {
      if (typeof U.newIdentity === 'function') U.newIdentity(source || 'toolbar');
      else safeToast('New identity is unavailable', 'warn');
    } catch (e) {
      safeToast('New identity failed', 'warn');
    }
  }

  function cycleSelfView() {
    const mode = U.cycleSelfView();
    const label = mode === 'normal' ? 'Normal' : mode === 'hidden' ? 'Hidden' : 'Mirror';
    renderMenu();
    safeToast('Self view: ' + label, 'muted', 1400);
  }

  function toggleAutoGreet() {
    U.setSettings({ autoGreet: !U.settings.autoGreet });
    renderMenu();
    safeToast('Auto-greet ' + (U.settings.autoGreet ? 'on' : 'off'), 'muted', 1400);
  }

  function blockCurrentCountry() {
    closeMenu();
    const match = U.state.match;
    const code = U.normalizeCode(match && match.country);
    if (!code) { safeToast('This stranger has no country to block', 'muted', 1700); return; }
    const list = U.blockedCountries();
    const name = (match && (match.countryName || match.country)) || code;
    if (list.indexOf(code) !== -1) {
      safeToast(name + ' is already blocked', 'muted', 1600);
    } else {
      U.setSettings({ blockCountries: list.concat(code) });
      safeToast('Blocked ' + name + ' \u00B7 leaving now', 'ok', 1800);
    }
    if (U.state.matchAccepted) U.requestSkip('blocked', { toast: 'Skipped ' + name + ' (blocked country)' });
  }

  // =========================================================================
  // More menu
  // =========================================================================
  function selfViewLabel() {
    const mode = U.selfViewMode();
    return mode === 'normal' ? 'Normal' : mode === 'hidden' ? 'Hidden' : 'Mirror';
  }

  function buildMenu() {
    const host = document.querySelector('.videoWrapper.remote');
    if (!host) return null;
    const existing = document.querySelector('.utk-menu');
    if (existing && existing.isConnected) { menuEl = existing; return existing; }

    const el = document.createElement('div');
    el.className = 'utk-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'More toolkit tools');
    el.style.display = 'none';
    el.addEventListener('click', (ev) => {
      const item = ev.target && ev.target.closest ? ev.target.closest('[data-menu]') : null;
      if (!item) return;
      ev.preventDefault();
      ev.stopPropagation();
      switch (item.getAttribute('data-menu')) {
        case 'snapshot': takeSnapshot(); break;
        case 'chatlog': saveChatLog(); break;
        case 'note':
          closeMenu();
          if (typeof U.openStrangerNote === 'function') U.openStrangerNote();
          break;
        case 'identity': rotateIdentity('menu'); break;
        case 'self': cycleSelfView(); break;
        case 'greet': toggleAutoGreet(); break;
        case 'block': blockCurrentCountry(); break;
        default: closeMenu();
      }
    });
    host.appendChild(el);
    menuEl = el;
    return el;
  }

  function renderMenu() {
    const el = menuEl || buildMenu();
    if (!el) return;
    const match = U.state.match;
    const code = U.normalizeCode(match && match.country);
    const name = (match && (match.countryName || match.country)) || '';
    const greet = !!U.settings.autoGreet;
    el.innerHTML =
      '<button type="button" class="utk-menu-item" data-menu="snapshot" role="menuitem">' +
        '<span class="utk-menu-label">Snapshot</span><span class="utk-menu-key">C</span></button>' +
      '<button type="button" class="utk-menu-item" data-menu="chatlog" role="menuitem">' +
        '<span class="utk-menu-label">Save chat log</span><span class="utk-menu-key">D</span></button>' +
      '<button type="button" class="utk-menu-item" data-menu="note" role="menuitem"' +
        (U.state.matchAccepted ? '' : ' disabled') + '>' +
        '<span class="utk-menu-label">Note this stranger</span></button>' +
      '<button type="button" class="utk-menu-item" data-menu="self" role="menuitem">' +
        '<span class="utk-menu-label">Self view</span><span class="utk-menu-value">' + selfViewLabel() + '</span></button>' +
      '<button type="button" class="utk-menu-item' + (greet ? ' on' : '') + '" data-menu="greet" role="menuitemcheckbox" aria-checked="' + greet + '">' +
        '<span class="utk-menu-label">Auto-greet</span><span class="utk-menu-value">' + (greet ? 'On' : 'Off') + '</span></button>' +
      '<div class="utk-menu-sep" role="separator"></div>' +
      '<button type="button" class="utk-menu-item" data-menu="identity" role="menuitem">' +
        '<span class="utk-menu-label">New visitor identity</span><span class="utk-menu-key">N</span></button>' +
      '<div class="utk-menu-sep" role="separator"></div>' +
      '<button type="button" class="utk-menu-item danger" data-menu="block" role="menuitem"' +
        (code ? '' : ' disabled') + '>' +
        '<span class="utk-menu-label">Block ' + (code ? name : 'this country') + '</span>' +
        '<span class="utk-menu-value">' + (code ? code : '') + '</span></button>';
  }

  function openMenu() {
    const el = buildMenu();
    if (!el) return;
    renderMenu();
    el.style.display = 'flex';
    // The toolbar wraps on a narrow video wrapper; keep the menu under it.
    try {
      const host = el.parentElement;
      const bar = document.querySelector('.utk-tools');
      if (host && bar) {
        const hb = host.getBoundingClientRect();
        const bb = bar.getBoundingClientRect();
        el.style.top = Math.max(34, Math.round(bb.bottom - hb.top + 6)) + 'px';
      }
    } catch (e) { /* keep the stylesheet position */ }
    const more = document.querySelector('.utk-tool-more');
    if (more) more.classList.add('on');
  }

  function closeMenu() {
    if (menuEl) menuEl.style.display = 'none';
    const more = document.querySelector('.utk-tool-more');
    if (more) more.classList.remove('on');
  }

  function toggleMenu() {
    const el = menuEl || buildMenu();
    if (!el) return;
    if (el.style.display === 'none' || !el.style.display) openMenu();
    else closeMenu();
  }

  document.addEventListener('pointerdown', (ev) => {
    if (!menuEl || menuEl.style.display === 'none') return;
    const target = ev.target;
    if (menuEl.contains(target)) return;
    if (target && target.closest && target.closest('.utk-tool-more')) return;
    closeMenu();
  }, true);

  function cycleBoost() {
    const i = BOOSTS.indexOf(boostValue());
    const next = BOOSTS[(i + 1) % BOOSTS.length];
    U.setSettings({ volumeBoost: next });
    applyBoost(videoEl());
    updateButtons();
    safeToast('Volume boost: ' + next + '\u00D7', 'ok', 1500);
  }

  function toggleMute() {
    const video = videoEl();
    if (!video) { safeToast('No stranger video yet', 'muted'); return; }
    video.muted = !video.muted;
    updateButtons();
    safeToast(video.muted ? 'Muted' : 'Sound on', 'muted', 1300);
  }

  function toggleHud() {
    U.setSettings({ hud: !U.settings.hud });
    updateButtons();
    U.updateHudVisibility();
    U.renderHud();
    safeToast('Connection HUD ' + (U.settings.hud ? 'on' : 'off'), 'muted', 1400);
  }

  // =========================================================================
  // Picture-in-Picture
  // =========================================================================
  async function togglePip() {
    const video = videoEl();
    if (document.pictureInPictureElement) {
      try { await document.exitPictureInPicture(); } catch (e) { /* ignore */ }
      return;
    }
    if (!video) { safeToast('No stranger video yet', 'warn'); return; }
    if (!video.srcObject) { safeToast('No stranger video yet', 'warn'); return; }
    if (typeof video.requestPictureInPicture !== 'function') {
      safeToast('Picture-in-Picture is not available here', 'warn');
      return;
    }
    try {
      await video.requestPictureInPicture();
    } catch (e) {
      safeToast('PiP failed: ' + (e && e.message ? e.message : 'not allowed'), 'warn');
    }
  }

  function bindPipEvents() {
    if (pipBound) return;
    pipBound = true;
    document.addEventListener('enterpictureinpicture', updateButtons);
    document.addEventListener('leavepictureinpicture', updateButtons);
    U.on('end', () => {
      if (document.pictureInPictureElement) {
        try { document.exitPictureInPicture(); } catch (e) { /* ignore */ }
      }
    });
  }

  // =========================================================================
  // Volume boost (a gain node plus a compressor as a safety limiter)
  //
  // The graph is only created after a real user gesture: a suspended
  // AudioContext would silence the element once the media source is routed
  // through it. Until then the element plays normally at its own volume.
  // =========================================================================
  function ensureGraph(video) {
    const existing = graphs.get(video);
    if (existing) return existing;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    try {
      const ctx = new AC();
      const source = ctx.createMediaElementSource(video);
      const gain = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.knee.value = 8;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      source.connect(gain);
      gain.connect(comp);
      comp.connect(ctx.destination);
      gain.gain.value = boostValue();
      const graph = { ctx, source, gain, comp, video };
      graphs.set(video, graph);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return graph;
    } catch (e) {
      if (!graphErrorShown) {
        graphErrorShown = true;
        safeToast('Volume boost is unavailable in this browser', 'warn');
      }
      return null;
    }
  }

  function applyBoost(video) {
    const boost = boostValue();
    updateButtons();
    if (!video) return;
    const existing = graphs.get(video);
    if (boost <= 1 && !existing) return;
    if (!existing && !userActivated) return;
    const graph = existing || ensureGraph(video);
    if (!graph) return;
    if (graph.ctx.state === 'suspended') graph.ctx.resume().catch(() => {});
    try {
      graph.gain.gain.setTargetAtTime(boost, graph.ctx.currentTime, 0.03);
    } catch (e) { /* ignore */ }
  }

  function noteGesture() {
    if (userActivated) return;
    userActivated = true;
    const video = videoEl();
    if (video && boostValue() > 1) applyBoost(video);
    if (wake && wake.released === false) { /* already held */ }
  }

  function bindVideo(video) {
    if (!video || video.__utkBound) return;
    video.__utkBound = true;
    video.addEventListener('volumechange', updateButtons);
    video.addEventListener('loadedmetadata', updateButtons);
  }

  // =========================================================================
  // Wake lock
  // =========================================================================
  async function acquireWake() {
    if (!U.settings.wakeLock || !isConnectedMatch()) return;
    if (document.visibilityState !== 'visible') return;
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
    if (wake && !wake.released) return;
    try {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } catch (e) { wake = null; }
  }

  async function releaseWake() {
    const sentinel = wake;
    wake = null;
    if (!sentinel) return;
    try { await sentinel.release(); } catch (e) { /* ignore */ }
  }

  function bindWake() {
    U.on('accepted', () => { acquireWake(); });
    U.on('end', () => { releaseWake(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') acquireWake();
      else releaseWake();
    });
  }

  // =========================================================================
  // Leave-page guard
  // =========================================================================
  window.addEventListener('beforeunload', (ev) => {
    if (!U.settings.leaveGuard) return;
    if (!U.state.connected || !U.state.matchAccepted) return;
    ev.preventDefault();
    ev.returnValue = '';
    return '';
  });

  // =========================================================================
  // Stall auto-skip (opt-in)
  // =========================================================================
  function resetStall() {
    stall.acceptedAt = Date.now();
    stall.lastActivity = Date.now();
    stall.lastBytes = 0;
    stallSkipping = false;
  }

  function checkStall() {
    if (!U.settings.enabled || !U.settings.skipStalled) return;
    if (!isConnectedMatch() || stallSkipping) return;
    const seconds = Math.max(4, Math.min(120, Number(U.settings.stallSeconds) || 10));
    if (Date.now() - stall.acceptedAt < seconds * 1000 + STALL_GRACE_MS) return;
    if (Date.now() - stall.lastActivity < seconds * 1000) return;

    stallSkipping = true;
    stall.lastSkipAt = Date.now();
    U.requestSkip('stall', { toast: 'Skipped a stalled call' });
  }

  function bindStall() {
    U.on('accepted', resetStall);
    U.on('end', () => { stall.acceptedAt = 0; stallSkipping = false; });
    U.on('net', (net) => {
      if (!net) return;
      if (Number(net.bytes) > stall.lastBytes) {
        stall.lastBytes = Number(net.bytes) || 0;
        stall.lastActivity = Date.now();
      }
      if (Number(net.kbps) > 0) stall.lastActivity = Date.now();
    });
    setInterval(checkStall, 1000);
  }

  // =========================================================================
  // Help overlay
  // =========================================================================
  function buildHelp() {
    if (helpEl && helpEl.isConnected) return helpEl;
    helpEl = document.createElement('div');
    helpEl.className = 'utk-help';
    helpEl.style.display = 'none';
    helpEl.innerHTML =
      '<div class="utk-help-card" role="dialog" aria-modal="true" aria-label="Umingle Toolkit help">' +
        '<div class="utk-help-head"><div><strong>Umingle Toolkit</strong><span>v3.7.0 \u00B7 on this device</span></div>' +
        '<button type="button" class="utk-help-close" aria-label="Close">' +
        '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
        '<path d="M2.2 2.2 9.8 9.8M9.8 2.2 2.2 9.8"/></svg></button></div>' +
        '<div class="utk-help-col">' +
          '<h4>Hotkeys</h4>' +
          '<div class="utk-key"><kbd>S</kbd><span>Skip the current stranger</span></div>' +
          '<div class="utk-key"><kbd>Esc</kbd><span>Skip at once</span></div>' +
          '<div class="utk-key"><kbd>P</kbd><span>Picture-in-Picture</span></div>' +
          '<div class="utk-key"><kbd>B</kbd><span>Volume boost 1\u00D7 / 1.5\u00D7 / 2\u00D7</span></div>' +
          '<div class="utk-key"><kbd>M</kbd><span>Mute / unmute them</span></div>' +
          '<div class="utk-key"><kbd>H</kbd><span>Connection HUD on / off</span></div>' +
          '<div class="utk-key"><kbd>C</kbd><span>Snapshot the stranger (PNG)</span></div>' +
          '<div class="utk-key"><kbd>D</kbd><span>Save the chat transcript</span></div>' +
          '<div class="utk-key"><kbd>V</kbd><span>Self view: Mirror / Normal / Hidden</span></div>' +
          '<div class="utk-key"><kbd>N</kbd><span>New identity</span></div>' +
          '<div class="utk-key"><kbd>?</kbd><span>This help</span></div>' +
        '</div>' +
        '<div class="utk-help-foot">Settings and stats live in the toolbar popup (Alt+Shift+U).</div>' +
      '</div>';

    helpEl.addEventListener('click', (ev) => {
      if (ev.target === helpEl || (ev.target.closest && ev.target.closest('.utk-help-close'))) {
        ev.preventDefault();
        closeHelp();
      }
    });
    document.body.appendChild(helpEl);
    return helpEl;
  }

  function openHelp() {
    closeMenu();
    U.state.helpOpen = true;
    const el = buildHelp();
    el.style.display = 'flex';
  }

  function closeHelp() {
    U.state.helpOpen = false;
    if (helpEl) helpEl.style.display = 'none';
  }

  // =========================================================================
  // Hotkeys
  // =========================================================================
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    if (U.state.helpOpen) {
      if (ev.key === 'Escape' || ev.key === '?') {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        closeHelp();
      }
      return;
    }

    if (isTypingTarget(ev.target)) return;

    // Escape leaves the stranger at once (the site itself asks twice).
    if (ev.key === 'Escape' && U.settings.enabled && U.settings.escapeSkip) {
      if (!isConnectedMatch()) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      U.requestSkip('user', { toast: 'Skipped (Esc)' });
      return;
    }

    if (!U.settings.enabled || !U.settings.hotkeys) return;

    switch (ev.key) {
      case '?':
        ev.preventDefault();
        openHelp();
        break;
      case 's':
      case 'S':
        if (!isConnectedMatch()) return;
        ev.preventDefault();
        U.requestSkip('user', { toast: 'Skipped' });
        break;
      case 'p':
      case 'P':
        ev.preventDefault();
        togglePip();
        break;
      case 'b':
      case 'B':
        ev.preventDefault();
        cycleBoost();
        break;
      case 'm':
      case 'M':
        ev.preventDefault();
        toggleMute();
        break;
      case 'h':
      case 'H':
        ev.preventDefault();
        toggleHud();
        break;
      case 'c':
      case 'C':
        ev.preventDefault();
        takeSnapshot();
        break;
      case 'd':
      case 'D':
        ev.preventDefault();
        saveChatLog();
        break;
      case 'v':
      case 'V':
        ev.preventDefault();
        cycleSelfView();
        break;
      case 'n':
      case 'N':
        ev.preventDefault();
        rotateIdentity('hotkey');
        break;
      default:
        return;
    }
  }, true);

  // =========================================================================
  // Lifecycle
  // =========================================================================
  function onMatchStart() {
    const video = videoEl();
    bindVideo(video);
    resetStall();
    applyBoost(video);
  }

  U.on('match', onMatchStart);
  U.on('accepted', () => {
    const video = videoEl();
    bindVideo(video);
    applyBoost(video);
    updateButtons();
    resetStall();
  });
  U.on('end', () => {
    closeMenu();
    stall.acceptedAt = 0;
    stallSkipping = false;
  });
  U.on('settings', () => {
    updateButtons();
    U.updateToolbarVisibility();
    U.updateHudVisibility();
    renderMenu();
    const video = videoEl();
    if (video) applyBoost(video);
  });
  U.on('net', updateButtons);

  document.addEventListener('pointerdown', noteGesture, true);
  document.addEventListener('keydown', noteGesture, true);

  function tick() {
    const now = Date.now();
    if (now - lastToolbarTry > 1500) {
      lastToolbarTry = now;
      buildToolbar();
      const video = videoEl();
      if (video) {
        bindVideo(video);
        if (boostValue() > 1 && userActivated) applyBoost(video);
      }
      const mute = document.querySelector('.utk-tool-mute');
      if (mute) updateButtons();
    }
    U.updateHudVisibility();
  }

  bindPipEvents();
  bindWake();
  bindStall();

  function start() {
    buildToolbar();
    const video = videoEl();
    bindVideo(video);
    updateButtons();
    setInterval(tick, 1200);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  // Exposed for bridge.js after a match is accepted.
  U.applyBoost = applyBoost;
  U.togglePip = togglePip;
  U.openHelp = openHelp;
  U.closeHelp = closeHelp;
  U.cycleBoost = cycleBoost;
  U.toggleMute = toggleMute;
  U.toggleHud = toggleHud;
  U.takeSnapshot = takeSnapshot;
  U.saveChatLog = saveChatLog;
  U.cycleSelfViewUi = cycleSelfView;
  U.rotateIdentity = rotateIdentity;
  U.toggleMenu = toggleMenu;
})();