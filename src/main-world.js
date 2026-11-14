/*
 * Umingle Toolkit - MAIN world hooks.
 *
 * Runs at document_start in the page's own JavaScript world, before the site
 * scripts. It only observes and substitutes:
 *
 *   WebSocket              -> sees `conn` / `throttle` / `end` / moderation
 *                             events and the page's outgoing signals; answers
 *                             or drops server challenges and can rewrite `sb`
 *   RTCPeerConnection      -> collects the stranger's public ICE address and
 *                             reads getStats() for the connection HUD; can
 *                             force relay-only ICE
 *   Worker                 -> answers /static/vision.js with a face-found stub
 *   Blob                   -> substitutes the webcam moderation snapshot
 *   BroadcastChannel       -> private channel per tab in multi-tab mode
 *   MediaDeviceInfo.label  -> presents virtual cameras as physical ones
 *   MediaStreamTrack.label
 *
 * It cannot touch chrome.*; it talks to the isolated-world bridge through
 * window.postMessage with the marker below. The isolated world mirrors the
 * page-relevant settings into localStorage (`umingle_toolkit_boot`) so the
 * document_start pass sees the last state synchronously.
 */
(function () {
  'use strict';

  const MARK = 'uming-sync';
  const ORIGIN = location.origin;
  const VERSION = '3.6.0';
  const DEBUG = false;
  // The offline harness replaces this line with `true` in a scratch copy so it
  // can call the label mapper. Never true on the real site.
  const TEST_HOOK = false; // UTK_TEST_HOOK

  const log = (...a) => { if (DEBUG) console.info('[umingle-toolkit]', ...a); };

  const DEFAULTS = {
    enabled: true,
    cityLookup: true,
    hud: true,
    easySkip: true,
    faceStub: true,
    cameraSpoof: true,
    stealthScreenshot: true,
    stealthRc: true,
    stealthInjection: false,
    stealthHooks: true,
    relayOnly: false,
    multiTab: false,
    moderatorMode: false,
    autoNext: true,
    sbUnblank: false,
    moderationSpoof: false,
    banBypass: false,
    antiReport: false,
    freshVisitor: false,
    blockRedirects: false,
    noLoginGate: false,
    keepPremium: false,
    keepInterests: false,
  };

  const state = Object.assign({}, DEFAULTS);

  // document_start is before chrome.storage answers: read the synchronous
  // mirror the bridge wrote on the previous page load.
  try {
    const raw = localStorage.getItem('umingle_toolkit_boot');
    if (raw) {
      const boot = JSON.parse(raw);
      if (boot && typeof boot === 'object') {
        Object.keys(DEFAULTS).forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(boot, key)) state[key] = boot[key];
        });
      }
    }
  } catch (e) { /* private mode */ }

  /**
   * Make a wrapper look like a native function. V8's Function.prototype
   * toString reports a Proxy target as `[native code]`, and property access
   * (length, name, prototype) forwards to the target, so set those first.
   */
  function nativeize(fn, name, length) {
    if (!state.stealthHooks) return fn;
    try {
      if (typeof name === 'string' && name) {
        Object.defineProperty(fn, 'name', { value: name, configurable: true });
      }
      if (typeof length === 'number') {
        Object.defineProperty(fn, 'length', { value: length, configurable: true });
      }
      return new Proxy(fn, {});
    } catch (e) {
      return fn;
    }
  }

  // -------------------------------------------------------------------------
  // Bridge link
  // -------------------------------------------------------------------------
  function post(type, data) {
    try {
      window.postMessage({ __uming: MARK, dir: 'page', type, data: data || null }, ORIGIN);
    } catch (e) { /* never break the page */ }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const msg = ev.data;
    if (!msg || msg.__uming !== MARK || msg.dir !== 'bridge') return;

    if (msg.type === 'settings' && msg.data && typeof msg.data === 'object') {
      Object.assign(state, msg.data);
      applySessionSettings();
      return;
    }
    if (msg.type === 'accept' && msg.data && currentMatch && msg.data.seq === currentMatch.seq) {
      currentMatch.accepted = true;
      maybeStartGeo();
      return;
    }
    if (msg.type === 'publicIp') {
      fetchOwnIp(!!(msg.data && msg.data.force));
    }
  });

  // -------------------------------------------------------------------------
  // 0. Easy skip
  //
  // The site's own skip flow needs two presses: the first only turns the
  // button into "Really?", the second leaves. Both presses are handled by the
  // same `ps()` on mousedown/touchstart, and `window.pressed` records every
  // press for the site's mashing pause. A trusted press is intercepted here,
  // the pair runs against a scratch history, and only one logical press is
  // recorded afterwards.
  // -------------------------------------------------------------------------
  function skipButton() {
    return document.querySelector('.skipButton');
  }

  function skipText(btn) {
    const label = btn && btn.querySelector('.mainText');
    return label ? label.textContent.trim().toLowerCase() : '';
  }

  function fireSkipPress(btn) {
    btn.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
    }));
  }

  let lastEasyAt = 0;

  function easySkipNow() {
    const btn = skipButton();
    if (!btn) return false;
    const text = skipText(btn);
    if (text !== 'skip' && text !== 'really?' && text !== 'really') return false;
    lastEasyAt = Date.now();

    let history = null;
    try {
      history = Array.isArray(window.pressed) ? window.pressed : [];
      window.pressed = [];
    } catch (e) { history = null; }

    let done = false;
    try {
      fireSkipPress(btn);
      if (text === 'skip') {
        // While the page is searching it ignores the press; the label then
        // stays "Skip" and a second press would be pointless.
        if (skipText(btn) !== 'skip') {
          fireSkipPress(btn);
          done = true;
        }
      } else {
        done = true;
      }
    } catch (e) {
      log('easy skip', e);
    }

    try {
      if (history) {
        window.pressed = history;
        history.push(Date.now());
        while (history.length > 4) history.shift();
      }
    } catch (e) { /* ignore */ }
    return done;
  }

  function onSkipPress(ev) {
    if (!state.enabled || !state.easySkip) return;
    if (!ev.isTrusted) return;
    const target = ev.target;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('.skipButton')) return;
    // A touch press also produces a compatibility mousedown; one gesture is
    // one skip, never a second pass over the next stranger.
    if (Date.now() - lastEasyAt < 600) {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      return;
    }
    const text = skipText(skipButton());
    if (text !== 'skip' && text !== 'really?' && text !== 'really') return;
    ev.preventDefault();
    ev.stopPropagation();
    if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
    easySkipNow();
  }

  document.addEventListener('mousedown', onSkipPress, true);
  document.addEventListener('touchstart', onSkipPress, { capture: true, passive: false });

  // Bridge-driven skips (country filter, shadowban, stall, blocked country):
  // the isolated world asks the page world to do the pair in one go.
  document.addEventListener('utk-easy-skip', (ev) => {
    if (!state.enabled || !state.easySkip) return;
    if (easySkipNow()) ev.preventDefault();
  }, true);

  // -------------------------------------------------------------------------
  // 1. WebSocket
  // -------------------------------------------------------------------------
  const NativeWebSocket = window.WebSocket;
  const watchedSockets = new WeakSet();
  let currentSocket = null;
  let matchSeq = 0;
  let currentMatch = null;

  function isTargetSocket(url) {
    return /^wss?:\/\/[^/]+\/ws(?:\?|$)/i.test(String(url));
  }

  function watchSocket(ws, url) {
    if (watchedSockets.has(ws)) return;
    watchedSockets.add(ws);
    log('watching socket', url);

    ws.addEventListener('open', () => {
      currentSocket = ws;
      post('ws', { open: true, url: String(url), at: Date.now() });
      if (state.enabled && state.moderatorMode) {
        // The site's raw handler reads "cm" and sets E.cm itself; delivering
        // the frame locally is enough, nothing goes to the server.
        deliverFrame(ws, 'cm');
        post('moderator', { synthetic: true, at: Date.now() });
      }
    });
    ws.addEventListener('close', () => {
      if (currentSocket === ws) currentSocket = null;
      post('ws', { open: false, url: String(url), at: Date.now() });
    });
    // Registered at construction, so this runs before the page's onmessage.
    ws.addEventListener('message', (ev) => {
      if (!ev || ev.__utkSynthetic) return;
      try { screenMessage(ws, ev); } catch (e) { log('message hook', e); }
    });
  }

  /** Deliver a message event the page handlers should see as server traffic. */
  function deliverFrame(ws, data) {
    try {
      const ev = new MessageEvent('message', { data, origin: ORIGIN, lastEventId: '' });
      ev.__utkSynthetic = true;
      ws.dispatchEvent(ev);
      return true;
    } catch (e) {
      log('deliver', e);
      return false;
    }
  }

  /**
   * Inspect a frame before the page's own handler runs.
   *
   * Returns null to pass it through, { drop: true } to hide it from the page,
   * or { data } to replace the payload (the `sb` rewrite). Our observer runs
   * first; dropping uses stopImmediatePropagation, and rewriting shadows
   * MessageEvent.data with an own value, so both sides see the same frame.
   */
  function screenMessage(ws, ev) {
    const raw = ev.data;
    if (typeof raw !== 'string') return;

    if (raw === 'newtab') {
      if (state.enabled && state.multiTab) {
        try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
        return;
      }
    }

    // `forceEnd` is the bare socket shutdown behind the "another tab" overlay.
    if (raw === 'forceEnd' && state.enabled && state.multiTab) {
      try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      post('othertab', { forced: true, at: Date.now() });
      return;
    }

    // `ncm` is a raw text frame: it would call the page's premium reset.
    if (raw === 'ncm' && state.enabled && state.keepPremium) {
      try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      post('premiumKept', { kind: 'ncm', at: Date.now() });
      return;
    }

    // `vm` is the server asking for a cache-busting reload of the page.
    if (raw === 'vm' && state.enabled && state.blockRedirects) {
      try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      post('navBlocked', { kind: 'reload', at: Date.now() });
      return;
    }

    // JSON control frames start with '{'. SDP blobs never do.
    if (raw.charCodeAt(0) !== 123) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.event !== 'string') return;

    if (msg.event === 'cookie' && state.enabled && state.multiTab) {
      try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      return;
    }

    if (msg.event === 'ss') {
      // Let the site take its screenshot; only our own UI is hidden.
      if (state.enabled && state.stealthScreenshot) beginScreenshotHide();
      return;
    }

    if (msg.event === 'rc') {
      if (state.enabled && state.stealthRc) {
        try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
        answerEval(ws, msg.code);
        return;
      }
      return;
    }

    if (msg.event === 'injection') {
      if (state.enabled && state.stealthInjection) {
        try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
        post('injection', { at: Date.now() });
        return;
      }
      return;
    }

    if (msg.event === 'newtab' && state.enabled && state.multiTab) {
      try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      return;
    }

    if (msg.event === 'conn' && state.enabled && state.sbUnblank && msg.sb) {
      const next = JSON.stringify(Object.assign({}, msg, { sb: false }));
      try {
        Object.defineProperty(ev, 'data', { value: next, configurable: true });
        post('sbunblank', { at: Date.now() });
      } catch (e) {
        // Shadowing refused: hide the original from the page and re-deliver.
        try { ev.stopImmediatePropagation(); } catch (err) { /* ignore */ }
        deliverFrame(ws, next);
        post('sbunblank', { at: Date.now() });
        return;
      }
      observeIncoming(next);
      return;
    }

    // `banned` and `ageBlock` only change local UI state: the page sets its own
    // `E.banned` flag and shows an overlay. Hiding the frame keeps the page
    // searchable. The server-side ban (and any IP restriction) is unchanged.
    if (msg.event === 'banned' || msg.event === 'ageBlock') {
      post('ban', {
        kind: msg.event,
        reason: msg.reason ? String(msg.reason) : '',
        banId: msg.banId ? String(msg.banId) : '',
        suppressed: !!(state.enabled && state.banBypass),
        at: Date.now(),
      });
    }

    if ((msg.event === 'banned' || msg.event === 'ageBlock') &&
        state.enabled && state.banBypass) {
      try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      return;
    }

    // The server can navigate the page away from a call.
    if (msg.event === 'redirect' && state.enabled && state.blockRedirects) {
      try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      post('navBlocked', { kind: 'redirect', url: String(msg.url || '').slice(0, 300), at: Date.now() });
      return;
    }

    // `requireLogin` shows a login overlay and sets E.requiresLogin, which
    // blocks the page's own search. Hiding it leaves the session as-is.
    if (msg.event === 'requireLogin' && state.enabled && state.noLoginGate) {
      try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      post('loginBlocked', { at: Date.now() });
      return;
    }

    // A server-side Premium expiry would reset filters and the sim Premium.
    if ((msg.event === 'ncm' || msg.event === 'premiumExpired') &&
        state.enabled && state.keepPremium) {
      try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      post('premiumKept', { kind: msg.event, at: Date.now() });
      return;
    }

    // `clearInterests` makes the page wipe the saved interest list.
    if (msg.event === 'clearInterests' && state.enabled && state.keepInterests) {
      try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      post('interestsKept', { at: Date.now() });
      return;
    }

    observeIncoming(raw);
  }

  function observeOutgoing(ws, data) {
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      noteOutgoingBlob(data);
      return;
    }
    if (!state.enabled || typeof data !== 'string' || data.charCodeAt(0) !== 123) return;
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || typeof msg.event !== 'string') return;

    if (msg.event === 'findPeer') {
      post('search', { at: Date.now() });
      return;
    }
    if (msg.event === 'report') {
      if (state.enabled && state.antiReport) {
        post('reportBlocked', { id: msg.id == null ? '' : String(msg.id), at: Date.now() });
        return false;
      }
      return;
    }
    if (msg.event === 'stop') {
      const wasConnected = !!(currentMatch && currentMatch.connected);
      if (wasConnected) post('stop', { at: Date.now() });
      return;
    }
    if (msg.event === 'searchCountries' || msg.event === 'searchLanguages') {
      post('filter', {
        kind: msg.event === 'searchCountries' ? 'countries' : 'languages',
        values: Array.isArray(msg.countries) ? msg.countries.slice()
          : Array.isArray(msg.languages) ? msg.languages.slice() : [],
      });
    }
  }

  /** Binary frames: 0x09 = challenge screenshot, 0x01 = moderation snapshot. */
  function noteOutgoingBlob(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function') return;
    blob.arrayBuffer().then((buf) => {
      if (!buf || !buf.byteLength) return;
      const head = new Uint8Array(buf, 0, 1)[0];
      if (head === 9) endScreenshotHide();
      else if (head === 1) post('rimage', { at: Date.now(), spoofed: spoofsModeration() });
    }).catch(() => { /* detached or closed */ });
  }

  if (typeof NativeWebSocket === 'function' && NativeWebSocket.prototype) {
    const wrappedSocket = function (url, protocols) {
      // A fresh visitor per connection: drop the stored id before the
      // handshake, so the server has to issue a new `cookie` event.
      try {
        if (state.enabled && state.freshVisitor && isTargetSocket(url)) clearVisitorCookie();
      } catch (e) { /* ignore */ }
      const ws = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
      try {
        if (isTargetSocket(url)) watchSocket(ws, url);
      } catch (e) { /* never break the page's socket */ }
      return ws;
    };
    wrappedSocket.prototype = NativeWebSocket.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((key) => {
      try {
        Object.defineProperty(wrappedSocket, key, {
          value: NativeWebSocket[key],
          enumerable: true,
        });
      } catch (e) { /* ignore */ }
    });
    window.WebSocket = nativeize(wrappedSocket, 'WebSocket', 1);

    // Intercept on the prototype, never on the instance: an own `send` is
    // exactly the kind of trace a page-side hook check looks for.
    const proto = NativeWebSocket.prototype;
    const nativeSend = proto.send;
    if (typeof nativeSend === 'function') {
      proto.send = nativeize(function send(data) {
        let verdict;
        try { verdict = observeOutgoing(this, data); } catch (e) { log('send hook', e); }
        if (verdict === false) return undefined;
        return nativeSend.call(this, data);
      }, 'send', 1);
    }
  }


  // -------------------------------------------------------------------------
  // 1b. Server challenge handling (`ss` screenshot, `rc` eval, `injection`)
  // -------------------------------------------------------------------------
  let ssHideAt = 0;
  let ssTimer = 0;

  function screenshotClass(on) {
    const root = document.documentElement;
    if (!root) return false;
    try {
      root.classList.toggle('utk-ss-hide', !!on);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * The site's `pp()` loads html2canvas and screenshots document.body a moment
   * later. Hide the toolkit's own overlays until the PNG is on its way out (or
   * a generous timeout), so the challenge sees the page as a visitor would.
   */
  function beginScreenshotHide() {
    if (ssHideAt) return;
    ssHideAt = Date.now();
    screenshotClass(true);
    if (ssTimer) clearTimeout(ssTimer);
    ssTimer = setTimeout(endScreenshotHide, 15000);
    post('ss', { at: Date.now() });
  }

  function endScreenshotHide() {
    if (!ssHideAt) return;
    ssHideAt = 0;
    if (ssTimer) { clearTimeout(ssTimer); ssTimer = 0; }
    screenshotClass(false);
  }

  // --- `rc`: answer eval probes from real page values, never run the code ---
  const RC_BLOCKED_KEY = /^(?:constructor|__proto__|prototype|caller|callee|arguments|eval|Function|import|globalThis|process|require|module|exports)$/;

  function readPath(expr) {
    const parts = String(expr || '').split('.');
    if (!parts.length || parts.length > 6) return { ok: false };
    let value = window;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i];
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) return { ok: false };
      if (RC_BLOCKED_KEY.test(key)) return { ok: false };
      if (value == null) return { ok: false };
      try {
        value = value[key];
      } catch (e) {
        return { ok: false };
      }
    }
    return { ok: true, value };
  }

  function rcSerialize(value) {
    const t = typeof value;
    if (value === null || t === 'string' || t === 'boolean') return { ok: true, value };
    if (t === 'number') return { ok: true, value: isFinite(value) ? value : null };
    if (t === 'undefined') return { ok: true, value: null };
    if (Array.isArray(value)) {
      const head = value.slice(0, 30);
      const plain = head.every((v) => v === null ||
        typeof v === 'string' || typeof v === 'boolean' ||
        (typeof v === 'number' && isFinite(v)));
      return plain ? { ok: true, value: head } : { ok: true, value: null };
    }
    return { ok: true, value: null };
  }

  function parseLiteral(text) {
    const t = String(text || '').trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(t);
    if (quoted) return { ok: true, value: quoted[2] };
    if (/^-?\d+(?:\.\d+)?$/.test(t)) return { ok: true, value: Number(t) };
    if (t === 'true') return { ok: true, value: true };
    if (t === 'false') return { ok: true, value: false };
    if (t === 'null') return { ok: true, value: null };
    if (t === 'undefined') return { ok: true, value: undefined };
    return { ok: false };
  }

  /** A deliberately small expression grammar. Anything else is not answered. */
  function evalProbe(raw) {
    const code = String(raw == null ? '' : raw).trim();
    if (!code || code.length > 400) return { ok: false };

    let m = /^typeof\s+([\w$.]+)$/.exec(code);
    if (m) {
      const r = readPath(m[1]);
      return { ok: true, value: r.ok ? typeof r.value : 'undefined' };
    }

    m = /^(['"])([\w$.\- ]{1,80})\1\s+in\s+([\w$.]+)$/.exec(code);
    if (m) {
      const r = readPath(m[3]);
      if (!r.ok || r.value == null) return { ok: true, value: false };
      try {
        return { ok: true, value: m[2] in Object(r.value) };
      } catch (e) {
        return { ok: true, value: false };
      }
    }

    m = /^([\w$.]+)\.(includes|indexOf|startsWith|endsWith)\(\s*(['"])([^'"]{0,120})\3\s*\)$/.exec(code);
    if (m) {
      const r = readPath(m[1]);
      if (!r.ok || typeof r.value !== 'string') return { ok: false };
      const fn = r.value[m[2]];
      if (typeof fn !== 'function') return { ok: false };
      try {
        return { ok: true, value: fn.call(r.value, m[4]) };
      } catch (e) {
        return { ok: false };
      }
    }

    m = /^([\w$.]+)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/.exec(code);
    if (m) {
      const lit = parseLiteral(m[3]);
      if (!lit.ok) return { ok: false };
      const r = readPath(m[1]);
      if (!r.ok) return { ok: false };
      const a = r.value;
      const b = lit.value;
      let value;
      switch (m[2]) {
        case '===': value = a === b; break;
        case '!==': value = a !== b; break;
        case '==': value = a == b; break; // eslint-disable-line eqeqeq
        case '!=': value = a != b; break; // eslint-disable-line eqeqeq
        case '>=': value = a >= b; break;
        case '<=': value = a <= b; break;
        case '>': value = a > b; break;
        default: value = a < b; break;
      }
      return { ok: true, value: !!value };
    }

    m = /^([\w$.]+)\.length$/.exec(code);
    if (m) {
      const r = readPath(m[1]);
      if (!r.ok || r.value == null || typeof r.value.length !== 'number') return { ok: false };
      return { ok: true, value: r.value.length };
    }

    if (/^[\w$.]+$/.test(code)) {
      const r = readPath(code);
      if (!r.ok) return { ok: false };
      return rcSerialize(r.value);
    }

    return { ok: false };
  }

  function answerEval(ws, code) {
    let result = null;
    try {
      const out = evalProbe(code);
      result = out && out.ok ? out.value : null;
    } catch (e) {
      result = null;
    }
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ event: 'evalResult', result }));
      }
    } catch (e) {
      log('eval reply', e);
    }
    post('rc', { code: String(code == null ? '' : code).slice(0, 200), answered: true });
  }

  // --- moderation snapshot: neutral high-variance JPEG, byte 0x01 frames ----
  const NativeBlob = window.Blob;
  let neutralJpegCache = null;

  function neutralJpeg() {
    if (neutralJpegCache) return neutralJpegCache;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 225;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // Gradients and blocks give the frame real variance (the site's own
      // blank-camera check wants >= 45) without showing a person.
      const g = ctx.createLinearGradient(0, 0, 300, 225);
      g.addColorStop(0, '#1b2440');
      g.addColorStop(0.5, '#3d6b8e');
      g.addColorStop(1, '#c8b48a');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 300, 225);
      ctx.fillStyle = '#e8e4d8';
      ctx.fillRect(24, 96, 252, 34);
      ctx.fillStyle = '#0d1424';
      ctx.fillRect(24, 30, 56, 44);
      ctx.fillRect(220, 30, 56, 44);
      ctx.fillStyle = '#6ea8c8';
      ctx.fillRect(60, 160, 180, 40);
      const url = canvas.toDataURL('image/jpeg', 0.65);
      const comma = url.indexOf(',');
      if (comma === -1) return null;
      const bin = atob(url.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      neutralJpegCache = bytes;
      return bytes;
    } catch (e) {
      log('neutral jpeg', e);
      return null;
    }
  }

  function spoofsModeration() {
    return !!(state.enabled && state.moderationSpoof);
  }

  function isBlobLike(value) {
    return !!value && typeof value === 'object' &&
      typeof value.size === 'number' && typeof value.type === 'string' &&
      typeof value.arrayBuffer === 'function';
  }

  /**
   * `new Blob([Uint8Array([1]), jpeg])` is the webcam moderation snapshot.
   * Keep the leading tag byte and substitute a neutral picture.
   */
  function moderationParts(parts) {
    if (!Array.isArray(parts) || parts.length < 2) return null;
    const head = parts[0];
    if (!head || typeof head.length !== 'number' || head.length !== 1) return null;
    if (head[0] !== 1) return null;
    if (!isBlobLike(parts[1])) return null;
    const jpeg = neutralJpeg();
    if (!jpeg) return null;
    return [head, new NativeBlob([jpeg], { type: 'image/jpeg' })];
  }

  if (typeof NativeBlob === 'function') {
    const wrappedBlob = function (parts, options) {
      let next = parts;
      try {
        if (spoofsModeration()) {
          const replaced = moderationParts(parts);
          if (replaced) next = replaced;
        }
      } catch (e) { /* keep the page's parts */ }
      return new NativeBlob(next, options);
    };
    wrappedBlob.prototype = NativeBlob.prototype;
    window.Blob = nativeize(wrappedBlob, 'Blob', 0);
  }

  // -------------------------------------------------------------------------
  // 1c. Session tricks (multi-tab isolation, auto-next)
  // -------------------------------------------------------------------------
  function clearVisitorCookie() {
    try { document.cookie = 'user=; Max-Age=0; Path=/; Secure'; } catch (e) { /* ignore */ }
    try { document.cookie = 'user=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure'; } catch (e) { /* ignore */ }
    try { document.cookie = 'user=; Max-Age=0; Path=/'; } catch (e) { /* ignore */ }
  }

  const NativeBC = window.BroadcastChannel;
  const BC_TOKEN = Math.random().toString(36).slice(2, 10);
  if (typeof NativeBC === 'function') {
    const wrappedBC = function (name) {
      let real = name;
      try {
        if (state.enabled && state.multiTab && String(name) === 'tab') {
          real = 'tab#' + BC_TOKEN;
        }
      } catch (e) { /* keep the page's name */ }
      return new NativeBC(real);
    };
    wrappedBC.prototype = NativeBC.prototype;
    window.BroadcastChannel = nativeize(wrappedBC, 'BroadcastChannel', 1);
  }

  // `window.disabled` is the site's auto-next flag: it searches again after a
  // stranger leaves only while it is falsy. The accessor keeps it false
  // without the page noticing a periodic write.
  let autoNextOn = false;
  let autoNextInstalled = false;
  let siteDisabled = false;

  function applyAutoNext() {
    const want = !!(state.enabled && state.autoNext);
    if (!want) {
      autoNextOn = false;
      return;
    }
    autoNextOn = true;
    if (autoNextInstalled) return;
    let current = false;
    try {
      const desc = Object.getOwnPropertyDescriptor(window, 'disabled');
      if (desc && 'value' in desc) current = !!desc.value;
      else if (desc && typeof desc.get === 'function') current = !!desc.get.call(window);
    } catch (e) { /* ignore */ }
    try {
      Object.defineProperty(window, 'disabled', {
        configurable: true,
        enumerable: true,
        get() { return autoNextOn ? false : siteDisabled; },
        set(v) { siteDisabled = !!v; },
      });
      siteDisabled = current;
      autoNextInstalled = true;
    } catch (e) {
      autoNextInstalled = false;
    }
  }

  function applySessionSettings() {
    if (state.enabled && state.multiTab) clearVisitorCookie();
    applyAutoNext();
  }

  if (state.enabled && state.multiTab) clearVisitorCookie();
  applyAutoNext();

  function observeIncoming(data) {
    if (!state.enabled || typeof data !== 'string' || data.indexOf('"event"') === -1) return;
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || typeof msg.event !== 'string') return;

    switch (msg.event) {
      case 'conn': onConn(msg); break;
      case 'end': onEnd(msg); break;
      case 'throttle':
        post('throttle', { price: msg.price || '', at: Date.now() });
        break;
      case 'banned':
        post('banned', { reason: msg.reason || '', at: Date.now() });
        break;
      case 'vpnBlock':
        post('blocked', { kind: 'vpn', at: Date.now() });
        break;
      case 'newtab':
        post('othertab', { at: Date.now() });
        break;
      case 'vip_active':
      case 'premiumActive':
        post('vip', { active: true, seconds: Number(msg.seconds) || 0 });
        break;
      case 'premiumExpired':
      case 'ncm':
        post('vip', { active: false });
        break;
      case 'cm':
        post('moderator', {});
        break;
      case 'changeCountry':
        post('changeCountry', { name: msg.cName || '', code: msg.country || '' });
        break;
      default:
        break;
    }
  }

  function onConn(msg) {
    const at = Date.now();
    const seq = ++matchSeq;
    currentMatch = {
      seq,
      at,
      connected: true,
      accepted: false,
      sb: !!msg.sb,
      country: String(msg.country || '').toUpperCase(),
      countryName: String(msg.cName || ''),
      id: String(msg.connectionID || ''),
      ip: null,
      geoStarted: false,
    };

    // Candidates bundled in `conn` describe the same stranger.
    try {
      if (msg.offer && typeof msg.offer.sdp === 'string') noteSdp(msg.offer.sdp, at);
    } catch (e) { /* ignore */ }
    try {
      if (Array.isArray(msg.candidates)) msg.candidates.forEach((c) => noteRemoteCandidate(c, at));
    } catch (e) { /* ignore */ }

    post('conn', {
      seq,
      at,
      country: currentMatch.country,
      countryName: currentMatch.countryName,
      sb: currentMatch.sb,
      connectionID: currentMatch.id,
      interests: Array.isArray(msg.interests) ? msg.interests.slice(0, 8) : [],
    });

    // Late candidates after `conn` are common; keep looking for a few
    // seconds, but only for this match.
    [400, 900, 1600, 2600, 4200, 6500, 9000].forEach((delay) => {
      setTimeout(() => {
        try {
          if (currentMatch && currentMatch.seq === seq) maybeStartGeo();
        } catch (e) { /* ignore */ }
      }, delay);
    });
  }

  function onEnd(msg) {
    const seq = currentMatch ? currentMatch.seq : 0;
    post('end', {
      seq,
      flag: msg && msg.flag != null ? String(msg.flag) : '',
      at: Date.now(),
    });
    currentMatch = null;
  }

  // -------------------------------------------------------------------------
  // 2. Remote IP capture
  // -------------------------------------------------------------------------
  const recentIps = [];
  const GEO_WINDOW_MS = 12000;

  function isPublicIp(ip) {
    if (!ip || /\.local$/i.test(ip)) return false;
    if (ip.indexOf(':') === -1) {
      const p = ip.split('.').map(Number);
      if (p.length !== 4 || p.some((n) => !isFinite(n) || n < 0 || n > 255)) return false;
      if (p[0] === 10 || p[0] === 0 || p[0] === 127) return false;
      if (p[0] === 169 && p[1] === 254) return false;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
      if (p[0] === 192 && p[1] === 168) return false;
      if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
      if (p[0] >= 224) return false;
      return true;
    }
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return false;
    if (/^fe[89ab]/.test(l)) return false;
    if (/^f[cd]/.test(l)) return false;
    if (l.indexOf('::ffff:') === 0) return isPublicIp(l.slice(7));
    return true;
  }

  function candidateIp(value) {
    const text = typeof value === 'string'
      ? value
      : (value && typeof value.candidate === 'string' ? value.candidate : '');
    if (!text || text.indexOf('candidate:') === -1) return null;
    const m = /candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+(\S+)/i.exec(text);
    if (!m) return null;
    const type = m[2].toLowerCase();
    if (type !== 'srflx' && type !== 'prflx') return null;
    return isPublicIp(m[1]) ? m[1] : null;
  }

  function noteRemoteCandidate(value, when) {
    if (!state.enabled) return;
    const ip = candidateIp(value);
    if (!ip) return;

    const t = when || Date.now();
    const last = recentIps[recentIps.length - 1];
    if (!last || last.ip !== ip) {
      recentIps.push({ ip, t });
      while (recentIps.length > 40) recentIps.shift();
    }

    post('ice', { ip, at: t, seq: currentMatch ? currentMatch.seq : 0 });
    if (currentMatch && currentMatch.accepted && !currentMatch.ip) maybeStartGeo();
  }

  function noteSdp(sdp, when) {
    if (typeof sdp !== 'string' || !sdp) return;
    sdp.split(/\r?\n/).forEach((line) => {
      const at = line.indexOf('a=candidate:');
      if (at !== -1) noteRemoteCandidate(line.slice(at + 2), when);
    });
  }

  // -------------------------------------------------------------------------
  // 3. City / ISP guess (page world, so the page's CORS rules apply and the
  //    extension does not need a permission for the geo API)
  // -------------------------------------------------------------------------
  const geoCache = new Map();
  const GEO_TTL_MS = 6 * 3600 * 1000;

  function abortAfter(ms) {
    if (typeof AbortController === 'undefined') return { signal: undefined, done: () => {} };
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, ms);
    return { signal: ctrl.signal, done: () => clearTimeout(timer) };
  }

  // Providers are tried in order. ipwho.is rate-limits requests that carry an
  // Origin header (HTTP 429), i.e. every browser fetch, so it is last.
  function cleanIsp(value) {
    return String(value || '').replace(/^AS\d+\s+/i, '').trim();
  }

  const GEO_PROVIDERS = [
    {
      url: (ip) => 'https://ipinfo.io/' + encodeURIComponent(ip) + '/json',
      parse: (j) => (j && !j.error ? {
        city: j.city,
        region: j.region,
        isp: j.org,
        tz: j.timezone,
      } : null),
    },
    {
      url: (ip) => 'https://ipapi.co/' + encodeURIComponent(ip) + '/json/',
      parse: (j) => (j && !j.error ? {
        city: j.city,
        region: j.region,
        isp: j.org,
        tz: j.timezone,
      } : null),
    },
    {
      url: (ip) => 'https://ipwho.is/' + encodeURIComponent(ip) +
        '?fields=success,country,country_code,region,city,connection,timezone',
      parse: (j) => (j && j.success !== false ? {
        city: j.city,
        region: j.region,
        isp: (j.connection && (j.connection.isp || j.connection.org)) || j.isp || j.org,
        tz: (j.timezone && j.timezone.id) || (typeof j.timezone === 'string' ? j.timezone : ''),
      } : null),
    },
  ];

  async function fetchGeo(ip) {
    for (let i = 0; i < GEO_PROVIDERS.length; i++) {
      const provider = GEO_PROVIDERS[i];
      const gate = abortAfter(6000);
      try {
        const res = await fetch(provider.url(ip), {
          signal: gate.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = provider.parse(await res.json());
        if (!data || (!data.city && !data.region)) continue;
        data.isp = cleanIsp(data.isp);
        data.tz = String(data.tz || '').trim();
        return data;
      } catch (e) {
        log('geo lookup failed', provider.url(ip), e && e.message);
      } finally {
        gate.done();
      }
    }
    return null;
  }

  async function geoLookup(ip) {
    const hit = geoCache.get(ip);
    if (hit && Date.now() - hit.at < GEO_TTL_MS) return hit.data;
    const data = await fetchGeo(ip);
    geoCache.set(ip, { at: Date.now(), data });
    return data;
  }

  function localTime(tz) {
    if (!tz) return '';
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: tz,
      }).format(new Date());
    } catch (e) {
      return '';
    }
  }

  function geoText(g) {
    if (!g) return '';
    const parts = [];
    if (g.city && g.region && g.city !== g.region) parts.push(g.city + ', ' + g.region);
    else if (g.city || g.region) parts.push(g.city || g.region);
    if (g.isp) parts.push(g.isp);
    const time = localTime(g.tz);
    if (time) parts.push(time + ' there');
    return parts.join('  \u00B7  ');
  }

  function maybeStartGeo() {
    if (!state.enabled || !state.cityLookup) return;
    if (!currentMatch || !currentMatch.accepted || currentMatch.geoStarted) return;

    const now = Date.now();
    const minT = currentMatch.at - 1500;
    for (let i = recentIps.length - 1; i >= 0; i--) {
      const entry = recentIps[i];
      if (entry.t < minT) continue;
      if (now - entry.t <= GEO_WINDOW_MS) {
        startGeoLookup(entry.ip, currentMatch.seq);
        return;
      }
    }
  }

  async function startGeoLookup(ip, seq) {
    if (!currentMatch || currentMatch.seq !== seq || currentMatch.ip) return;
    currentMatch.ip = ip;
    currentMatch.geoStarted = true;
    post('geo', { seq, ip, pending: true, text: '' });

    const data = await geoLookup(ip);
    if (!currentMatch || currentMatch.seq !== seq) return;
    post('geo', { seq, ip, pending: false, text: data ? geoText(data) : '' });
  }

  // -------------------------------------------------------------------------
  // Own public IP (ban gate in the bridge; fetched only on request)
  // -------------------------------------------------------------------------
  let ownIpBusy = false;
  let ownIpLast = { ip: '', at: 0 };
  const OWN_IP_TTL_MS = 60000;

  const OWN_IP_PROVIDERS = [
    {
      url: 'https://api.ipify.org?format=json',
      parse: (j) => (j && j.ip ? j.ip : ''),
    },
    {
      url: 'https://ipinfo.io/json',
      parse: (j) => (j && !j.error && j.ip ? j.ip : ''),
    },
    {
      // Last: rejects browser fetches with 429 (see GEO_PROVIDERS).
      url: 'https://ipwho.is/?fields=success,ip',
      parse: (j) => (j && j.success !== false && j.ip ? j.ip : ''),
    },
  ];

  async function fetchOwnIp(force) {
    const now = Date.now();
    if (ownIpBusy) return;
    if (!force && ownIpLast.ip && now - ownIpLast.at < OWN_IP_TTL_MS) {
      post('publicIp', { ip: ownIpLast.ip, at: ownIpLast.at });
      return;
    }
    ownIpBusy = true;
    let ip = '';

    for (let i = 0; i < OWN_IP_PROVIDERS.length && !ip; i++) {
      const provider = OWN_IP_PROVIDERS[i];
      const gate = abortAfter(6000);
      try {
        const res = await fetch(provider.url, {
          signal: gate.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
        });
        if (res.ok) ip = String(provider.parse(await res.json()) || '');
      } catch (e) { /* try the next provider */ } finally {
        gate.done();
      }
    }

    ownIpBusy = false;
    ownIpLast = { ip, at: Date.now() };
    post('publicIp', { ip, at: ownIpLast.at });
  }

  // -------------------------------------------------------------------------
  // 4. RTCPeerConnection: IP capture + connection HUD
  // -------------------------------------------------------------------------
  const pcs = new Set();
  const pcPrev = new WeakMap();
  let lastNetAt = 0;
  let lastNetState = 'idle';
  let netBusy = false;

  const NativePC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (NativePC) {
    const WrappedPC = function (config) {
      let cfg = config;
      try {
        if (state.enabled && state.relayOnly) {
          cfg = Object.assign({}, config && typeof config === 'object' ? config : {},
            { iceTransportPolicy: 'relay' });
        }
      } catch (e) { /* use the page's config */ }
      const pc = cfg === undefined ? new NativePC() : new NativePC(cfg);
      pcs.add(pc);
      try {
        pc.addEventListener('connectionstatechange', () => {
          if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
            pcs.delete(pc);
          }
        });
      } catch (e) { /* ignore */ }
      return pc;
    };
    WrappedPC.prototype = NativePC.prototype;
    window.RTCPeerConnection = nativeize(WrappedPC, 'RTCPeerConnection', 0);

    const proto = NativePC.prototype;
    const origAdd = proto.addIceCandidate;
    if (typeof origAdd === 'function') {
      proto.addIceCandidate = nativeize(function addIceCandidate(candidate) {
        try { noteRemoteCandidate(candidate); } catch (e) { /* ignore */ }
        return origAdd.apply(this, arguments);
      }, 'addIceCandidate', 1);
    }
    const origSetRemote = proto.setRemoteDescription;
    if (typeof origSetRemote === 'function') {
      proto.setRemoteDescription = nativeize(function setRemoteDescription(description) {
        try {
          if (description && typeof description.sdp === 'string') noteSdp(description.sdp);
        } catch (e) { /* ignore */ }
        return origSetRemote.apply(this, arguments);
      }, 'setRemoteDescription', 1);
    }
  }

  function pickPc() {
    let connecting = null;
    for (const pc of pcs) {
      const s = pc.connectionState;
      if (s === 'connected') return pc;
      if (!connecting && (s === 'connecting' || s === 'new')) connecting = pc;
    }
    return connecting;
  }

  function readNum(obj, key) {
    const v = obj && obj[key];
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  async function pollNet() {
    if (netBusy) return;
    if (!state.enabled || !state.hud) {
      if (lastNetState !== 'idle') {
        lastNetState = 'idle';
        post('net', { state: 'idle', at: Date.now() });
      }
      return;
    }
    if (document.visibilityState !== 'visible') return;

    const pc = pickPc();
    if (!pc) {
      if (lastNetState !== 'idle') {
        lastNetState = 'idle';
        post('net', { state: 'idle', at: Date.now() });
      }
      return;
    }

    netBusy = true;
    try {
      const stats = await pc.getStats();
      const byId = new Map();
      stats.forEach((r) => { if (r && r.id) byId.set(r.id, r); });

      let vin = null;
      let vout = null;
      let pair = null;
      stats.forEach((r) => {
        if (!r) return;
        if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) vin = r;
        if (r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) vout = r;
        if (r.type === 'candidate-pair' && (r.state === 'succeeded' || r.state === 'in-progress')) {
          if (!pair || r.selected || r.nominated) pair = r;
        }
      });

      const local = pair ? byId.get(pair.localCandidateId) : null;
      const remote = pair ? byId.get(pair.remoteCandidateId) : null;
      const mode = (local && local.candidateType === 'relay') ||
        (remote && remote.candidateType === 'relay') ? 'relay' : 'p2p';

      const bytes = readNum(vin, 'bytesReceived');
      const frames = readNum(vin, 'framesDecoded');
      const outBytes = readNum(vout, 'bytesSent');
      const now = Date.now();
      const prev = pcPrev.get(pc) || {
        bytes, frames, outBytes, at: now, kbps: 0, fps: 0, outKbps: 0,
      };
      const dt = Math.max(0.2, (now - prev.at) / 1000);

      let kbps = prev.kbps || 0;
      let fps = prev.fps || 0;
      let outKbps = prev.outKbps || 0;
      if (now - prev.at >= 200) {
        kbps = Math.max(0, Math.round(((bytes - prev.bytes) * 8) / 1000 / dt));
        fps = Math.max(0, Math.round(((frames - prev.frames) / dt) * 10) / 10);
        if (outBytes >= (prev.outBytes || 0)) {
          outKbps = Math.max(0, Math.round(((outBytes - prev.outBytes) * 8) / 1000 / dt));
        } else {
          outKbps = 0;
        }
      }
      // Always store the raw counters: without them the next sample has no
      // baseline and the bitrate would stay 0 for the whole call.
      pcPrev.set(pc, { bytes, frames, outBytes, at: now, kbps, fps, outKbps });

      const stateName = pc.connectionState || 'connected';
      const out = {
        state: stateName,
        mode,
        width: readNum(vin, 'frameWidth'),
        height: readNum(vin, 'frameHeight'),
        fps: readNum(vin, 'framesPerSecond') || fps,
        kbps,
        outKbps,
        rtt: pair && typeof pair.currentRoundTripTime === 'number'
          ? Math.round(pair.currentRoundTripTime * 1000) : 0,
        bytes,
        outBytes,
        localType: local ? local.candidateType || '' : '',
        remoteType: remote ? remote.candidateType || '' : '',
        at: now,
      };

      lastNetState = stateName;
      if (now - lastNetAt >= 900) {
        lastNetAt = now;
        post('net', out);
      }
    } catch (e) {
      log('getStats failed', e && e.message);
    } finally {
      netBusy = false;
    }
  }

  setInterval(() => { pollNet(); }, 1000);

  // -------------------------------------------------------------------------
  // 5. Face check removal
  // -------------------------------------------------------------------------
  const NativeWorker = window.Worker;

  function visionStubSource() {
    return [
      'self.onmessage = function (e) {',
      '  var d = e.data || {};',
      '  if (d.action === "loadFaceDetector") {',
      '    self.postMessage({ action: "faceDetectorLoaded", numFaces: 1 });',
      '    return;',
      '  }',
      '  if (d.action === "detectFaces") {',
      '    var job = Number(d.job_id) || 0;',
      '    var k = Math.imul(job * 10 + 1, 837921547) >>> 0;',
      '    self.postMessage({ action: "f_res", k: k });',
      '    return;',
      '  }',
      '  self.postMessage({ action: "error", error: "unsupported action" });',
      '};',
    ].join('\n');
  }

  function makeVisionStub() {
    const blob = new Blob([visionStubSource()], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    return new NativeWorker(url);
  }

  if (typeof NativeWorker === 'function') {
    const WrappedWorker = function (url, options) {
      try {
        if (state.enabled && state.faceStub &&
            typeof url === 'string' && /\/static\/vision\.js(?:\?|$)/i.test(url)) {
          return makeVisionStub();
        }
      } catch (e) { /* fall through to the real worker */ }
      return options === undefined
        ? new NativeWorker(url)
        : new NativeWorker(url, options);
    };
    WrappedWorker.prototype = NativeWorker.prototype;
    window.Worker = nativeize(WrappedWorker, 'Worker', 1);
  }

  // -------------------------------------------------------------------------
  // 6. Virtual camera labels
  // -------------------------------------------------------------------------
  const VIRTUAL_CAMERA_RE = /(obs[\s_-]*camera|virtual|manycam|droidcam|snap\s*camera|xsplit\b|vcam\b|epoccam|iriun|\bndi\b|unity\s*capture|streamlabs|e2esoft|youcam|camtwist|splitcam|webcamoid|altercam|chromacam|screen\s*capture|fake\s*camera|dummy\s*camera)/i;

  function physicalCameraLabel() {
    const plat = (navigator.userAgentData && navigator.userAgentData.platform)
      || navigator.platform || '';
    if (/mac/i.test(plat)) return 'FaceTime HD Camera';
    if (/linux/i.test(plat)) return 'Integrated Webcam (0bda:5520)';
    return 'Integrated Camera (04f2:b6dd)';
  }

  function mapCameraLabel(label, kind) {
    if (!state.enabled || !state.cameraSpoof) return label;
    if (typeof label !== 'string' || !label) return label;
    if (kind && kind !== 'videoinput' && kind !== 'video') return label;
    if (!VIRTUAL_CAMERA_RE.test(label)) return label;
    return physicalCameraLabel();
  }

  function captureGetter(objectName, prop, kindOf) {
    const Ctor = window[objectName];
    if (!Ctor || !Ctor.prototype) return;
    let desc;
    try { desc = Object.getOwnPropertyDescriptor(Ctor.prototype, prop); } catch (e) { return; }
    if (!desc || typeof desc.get !== 'function' || !desc.configurable) return;

    const original = desc.get;
    const replacement = function () {
      let label;
      try { label = original.call(this); } catch (e) { return original.call(this); }
      let kind = '';
      try { kind = kindOf(this); } catch (e) { kind = ''; }
      try { return mapCameraLabel(label, kind); } catch (e) { return label; }
    };
    try {
      Object.defineProperty(Ctor.prototype, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: nativeize(replacement, 'get ' + prop, 0),
      });
    } catch (e) { /* leave the browser alone if it refuses */ }
  }

  captureGetter('MediaDeviceInfo', 'label', (o) => {
    try { return o.kind; } catch (e) { return ''; }
  });
  captureGetter('MediaStreamTrack', 'label', (o) => {
    try { return o.kind; } catch (e) { return ''; }
  });

  /* UTK_TEST_SEAM_START */
  if (TEST_HOOK) {
    // Harness-only seam; TEST_HOOK is false on umingle.com.
    try {
      window.__umingTest = {
        mapCameraLabel,
        geoText,
        isPublicIp,
        candidateIp,
        state,
        evalProbe,
        readPath,
        neutralJpeg,
        moderationParts,
        spoofsModeration,
        beginScreenshotHide,
        endScreenshotHide,
        clearVisitorCookie,
        applySessionSettings,
        nativeize,
      };
    } catch (e) { /* ignore */ }
  }
  /* UTK_TEST_SEAM_END */

  // Tell the bridge this world is ready. If the bridge loaded first it will
  // answer with a settings message, which triggers another hello.
  post('hello', { version: VERSION, ready: true });
})();
