/*
 * Umingle Toolkit - service worker.
 *
 * Keeps the shared settings object present, answers the popup ping and
 * checks GitHub for a newer release. All feature code runs in the page.
 */
importScripts('defaults.js');

const U = self.UMINGLE;

const REPO = 'alunit3/umingle-toolkit';
const UPDATE_KEY = 'updateInfo';
const UPDATE_ALARM = 'utk-update';
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const UPDATE_RETRY_MS = 30 * 60 * 1000;

async function ensureSettings() {
  try {
    const got = await chrome.storage.sync.get(U.SETTINGS_KEY);
    if (!got || !got[U.SETTINGS_KEY]) {
      const payload = {};
      payload[U.SETTINGS_KEY] = U.mergeSettings({});
      await chrome.storage.sync.set(payload);
    }
  } catch (e) { /* storage unavailable during shutdown */ }
}

function newerVersion(latest, current) {
  const parse = (v) => String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function paintBadge(info) {
  const on = !!(info && info.available);
  chrome.action.setBadgeText({ text: on ? '1' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#5b34d6' }).catch(() => {});
  chrome.action.setTitle({ title: on ? 'Umingle Toolkit - update available' : 'Umingle Toolkit' }).catch(() => {});
}

/* Stores {latest, current, available, url, checkedAt, error} in local storage. */
async function checkUpdate(force) {
  const now = Date.now();
  let prev = null;
  try {
    const got = await chrome.storage.local.get(UPDATE_KEY);
    prev = (got && got[UPDATE_KEY]) || null;
  } catch (e) { /* ignore */ }

  const wait = prev && prev.error ? UPDATE_RETRY_MS : UPDATE_EVERY_MS;
  if (!force && prev && now - Number(prev.checkedAt || 0) < wait) {
    paintBadge(prev);
    return prev;
  }

  const current = chrome.runtime.getManifest().version;
  let next;
  try {
    const res = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    if (!latest) throw new Error('no release tag');
    next = {
      latest,
      current,
      available: newerVersion(latest, current),
      url: rel.html_url || 'https://github.com/' + REPO + '/releases/latest',
      checkedAt: now,
      error: '',
    };
  } catch (e) {
    next = Object.assign({}, prev || {}, {
      current,
      checkedAt: now,
      error: String((e && e.message) || e || 'check failed'),
    });
  }

  try {
    await chrome.storage.local.set({ [UPDATE_KEY]: next });
  } catch (e) { /* ignore */ }
  paintBadge(next);
  return next;
}

function ensureAlarm() {
  try {
    chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 6 * 60 });
  } catch (e) { /* ignore */ }
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureSettings();
  ensureAlarm();
  checkUpdate(false);
  if (details && details.reason === 'install') {
    chrome.storage.local.set({ installedAt: Date.now() }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureSettings();
  ensureAlarm();
  checkUpdate(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === UPDATE_ALARM) checkUpdate(true);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'utk-check-update') {
    checkUpdate(!!msg.force).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.type !== 'utk-ping') return false;
  sendResponse({
    ok: true,
    version: chrome.runtime.getManifest().version,
    tab: sender && sender.tab ? sender.tab.id : null,
  });
  return true;
});
