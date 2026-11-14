/*
 * Umingle Toolkit - popup logic.
 */
(function () {
  'use strict';

  const U = globalThis.UMINGLE;
  if (!U) return;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let settings = U.mergeSettings({});
  let toastTimer = 0;
  let regionNames = null;
  try {
    regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch (e) { regionNames = null; }

  function load() {
    chrome.storage.sync.get(U.SETTINGS_KEY, (res) => {
      settings = U.mergeSettings(res && res[U.SETTINGS_KEY]);
      renderSettings();
      renderStats();
    });
  }

  function save(patch) {
    settings = U.mergeSettings(Object.assign({}, settings, patch));
    const payload = {};
    payload[U.SETTINGS_KEY] = settings;
    chrome.storage.sync.set(payload);
    renderSettings();
  }

  function showToast(text) {
    const el = $('#popupToast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // =========================================================================
  // Updates
  // =========================================================================
  function renderUpdate(info) {
    const note = $('#updateNote');
    if (!note) return;
    const on = !!(info && info.available && info.latest);
    note.classList.toggle('show', on);
    if (!on) return;
    $('#updateVersion').textContent = 'v' + info.latest;
    $('#updateLink').href = info.url || 'https://github.com/alunit3/umingle-toolkit/releases/latest';
  }

  function loadUpdate() {
    chrome.storage.local.get('updateInfo', (res) => {
      if (res && res.updateInfo) renderUpdate(res.updateInfo);
    });
    chrome.runtime.sendMessage({ type: 'utk-check-update' }, (info) => {
      if (chrome.runtime.lastError) return;
      if (info) renderUpdate(info);
    });
  }

  // =========================================================================
  // Settings rendering
  // =========================================================================
  function renderSettings() {
    $('#version').textContent = chrome.runtime.getManifest().version;
    $('#enabled').checked = !!settings.enabled;
    $('#powerWord').textContent = settings.enabled ? 'On' : 'Off';
    document.body.classList.toggle('is-off', !settings.enabled);

    $$('.toggle[data-key]').forEach((input) => {
      const key = input.getAttribute('data-key');
      input.checked = !!settings[key];
    });

    const stall = $('#stallSeconds');
    if (stall) stall.value = String(settings.stallSeconds);

    const blocked = $('#blockCountries');
    if (blocked) blocked.value = (settings.blockCountries || []).join(', ');
    const greet = $('#greetText');
    if (greet) greet.value = settings.greetText || '';

    $$('#selfViewSeg button').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-selfview') === settings.selfView);
    });
    $$('#boostSeg button').forEach((b) => {
      b.classList.toggle('on', Number(b.getAttribute('data-boost')) === Number(settings.volumeBoost));
    });

    renderFilter();
    renderBands();
  }

  /* Each band reports how much of itself is armed. */
  function renderBands() {
    $$('.band').forEach((band) => {
      const out = band.querySelector('.band-count');
      if (!out) return;
      const toggles = Array.from(band.querySelectorAll('.band-body .toggle[data-key]'));
      if (!toggles.length) { out.textContent = ''; return; }
      const on = toggles.filter((t) => t.checked).length;
      out.textContent = on + '/' + toggles.length;
      out.title = on + ' of ' + toggles.length + ' on';
    });
    const blocked = (settings.blockCountries || []).filter(Boolean);
    const blockedEl = $('#readoutBlocked');
    if (blockedEl) {
      blockedEl.textContent = String(blocked.length);
      blockedEl.title = blocked.length ? blocked.join(', ') : 'No blocked countries';
    }
    const filterEl = $('#readoutFilter');
    if (filterEl) {
      const list = (settings.filterCountries || []).filter(Boolean);
      filterEl.textContent = list.length
        ? list.slice(0, 2).join(' · ') + (list.length > 2 ? ' +' + (list.length - 2) : '')
        : (settings.autoSkip ? 'Any' : 'Off');
      filterEl.title = filterEl.textContent + ' — open the band to change it';
    }
  }

  function renderIps() {
    const el = $('#ipCount');
    if (!el) return;
    chrome.storage.local.get('strangerIps', (res) => {
      const book = res && res.strangerIps;
      const ips = book && book.ips && typeof book.ips === 'object' ? Object.keys(book.ips) : [];
      el.textContent = String(ips.length);
    });
  }

  function renderFilter() {
    const el = $('#filterSummary');
    if (!el) return;
    const list = (settings.filterCountries || []).filter(Boolean);
    if (!list.length) {
      el.textContent = settings.autoSkip ? 'Any country (no filter selected)' : 'Filter off';
      return;
    }
    const names = list.slice(0, 3).map((code) => {
      try {
        return regionNames ? regionNames.of(code) : code;
      } catch (e) {
        return code;
      }
    });
    el.textContent = names.join(', ') + (list.length > 3 ? ' +' + (list.length - 3) : '');
  }

  // =========================================================================
  // Stats
  // =========================================================================
  function dayKey() {
    const t = new Date();
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }

  function fmtWait(ms) {
    if (!ms || !isFinite(ms) || ms <= 0) return '\u2014';
    const s = ms / 1000;
    return (s >= 10 ? Math.round(s) : Math.round(s * 10) / 10) + 's';
  }

  function fmtTalk(ms) {
    if (!ms || !isFinite(ms) || ms <= 0) return '\u2014';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm';
    return total + 's';
  }

  function flagOf(code) {
    const c = String(code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) return '\uD83C\uDF10';
    try {
      return String.fromCodePoint.apply(null, c.split('').map((ch) => 127397 + ch.charCodeAt(0)));
    } catch (e) {
      return '\uD83C\uDF10';
    }
  }

  function countryName(code) {
    const c = String(code || '').toUpperCase();
    try {
      if (regionNames) return regionNames.of(c);
    } catch (e) { /* fall through */ }
    return c;
  }

  function renderStats() {
    const date = new Date();
    try {
      $('#statDate').textContent = date.toLocaleDateString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short',
      });
    } catch (e) { $('#statDate').textContent = dayKey(); }

    chrome.storage.local.get('stats', (res) => {
      const stats = res && res.stats && res.stats.days ? res.stats : { days: {} };
      const day = stats.days[dayKey()] || {};

      $('#statMatches').textContent = String(day.matches || 0);
      const readoutMatches = $('#readoutMatches');
      if (readoutMatches) readoutMatches.textContent = String(day.matches || 0);
      $('#statSkips').textContent = String(day.skips || 0);
      $('#statSb').textContent = String(day.sb || 0);
      $('#statThrottles').textContent = String(day.throttles || 0);
      $('#statWait').textContent = fmtWait(day.throttles ? (day.waitMs || 0) / day.throttles : 0);
      $('#statTalk').textContent = fmtTalk(day.talkMs || 0);

      const host = $('#statCountries');
      host.textContent = '';
      const entries = Object.keys(day.countries || {})
        .map((code) => ({ code, n: Number(day.countries[code].n) || 0, name: day.countries[code].name || '' }))
        .filter((e) => e.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, 8);

      if (!entries.length) {
        const chip = document.createElement('span');
        chip.className = 'chip empty';
        chip.textContent = 'No matches recorded yet';
        host.appendChild(chip);
        return;
      }
      entries.forEach((entry) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = flagOf(entry.code) + ' ' + countryName(entry.code) + ' \u00B7 ' + entry.n;
        chip.title = entry.name || countryName(entry.code);
        host.appendChild(chip);
      });
    });
  }

  // =========================================================================
  // Events
  // =========================================================================
  /* The power word and the off note already report this; no toast needed. */
  $('#enabled').addEventListener('change', (ev) => {
    save({ enabled: ev.target.checked });
  });

  /* The readout cells open the band they report on. */
  $$('.readout-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const band = document.getElementById(cell.getAttribute('data-goto'));
      if (!band) return;
      band.open = true;
      band.scrollIntoView({ block: 'start' });
    });
  });

  $$('.toggle[data-key]').forEach((input) => {
    if (input.id === 'enabled') return;
    input.addEventListener('change', () => {
      const patch = {};
      patch[input.getAttribute('data-key')] = input.checked;
      save(patch);
    });
  });

  $('#stallSeconds').addEventListener('change', (ev) => {
    let n = Number(ev.target.value);
    if (!isFinite(n)) n = 10;
    n = Math.max(4, Math.min(120, Math.round(n)));
    ev.target.value = String(n);
    save({ stallSeconds: n });
  });

  function parseCountries(text) {
    const codes = String(text || '').toUpperCase().split(/[^A-Z]+/).filter((c) => c.length === 2);
    return codes.filter((c, i) => codes.indexOf(c) === i);
  }

  $('#blockCountries').addEventListener('change', (ev) => {
    const list = parseCountries(ev.target.value);
    ev.target.value = list.join(', ');
    save({ blockCountries: list });
    showToast(list.length ? 'Blocked ' + list.join(', ') : 'Block list cleared');
  });

  $('#greetText').addEventListener('change', (ev) => {
    const text = String(ev.target.value || '').trim().slice(0, 160);
    ev.target.value = text;
    save({ greetText: text });
  });

  $$('#selfViewSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      save({ selfView: b.getAttribute('data-selfview') });
      showToast('Self view saved');
    });
  });

  $$('#boostSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      save({ volumeBoost: Number(b.getAttribute('data-boost')) });
      showToast('Volume boost saved');
    });
  });

  $('#clearIps').addEventListener('click', () => {
    chrome.storage.local.remove('strangerIps', () => {
      renderIps();
      showToast('Stranger IP memory cleared');
    });
  });

  $('#resetStats').addEventListener('click', () => {
    chrome.storage.local.set({ stats: { days: {} } }, () => {
      renderStats();
      showToast('Statistics cleared');
    });
  });

  $('#newIdentity').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) { showToast('No active tab'); return; }
      chrome.tabs.sendMessage(tab.id, { utk: 'identity' }, (res) => {
        if (chrome.runtime.lastError || !res) {
          showToast('Open the Umingle video page first');
          return;
        }
        if (!res.ok) {
          showToast('Same banned IP \u2014 change it first');
          return;
        }
        showToast('New identity \u2014 reloading');
        setTimeout(() => window.close(), 600);
      });
    });
  });

  $('#resetSettings').addEventListener('click', () => {
    settings = U.mergeSettings({});
    const payload = {};
    payload[U.SETTINGS_KEY] = settings;
    chrome.storage.sync.set(payload, () => {
      renderSettings();
      showToast('Settings reset');
    });
  });

  $('#checkUpdate').addEventListener('click', () => {
    const btn = $('#checkUpdate');
    btn.disabled = true;
    chrome.runtime.sendMessage({ type: 'utk-check-update', force: true }, (info) => {
      btn.disabled = false;
      if (chrome.runtime.lastError || !info) {
        showToast('Could not check for updates');
        return;
      }
      renderUpdate(info);
      if (info.error) showToast('Could not check for updates');
      else if (info.available) showToast('v' + info.latest + ' is available');
      else showToast('You are up to date');
    });
  });

  $('#updateLink').addEventListener('click', (ev) => {
    ev.preventDefault();
    chrome.tabs.create({ url: $('#updateLink').href });
    window.close();
  });

  function openUmingle(ev) {
    if (ev) ev.preventDefault();
    chrome.tabs.create({ url: 'https://umingle.com/video/' });
    window.close();
  }

  $('#openUmingle').addEventListener('click', openUmingle);
  $('#openFilter').addEventListener('click', openUmingle);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[U.SETTINGS_KEY]) {
      settings = U.mergeSettings(changes[U.SETTINGS_KEY].newValue);
      renderSettings();
    }
    if (area === 'local' && changes.stats) renderStats();
    if (area === 'local' && changes.strangerIps) renderIps();
    if (area === 'local' && changes.updateInfo) renderUpdate(changes.updateInfo.newValue);
  });

  load();
  renderIps();
  loadUpdate();
})();
