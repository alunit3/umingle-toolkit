"""Offline end-to-end test for the Umingle Toolkit Chrome extension.

Loads `test/.build` (a copy with `TEST_HOOK = true`) into the
bundled Chromium, serves a site-shaped harness page for
https://umingle.com/video/ and drives the page's real WebSocket through
Playwright's route_web_socket().

Covers: injection, Premium skin, stranger-IP memory and the ban gate, country
filter save/restore and auto-skip, throttle hide/restore, city line, connection
HUD, shadowban banner, stats, popup settings/stats, toolbar, hotkeys, leave
guard, face stub, camera labels and stall auto-skip.
"""
import base64
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "test" / ".build"
HARNESS = (ROOT / "test" / "ext_harness.html").read_text(encoding="utf-8")


def _local_chrome():
    """A Playwright Chromium already on disk (any version), or None."""
    bases = [Path(os.environ.get("LOCALAPPDATA") or "") / "ms-playwright",
             Path.home() / ".cache" / "ms-playwright"]
    hits = []
    for base in bases:
        if not base.is_dir():
            continue
        for pattern in ("chromium-*/chrome-win64/chrome.exe",
                        "chromium-*/chrome-linux*/chrome",
                        "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"):
            hits += list(base.glob(pattern))
    return max(hits, key=lambda p: p.stat().st_mtime) if hits else None


CHROME = Path(os.environ["UMINGLE_TEST_CHROME"]) if os.environ.get("UMINGLE_TEST_CHROME") else _local_chrome()
LAUNCH = {"executable_path": str(CHROME)} if CHROME and CHROME.is_file() else {}

GEO = {
    "success": True,
    "country": "Indonesia",
    "country_code": "ID",
    "region": "Jakarta",
    "city": "Jakarta",
    "connection": {"isp": "PT Contoh Nusantara", "org": "PT Contoh Nusantara"},
    "timezone": {"id": "Asia/Jakarta"},
}

# The browser's own public IP (ban gate). Tests change it in place.
OWN = {"ip": "203.0.113.10"}

CHECKS = []
FAILS = []


def check(name, ok, detail=""):
    ok = bool(ok)
    CHECKS.append({"name": name, "ok": ok, "detail": str(detail)[:400]})
    if not ok:
        FAILS.append(name + (" :: " + str(detail)[:300] if detail else ""))
    print(("PASS  " if ok else "FAIL  ") + name + ((" :: " + str(detail)[:200]) if detail and not ok else ""))


def poll(fn, timeout=6.0, interval=0.12):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:
            last = "error: " + str(e)
        time.sleep(interval)
    return last


class Harness:
    def __init__(self, ctx, name="p"):
        self.ctx = ctx
        self.page = ctx.new_page()
        self.page.on("pageerror", lambda e: PAGE_ERRORS.append(f"{name}: {e}"))
        self.sockets = []
        self.messages = []
        self.page.route("https://umingle.com/video/", self._serve)
        self.page.route("https://umingle.com/video", self._serve)
        self.page.route("https://ipwho.is/**", self._geo)
        self.page.route("https://ipwhois.app/**", self._geo)
        self.page.route("https://ipinfo.io/**", self._ipinfo)
        self.page.route("https://ipapi.co/**", self._ipapi)
        self.page.route("https://api.ipify.org/**", self._ipify)
        self.page.route_web_socket("wss://umingle.com/ws?video", self._on_ws)
        self.goto()

    def _serve(self, route):
        route.fulfill(status=200, content_type="text/html; charset=utf-8", body=HARNESS)

    def _geo(self, route):
        url = route.request.url
        body = {"success": True, "ip": OWN["ip"]} if "fields=success,ip" in url else GEO
        route.fulfill(
            status=200,
            content_type="application/json",
            headers={"access-control-allow-origin": "https://umingle.com"},
            body=json.dumps(body),
        )

    def _ipinfo(self, route):
        body = {
            "ip": OWN["ip"], "city": GEO["city"], "region": GEO["region"],
            "country": GEO["country_code"], "org": GEO["connection"]["isp"],
            "timezone": GEO["timezone"]["id"],
        }
        route.fulfill(
            status=200,
            content_type="application/json",
            headers={"access-control-allow-origin": "https://umingle.com"},
            body=json.dumps(body),
        )

    def _ipapi(self, route):
        body = {
            "ip": OWN["ip"], "city": GEO["city"], "region": GEO["region"],
            "country_name": GEO["country"], "country_code": GEO["country_code"],
            "org": GEO["connection"]["isp"], "timezone": GEO["timezone"]["id"],
        }
        route.fulfill(
            status=200,
            content_type="application/json",
            headers={"access-control-allow-origin": "https://umingle.com"},
            body=json.dumps(body),
        )

    def _ipify(self, route):
        route.fulfill(
            status=200,
            content_type="application/json",
            headers={"access-control-allow-origin": "https://umingle.com"},
            body=json.dumps({"ip": OWN["ip"]}),
        )

    def _on_ws(self, ws):
        self.sockets.append(ws)
        ws.on_message(lambda m: self.messages.append(m))

    def goto(self):
        self.page.goto("https://umingle.com/video/", wait_until="domcontentloaded")
        self.page.wait_for_function("window.__h && window.__h.ready", timeout=10000)
        self.page.bring_to_front()
        self.page.evaluate("window.__connect()")
        self.page.wait_for_function("window.__h.wsOpen === true", timeout=8000)

    def reload(self):
        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_function("window.__h && window.__h.ready", timeout=10000)
        self.page.bring_to_front()
        self.page.evaluate("window.__connect()")
        self.page.wait_for_function("window.__h.wsOpen === true", timeout=8000)

    def send(self, obj):
        if not self.sockets:
            raise RuntimeError("no routed websocket")
        self.sockets[-1].send(json.dumps(obj))
        # Playwright's sync driver only flushes routed-socket frames during an
        # API call. Without this pump a burst of sends would reach the page
        # together, seconds late, and break every timing check.
        self.page.wait_for_timeout(40)

    def conn(self, country="US", name="United States", cid=None, sb=False, candidates=None):
        frame = {
            "event": "conn",
            "country": country,
            "cName": name,
            "connectionID": cid or ("cid-" + country + "-" + str(int(time.time() * 1000))),
            "sb": bool(sb),
            "interests": ["chat"],
            "offer": {"type": "offer", "sdp": "v=0\r\n"},
            "candidates": list(candidates or []),
        }
        self.send(frame)
        return frame

    def end(self):
        self.send({"event": "end", "flag": "left"})

    def raw(self, text):
        if not self.sockets:
            raise RuntimeError("no routed websocket")
        self.sockets[-1].send(text)
        self.page.wait_for_timeout(60)

    def eval(self, expr, default=None):
        try:
            return self.page.evaluate(expr)
        except Exception as e:
            return default if default is not None else "error: " + str(e)

    def _pump(self):
        """Playwright only delivers routed-socket frames during an API call."""
        try:
            self.page.wait_for_timeout(1)
        except Exception:
            pass

    def last_json(self, event):
        """Last client -> server JSON frame with this event name."""
        self._pump()
        for m in reversed(self.messages):
            if isinstance(m, str):
                try:
                    obj = json.loads(m)
                except Exception:
                    continue
                if isinstance(obj, dict) and obj.get("event") == event:
                    return obj
        return None

    def binary(self, head):
        """Last client -> server binary frame whose first byte is `head`."""
        self._pump()
        out = None
        for m in self.messages:
            if isinstance(m, (bytes, bytearray)) and m and m[0] == head:
                out = bytes(m)
        return out

    def wait_binary(self, head, timeout=5.0):
        return poll(lambda: self.binary(head), timeout=timeout, interval=0.08)

    def close(self):
        try:
            self.page.close()
        except Exception:
            pass


PAGE_ERRORS = []


def main():
    report = {"checks": CHECKS, "page_errors": PAGE_ERRORS}
    with tempfile.TemporaryDirectory(prefix="utk-ext-") as profile:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                profile,
                **LAUNCH,
                headless=True,
                accept_downloads=True,
                viewport={"width": 1280, "height": 900},
                args=[
                    f"--disable-extensions-except={EXT}",
                    f"--load-extension={EXT}",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            )

            # The extension id is derived from the unpacked path. A fresh
            # profile sometimes leaves the MV3 worker dormant, so fall back to
            # the extensions page for the id (the popup and content scripts do
            # not need the worker).
            end = time.time() + 8
            while not ctx.service_workers and time.time() < end:
                time.sleep(0.1)
            if ctx.service_workers:
                ext_id = ctx.service_workers[0].url.split("/")[2]
            else:
                ep = ctx.new_page()
                ep.goto("chrome://extensions/", wait_until="domcontentloaded")
                ep.wait_for_timeout(700)
                ids = ep.evaluate(
                    """() => {
                        const m = document.querySelector('extensions-manager');
                        const list = m && m.shadowRoot.querySelector('extensions-item-list');
                        if (!list) return [];
                        return [...list.shadowRoot.querySelectorAll('extensions-item')]
                            .map((i) => i.id);
                    }"""
                )
                ep.close()
                ext_id = ids[0] if ids else ""
            if not ext_id:
                print("FATAL: extension did not load")
                return 2
            report["extension_id"] = ext_id
            print("extension id", ext_id)

            ctrl = ctx.new_page()
            ctrl.goto(f"chrome-extension://{ext_id}/src/popup.html", wait_until="domcontentloaded")
            ctrl.wait_for_function("window.UMINGLE && document.querySelector('#version')")

            def reset_settings():
                ctrl.evaluate(
                    """async () => {
                        const s = globalThis.UMINGLE.mergeSettings({});
                        await chrome.storage.sync.set({ settings: s });
                    }"""
                )
                time.sleep(0.35)

            def set_settings(patch):
                ctrl.evaluate(
                    """async (patch) => {
                        const got = await chrome.storage.sync.get('settings');
                        const next = Object.assign({}, got.settings || {}, patch);
                        await chrome.storage.sync.set({ settings: next });
                    }""",
                    patch,
                )
                time.sleep(0.4)

            def get_settings():
                return ctrl.evaluate(
                    """async () => (await chrome.storage.sync.get('settings')).settings || {}"""
                )

            def get_stats():
                return ctrl.evaluate(
                    """async () => {
                        const got = await chrome.storage.local.get('stats');
                        return got.stats || { days: {} };
                    }"""
                )

            def today_stats():
                return (get_stats().get("days") or {}).get(time.strftime("%Y-%m-%d"), {})

            # =============================================================
            # 1. Injection + Premium skin
            # =============================================================
            reset_settings()
            h = Harness(ctx, "p1")

            check("main-world TEST_HOOK is present", h.eval("typeof window.__umingTest") == "object",
                  h.eval("typeof window.__umingTest"))
            check("WebSocket wrapper keeps name/prototype",
                  h.eval("window.WebSocket.name + ':' + (window.WebSocket.prototype === WebSocket.prototype)") == "WebSocket:true",
                  h.eval("window.WebSocket.name"))
            check("RTCPeerConnection wrapper keeps name",
                  h.eval("window.RTCPeerConnection.name") == "RTCPeerConnection",
                  h.eval("window.RTCPeerConnection.name"))
            check("no theme switch injected (the site owns the theme)",
                  h.eval("document.querySelectorAll('.sim-theme').length") == 0,
                  h.eval("document.querySelectorAll('.sim-theme').length"))

            hours = h.eval("(parseInt(localStorage.getItem('vip_expiry')||'0',10) - Date.now())/3600000")
            check("vip_expiry is ~24 h ahead", isinstance(hours, (int, float)) and 23 <= hours <= 25, hours)
            check("body.is-vip", h.eval("document.body.classList.contains('is-vip')") is True)
            check("Premium badge visible", h.eval("getComputedStyle(document.getElementById('vipStatusBadge')).display") == "flex",
                  h.eval("document.getElementById('vipStatusBadge').style.display"))
            check("Premium banner visible", h.eval("document.getElementById('vipActiveBanner').style.display") == "block")
            check("Extend reassurance visible", h.eval("document.getElementById('extendReassurance').style.display") == "block")
            check("checkout header says Extend",
                  "Extend" in str(h.eval("document.getElementById('checkoutHeaderText').textContent")))
            check("upgrade button says Extend",
                  "extend" in str(h.eval("document.querySelector('.premium-upgrade-btn').textContent")).lower(),
                  h.eval("document.querySelector('.premium-upgrade-btn').textContent"))
            check("exact timer looks like a countdown",
                  bool(re.match(r"^(\d+d \d+h \d+m|\d{2}:\d{2}:\d{2})$", str(h.eval("document.getElementById('checkoutExactTimer').textContent")).strip())),
                  h.eval("document.getElementById('checkoutExactTimer').textContent"))

            set_settings({"premium": False})
            time.sleep(0.8)
            check("premium off removes is-vip", h.eval("document.body.classList.contains('is-vip')") is False)
            check("premium off hides the badge",
                  h.eval("getComputedStyle(document.getElementById('vipStatusBadge')).display") == "none")
            check("premium off restores the upgrade button",
                  "extend" not in str(h.eval("document.querySelector('.premium-upgrade-btn').textContent")).lower())
            set_settings({"premium": True})
            time.sleep(0.8)
            check("premium on again", h.eval("document.body.classList.contains('is-vip')") is True)

            # =============================================================
            # 2. Theme removed + stranger IP memory + ban gate
            # =============================================================
            h.page.click("body")
            h.page.keyboard.press("t")
            time.sleep(0.3)
            check("T no longer toggles a theme setting", "theme" not in get_settings(),
                  get_settings().get("theme"))
            check("the site's own theme control is untouched",
                  h.eval("!!document.getElementById('toggleDark')") is True)

            hb = Harness(ctx, "ip")
            SRFLX = ("candidate:1 1 UDP 2122252543 203.0.113.50 54321 typ srflx "
                     "raddr 0.0.0.0 rport 0")
            ctrl.evaluate(
                """async () => chrome.storage.local.set({
                    strangerIps: { v: 1, ips: {
                        '198.51.100.99': { n: 4, first: Date.now() - 86400000,
                                           last: Date.now() - 3600000, cc: 'DE' }
                    } }
                })"""
            )
            hb.conn("US", "United States", "ip-first", candidates=[SRFLX])
            time.sleep(1.0)
            book = ctrl.evaluate(
                """async () => (await chrome.storage.local.get('strangerIps')).strangerIps"""
            ) or {}
            ips = book.get("ips") or {}
            check("first meeting records the stranger IP",
                  (ips.get("203.0.113.50") or {}).get("n") == 1, ips)
            check("IP book merge keeps records from another tab",
                  (ips.get("198.51.100.99") or {}).get("n") == 4, sorted(ips))
            check("first meeting shows no seen-before line",
                  hb.eval("(() => { const el = document.querySelector('.utk-revisit');"
                          " return el ? getComputedStyle(el).display : 'none'; })()") == "none")
            check("first meeting shows no seen-before toast",
                  "seen this stranger before" not in str(
                      hb.eval("(document.querySelector('.utk-toasts') || {}).textContent")).lower())

            hb.end()
            time.sleep(0.5)
            hb.conn("US", "United States", "ip-repeat", candidates=[SRFLX])
            time.sleep(1.0)
            book = ctrl.evaluate(
                """async () => (await chrome.storage.local.get('strangerIps')).strangerIps"""
            ) or {}
            check("second meeting counts the stranger",
                  ((book.get("ips") or {}).get("203.0.113.50") or {}).get("n") == 2, book)
            revisit = str(hb.eval(
                "(() => { const el = document.querySelector('.utk-revisit');"
                " return el ? getComputedStyle(el).display + '|' + el.textContent : ''; })()"))
            check("second meeting shows the seen-before line",
                  revisit.startswith("flex|") and "Seen before" in revisit, revisit)
            toast_text = str(hb.eval("(document.querySelector('.utk-toasts') || {}).textContent"))
            check("second meeting toasts the repeat",
                  "met this stranger before" in toast_text.lower(), toast_text)

            # --- per-stranger note (v3.5) ---------------------------------
            def ip_book():
                return (ctrl.evaluate(
                    """async () => (await chrome.storage.local.get('strangerIps')).strangerIps"""
                ) or {}).get("ips") or {}

            hb.eval("document.activeElement && document.activeElement.blur()")
            hb.page.click(".utk-tool-more")
            time.sleep(0.25)
            check("More menu enables a note for the current stranger",
                  hb.eval("(() => { const el = document.querySelector('.utk-menu-item[data-menu=note]');"
                          " return !!el && !el.disabled; })()") is True)
            hb.page.click('.utk-menu-item[data-menu="note"]')
            check("the note editor opens", poll(lambda: hb.eval(
                "(() => { const el = document.querySelector('.utk-note');"
                " return !!el && getComputedStyle(el).display === 'flex'; })()") is True, timeout=3))
            NOTE = "Met in Jakarta, asked about the guitar"
            hb.page.fill(".utk-note-input", NOTE)
            hb.page.click(".utk-note-btn.primary")
            check("the note is saved on the stranger's address",
                  poll(lambda: (ip_book().get("203.0.113.50") or {}).get("note") == NOTE, timeout=3),
                  ip_book().get("203.0.113.50"))
            note_line = str(hb.eval(
                "(() => { const el = document.querySelector('.utk-stranger-note');"
                " return el ? getComputedStyle(el).display + '|' + el.textContent : ''; })()"))
            check("the note shows under the country row",
                  note_line.startswith("flex|") and "guitar" in note_line, note_line)

            hb.end()
            time.sleep(0.5)
            hb.conn("US", "United States", "ip-note-again", candidates=[SRFLX])
            time.sleep(1.0)
            entry = ip_book().get("203.0.113.50") or {}
            check("the note survives a repeat meeting",
                  entry.get("n") == 3 and entry.get("note") == NOTE, entry)
            note_line = str(hb.eval(
                "(() => { const el = document.querySelector('.utk-stranger-note');"
                " return el ? getComputedStyle(el).display + '|' + el.textContent : ''; })()"))
            check("the note comes back with the returning stranger",
                  note_line.startswith("flex|") and "guitar" in note_line, note_line)

            hb.page.click(".utk-stranger-note")
            prefill = poll(lambda: hb.eval(
                "(() => { const el = document.querySelector('.utk-note-input');"
                " return el && el.value ? el.value : null; })()"), timeout=3)
            check("clicking the note line opens the saved text", prefill == NOTE, prefill)
            hb.page.click('[data-note="delete"]')
            check("Delete clears the note",
                  poll(lambda: (ip_book().get("203.0.113.50") or {}).get("note") == "", timeout=3),
                  ip_book().get("203.0.113.50"))
            check("the note line hides when there is no note",
                  hb.eval("(() => { const el = document.querySelector('.utk-stranger-note');"
                          " return el ? getComputedStyle(el).display : 'none'; })()") == "none")

            # Unlimited address book: 600 entries stay and the new one is added.
            hb.end()
            time.sleep(0.5)
            many = {"198.18.%d.%d" % (i // 250, i % 250 + 1): {
                "n": 1, "first": 1700000000000, "last": 1700000000000, "cc": "ID",
            } for i in range(600)}
            ctrl.evaluate(
                "async (ips) => chrome.storage.local.set({ strangerIps: { v: 1, ips } })", many)
            time.sleep(0.3)
            SRFLX2 = ("candidate:1 1 UDP 2122252543 203.0.113.51 54322 typ srflx "
                      "raddr 0.0.0.0 rport 0")
            hb.conn("US", "United States", "ip-unlimited", candidates=[SRFLX2])
            time.sleep(1.2)
            book = ip_book()
            check("stored addresses are not capped at 500",
                  len(book) == 601 and "198.18.0.1" in book, len(book))

            # --- ban gate -------------------------------------------------
            hb.eval("document.cookie = 'user=ban-visitor; Max-Age=3600; Path=/'")
            hb.send({"event": "banned", "reason": "Under 18", "banId": "ban-1"})
            time.sleep(0.9)
            ban = ctrl.evaluate(
                """async () => (await chrome.storage.local.get('lastBan')).lastBan""") or {}
            check("ban is remembered with the current IP",
                  ban.get("reason") == "Under 18" and ban.get("ip") == OWN["ip"], ban)
            toast_text = str(hb.eval("(document.querySelector('.utk-toasts') || {}).textContent"))
            check("ban toast tells the user to change the IP",
                  "change your ip" in toast_text.lower(), toast_text)
            hb.page.evaluate("document.activeElement && document.activeElement.blur()")
            hb.page.keyboard.press("n")
            refusal = poll(lambda: (
                "still on the banned ip" in str(hb.eval(
                    "(document.querySelector('.utk-toasts') || {}).textContent")).lower()
                or None), timeout=4.5)
            check("New identity is refused on the banned IP", refusal,
                  hb.eval("(document.querySelector('.utk-toasts') || {}).textContent"))
            check("refused New identity keeps the visitor cookie",
                  "user=ban-visitor" in str(hb.eval("document.cookie")), hb.eval("document.cookie"))

            hb.eval("window.__h.bannedFlag = false")
            hb.conn("BR", "Brazil", "after-ban", candidates=[SRFLX])
            time.sleep(0.9)
            check("an accepted match clears the stored ban",
                  ctrl.evaluate(
                      """async () => (await chrome.storage.local.get('lastBan')).lastBan"""
                  ) is None)

            hb.send({"event": "ageBlock"})
            time.sleep(0.9)
            ban2 = ctrl.evaluate(
                """async () => (await chrome.storage.local.get('lastBan')).lastBan""") or {}
            check("age block is remembered too", ban2.get("kind") == "ageBlock", ban2)
            OWN["ip"] = "198.51.100.7"
            hb.eval("window.__beforeNewId = true")
            hb.page.evaluate("document.activeElement && document.activeElement.blur()")
            hb.page.keyboard.press("n")
            reloaded = poll(lambda: hb.eval("window.__beforeNewId") is None, timeout=7)
            check("New identity is allowed after the IP changed", reloaded,
                  hb.eval("window.__beforeNewId"))
            check("identity reload kept the page alive",
                  poll(lambda: hb.eval("window.__h && window.__h.ready") is True, timeout=5) is True)
            check("allowed New identity clears the stored ban",
                  ctrl.evaluate(
                      """async () => (await chrome.storage.local.get('lastBan')).lastBan"""
                  ) is None)

            OWN["ip"] = "203.0.113.10"
            hb.close()

            # =============================================================
            # 3. Country filter: save, restore (single + multi), auto-skip
            # =============================================================
            reset_settings()
            h.reload()
            h.page.click('.cf-option[data-country="US"]')
            time.sleep(0.5)
            check("clicking US saves filterCountries", get_settings().get("filterCountries") == ["US"],
                  get_settings().get("filterCountries"))
            check("US selected, ANY cleared", h.eval("window.__selectedCodes()") == ["US"],
                  h.eval("window.__selectedCodes()"))

            h.reload()
            ok_restore = poll(lambda: h.eval("window.__selectedCodes()") == ["US"], timeout=5)
            check("filter restored after reload", ok_restore,
                  h.eval("window.__selectedCodes()"))
            check("restore wrote the Premium gate", (h.eval("parseInt(localStorage.getItem('vip_expiry')||'0',10)") or 0) > time.time() * 1000)
            check("ANY is not selected after restore",
                  h.eval("document.querySelector('.cf-option[data-country=ANY]').classList.contains('selected')") is False)

            # Two countries with the multi toggle.
            h.page.click("#cf-multi-toggle")
            h.page.click('.cf-option[data-country="ID"]')
            time.sleep(0.5)
            check("multi-select save", get_settings().get("filterCountries") == ["ID", "US"],
                  get_settings().get("filterCountries"))
            h.reload()
            ok_multi = poll(lambda: h.eval("window.__selectedCodes()") == ["ID", "US"], timeout=5)
            check("multi filter restored after reload", ok_multi, h.eval("window.__selectedCodes()"))
            # Back to a single country for the skip test.
            h.page.click("#cf-multi-toggle")   # multi off
            h.page.click('.cf-option[data-country="US"]')
            time.sleep(0.5)
            check("single filter saved again", get_settings().get("filterCountries") == ["US"],
                  get_settings().get("filterCountries"))

            before = h.eval("window.__h.presses")
            h.conn("ID", "Indonesia", "skip-id-1")
            got = poll(lambda: (h.eval("window.__h.presses") or 0) >= before + 2, timeout=6)
            check("wrong country gets the two-press skip", got,
                  {"presses": h.eval("window.__h.presses"), "label": h.eval("window.__skipLabel()")})

            time.sleep(1.7)  # clear the skip cooldown
            before = h.eval("window.__h.presses")
            h.conn("US", "United States", "ok-us-1")
            time.sleep(1.0)
            check("selected country is accepted", h.eval("window.__h.presses") == before,
                  h.eval("window.__h.presses"))
            check("match card shows the country",
                  "United States" in str(h.eval("document.getElementById('countryName').textContent")),
                  h.eval("document.getElementById('countryName').textContent"))

            # The page's own gate: with the toolkit off and no vip_expiry, a
            # country click must open the checkout instead of selecting.
            set_settings({"enabled": False})
            time.sleep(0.4)
            h.eval("localStorage.removeItem('vip_expiry')")
            h.page.click('.cf-option[data-country="BR"]')
            time.sleep(0.3)
            check("page gate blocks countries without vip_expiry",
                  h.eval("window.__h.checkoutOpens") == 1, h.eval("window.__h.checkoutOpens"))
            h.eval("window.__closeCheckout()")
            check("toolkit off leaves no Premium body class",
                  h.eval("document.body.classList.contains('is-vip')") is False)
            set_settings({"enabled": True})
            time.sleep(0.6)
            check("toolkit on restores the gate",
                  (h.eval("parseInt(localStorage.getItem('vip_expiry')||'0',10)") or 0) > time.time() * 1000)

            # =============================================================
            # 4. Throttle nag
            # =============================================================
            reset_settings()
            time.sleep(0.5)
            h.eval("document.getElementById('premiumThrottle').style.display = 'none'")
            h.send({"event": "throttle", "price": "Rp39,900"})
            time.sleep(0.5)
            check("throttle nag hidden with !important",
                  h.eval("document.getElementById('premiumThrottle').style.getPropertyPriority('display')") == "important",
                  h.eval("document.getElementById('premiumThrottle').style.cssText"))
            check("throttle nag computed display none",
                  h.eval("getComputedStyle(document.getElementById('premiumThrottle')).display") == "none")

            h.eval("window.__setThrottle(true)")  # the site shows it again
            time.sleep(0.3)
            check("MutationObserver re-hides the nag",
                  h.eval("getComputedStyle(document.getElementById('premiumThrottle')).display") == "none",
                  h.eval("document.getElementById('premiumThrottle').style.cssText"))

            set_settings({"hideThrottle": False})
            time.sleep(0.6)
            check("turning the hide off restores the nag",
                  h.eval("getComputedStyle(document.getElementById('premiumThrottle')).display") == "flex",
                  h.eval("document.getElementById('premiumThrottle').style.cssText"))
            set_settings({"hideThrottle": True})
            time.sleep(0.6)
            check("turning the hide back on hides it",
                  h.eval("getComputedStyle(document.getElementById('premiumThrottle')).display") == "none")

            # =============================================================
            # 5. City line + ICE capture + connection HUD
            # =============================================================
            reset_settings()
            time.sleep(0.4)
            h.conn("US", "United States", "geo-us-1")
            time.sleep(1.1)
            h.eval("window.__makePc(false)")
            h.eval("window.__addSrflx('198.51.100.7')")
            geo_ok = poll(lambda: "Jakarta" in str(h.eval("document.querySelector('.cityGuessLine') && document.querySelector('.cityGuessLine').textContent")), timeout=6)
            check("city line appears from the srflx candidate", geo_ok,
                  h.eval("document.querySelector('.cityGuessLine') && document.querySelector('.cityGuessLine').textContent"))
            check("city line has ISP", "PT Contoh Nusantara" in str(h.eval("document.querySelector('.cityGuessLine') && document.querySelector('.cityGuessLine').textContent")))
            check("city line has their local time", "there" in str(h.eval("document.querySelector('.cityGuessLine') && document.querySelector('.cityGuessLine').textContent")))
            h.eval("window.__addHostCandidate('192.168.1.5')")
            time.sleep(0.3)
            check("host candidates are ignored",
                  "192.168" not in str(h.eval("document.querySelector('.cityGuessLine') && document.querySelector('.cityGuessLine').textContent")))

            hud_ok = poll(lambda: h.eval(
                "(() => { const t = document.querySelector('.utk-hud'); if (!t) return false;"
                " if (getComputedStyle(t).display !== 'flex') return false;"
                " return /[0-9]+ kbps/.test(t.textContent) && /[0-9]+ ms/.test(t.textContent); })()"
            ), timeout=8)
            check("HUD visible with stats", hud_ok,
                  h.eval("document.querySelector('.utk-hud') && document.querySelector('.utk-hud').textContent"))
            hud_text = str(h.eval("document.querySelector('.utk-hud') && document.querySelector('.utk-hud').textContent"))
            check("HUD shows P2P", "P2P" in hud_text, hud_text)
            check("HUD shows 640x480", "640\u00D7480" in hud_text, hud_text)
            check("HUD shows kbps", "kbps" in hud_text, hud_text)
            check("HUD shows RTT", "42 ms" in hud_text, hud_text)

            h.eval("window.__setRelay(true)")
            relay_ok = poll(lambda: "TURN" in str(h.eval("document.querySelector('.utk-hud') && document.querySelector('.utk-hud').textContent")), timeout=6)
            check("HUD switches to TURN", relay_ok,
                  h.eval("document.querySelector('.utk-hud') && document.querySelector('.utk-hud').textContent"))
            check("HUD gets the relay class",
                  h.eval("document.querySelector('.utk-hud').classList.contains('utk-relay')") is True)

            set_settings({"hud": False})
            time.sleep(0.8)
            check("HUD hidden when the setting is off",
                  h.eval("getComputedStyle(document.querySelector('.utk-hud')).display") == "none")
            check("HUD setting reaches the page world", h.eval("window.__umingTest.state.hud") is False)
            set_settings({"hud": True})
            time.sleep(0.8)

            h.end()
            end_hidden = poll(lambda: h.eval("getComputedStyle(document.querySelector('.cityGuessLine')).display") == "none", timeout=5)
            check("end hides the city line", end_hidden,
                  h.eval("document.querySelector('.cityGuessLine') && document.querySelector('.cityGuessLine').style.cssText"))
            check("end hides the HUD",
                  poll(lambda: h.eval("getComputedStyle(document.querySelector('.utk-hud')).display") == "none", timeout=5))

            # =============================================================
            # 6. Shadowban banner
            # =============================================================
            reset_settings()
            time.sleep(0.5)
            h.conn("US", "United States", "sb-1", sb=True)
            sb_ok = poll(lambda: h.eval("getComputedStyle(document.querySelector('.utk-sb-banner')).display") == "flex", timeout=5)
            check("shadowban banner appears", sb_ok,
                  h.eval("document.querySelector('.utk-sb-banner') && document.querySelector('.utk-sb-banner').textContent"))
            check("banner explains the dead call",
                  "cannot see or hear you" in str(h.eval("document.querySelector('.utk-sb-copy') && document.querySelector('.utk-sb-copy').textContent")))
            before = h.eval("window.__h.presses")
            h.page.click(".utk-sb-skip")
            got = poll(lambda: (h.eval("window.__h.presses") or 0) >= before + 2, timeout=5)
            check("banner Skip button leaves the match", got, h.eval("window.__h.presses"))
            check("banner hidden after the skip",
                  h.eval("getComputedStyle(document.querySelector('.utk-sb-banner')).display") == "none")

            time.sleep(1.7)
            set_settings({"skipShadowbanned": True})
            before = h.eval("window.__h.presses")
            h.conn("US", "United States", "sb-2", sb=True)
            got = poll(lambda: (h.eval("window.__h.presses") or 0) >= before + 2, timeout=6)
            check("skipShadowbanned auto-leaves the dead call", got, h.eval("window.__h.presses"))
            set_settings({"skipShadowbanned": False})

            # =============================================================
            # 6b. Easy skip, block list, unknown country
            # =============================================================
            reset_settings()
            # The country filter still remembers US from section 3; clear it so
            # this section tests easy skip and the block list alone.
            h.page.click('.cf-option[data-country="ANY"]')
            time.sleep(0.6)
            if get_settings().get("filterCountries"):
                set_settings({"filterCountries": [], "rememberFilter": False})
                time.sleep(0.5)
            h.conn("US", "United States", "easy-1")
            time.sleep(0.9)
            before = h.eval("window.__h.presses") or 0
            before_second = h.eval("window.__h.secondPresses") or 0
            before_len = h.eval("window.pressed.length") or 0
            before_mash = h.eval("window.__h.mashPauses") or 0
            h.page.click(".skipButton")
            got = poll(lambda: (h.eval("window.__h.presses") or 0) >= before + 2, timeout=4)
            check("easy skip: one click leaves at once", got,
                  {"presses": h.eval("window.__h.presses"), "label": h.eval("window.__skipLabel()")})
            check("easy skip: the site saw its second press",
                  (h.eval("window.__h.secondPresses") or 0) == before_second + 1,
                  {"second": h.eval("window.__h.secondPresses"), "before": before_second})
            after_len = h.eval("window.pressed.length") or 0
            check("easy skip: one logical press recorded in window.pressed",
                  after_len == min(4, before_len + 1), {"before": before_len, "after": after_len})
            check("easy skip: no mashing pause", (h.eval("window.__h.mashPauses") or 0) == before_mash)
            check("easy skip: label returns to Skip",
                  poll(lambda: h.eval("window.__skipLabel()") == "Skip", timeout=2))

            time.sleep(1.7)
            set_settings({"easySkip": False})
            time.sleep(0.5)
            check("easy skip setting reaches the page world",
                  h.eval("window.__umingTest.state.easySkip") is False)
            h.conn("US", "United States", "easy-off-1")
            time.sleep(0.9)
            before = h.eval("window.__h.presses") or 0
            h.page.click(".skipButton")
            time.sleep(0.35)
            check("easy skip off: first click only asks Really?",
                  (h.eval("window.__h.presses") or 0) == before + 1 and
                  h.eval("window.__skipLabel()") == "Really?",
                  {"presses": h.eval("window.__h.presses"), "label": h.eval("window.__skipLabel()")})
            h.page.click(".skipButton")
            time.sleep(0.4)
            check("easy skip off: second click leaves",
                  (h.eval("window.__h.presses") or 0) == before + 2,
                  h.eval("window.__h.presses"))
            set_settings({"easySkip": True})
            time.sleep(0.5)

            time.sleep(1.7)
            set_settings({"blockCountries": ["US"]})
            time.sleep(0.4)
            before = h.eval("window.__h.presses") or 0
            h.conn("US", "United States", "block-us-1")
            got = poll(lambda: (h.eval("window.__h.presses") or 0) >= before + 2, timeout=5)
            check("block list leaves a blocked country at match time", got, h.eval("window.__h.presses"))

            time.sleep(1.7)
            before = h.eval("window.__h.presses") or 0
            h.conn("ID", "Indonesia", "block-id-1")
            time.sleep(0.9)
            check("block list lets other countries through",
                  (h.eval("window.__h.presses") or 0) == before,
                  h.eval("window.__h.presses"))

            # The More menu's "Block this country" adds the live match country
            # and leaves at once.
            h.page.click(".utk-tool-more")
            time.sleep(0.25)
            h.page.click('.utk-menu-item[data-menu="block"]')
            got = poll(lambda: (h.eval("window.__h.presses") or 0) >= before + 2, timeout=4)
            check("menu block leaves the current match", got, h.eval("window.__h.presses"))
            saved = poll(lambda: "ID" in (get_settings().get("blockCountries") or []), timeout=3)
            check("menu block saves the country", saved,
                  get_settings().get("blockCountries"))

            set_settings({"blockCountries": [], "easySkip": True})
            time.sleep(0.5)

            time.sleep(1.7)
            set_settings({"skipUnknownCountry": True})
            time.sleep(0.4)
            before = h.eval("window.__h.presses") or 0
            h.send({
                "event": "conn",
                "connectionID": "unknown-1",
                "interests": [],
                "offer": {"type": "offer", "sdp": "v=0\r\n"},
                "candidates": [],
            })
            got = poll(lambda: (h.eval("window.__h.presses") or 0) >= before + 2, timeout=5)
            check("skip unknown country leaves a country-less match", got, h.eval("window.__h.presses"))
            set_settings({"skipUnknownCountry": False, "easySkip": True})
            time.sleep(0.5)

            # =============================================================
            # 7. Toolbar, hotkeys, leave guard, worker stub, label mapping
            # =============================================================
            reset_settings()
            time.sleep(0.5)
            h.conn("US", "United States", "tools-1")
            time.sleep(1.0)
            h.eval("window.__makePc(false)")
            check("in-video toolbar visible",
                  h.eval("getComputedStyle(document.querySelector('.utk-tools')).display") == "flex")
            check("toolbar has eight tools",
                  h.eval("document.querySelectorAll('.utk-tools .utk-tool').length") == 8,
                  h.eval("document.querySelectorAll('.utk-tools .utk-tool').length"))

            h.page.click(".utk-tool-boost")
            time.sleep(0.3)
            check("boost button -> 1.5x", get_settings().get("volumeBoost") == 1.5, get_settings().get("volumeBoost"))
            check("boost label shows 1.5x",
                  h.eval("document.querySelector('.utk-tool-boost').textContent") == "1.5\u00D7",
                  h.eval("document.querySelector('.utk-tool-boost').textContent"))
            h.page.click(".utk-tool-boost")
            time.sleep(0.25)
            check("boost button -> 2x", get_settings().get("volumeBoost") == 2)
            h.page.click(".utk-tool-boost")
            time.sleep(0.25)
            check("boost button -> 1x", get_settings().get("volumeBoost") == 1)

            h.eval("document.getElementById('otherVideo').muted = false")
            h.page.click(".utk-tool-mute")
            time.sleep(0.3)
            check("mute button mutes the video", h.eval("document.getElementById('otherVideo').muted") is True)
            h.page.click(".utk-tool-mute")
            time.sleep(0.3)
            check("mute button unmutes the video", h.eval("document.getElementById('otherVideo').muted") is False)

            set_settings({"hud": True})
            h.page.click(".utk-tool-hud")
            time.sleep(0.3)
            check("HUD button turns the HUD off", get_settings().get("hud") is False)
            h.page.keyboard.press("h")
            time.sleep(0.3)
            check("H hotkey turns the HUD on", get_settings().get("hud") is True)

            # HUD outbound + match timer
            out_ok = poll(lambda: "\u2191" in str(h.eval("document.querySelector('.utk-hud-out') && document.querySelector('.utk-hud-out').textContent"))
                          and "kbps" in str(h.eval("document.querySelector('.utk-hud-out') && document.querySelector('.utk-hud-out').textContent")), timeout=8)
            check("HUD shows the outbound bitrate", out_ok,
                  h.eval("document.querySelector('.utk-hud-out') && document.querySelector('.utk-hud-out').textContent"))
            time_ok = poll(lambda: re.match(r"^\d\d:\d\d$",
                                            str(h.eval("document.querySelector('.utk-hud-time') && document.querySelector('.utk-hud-time').textContent")).strip()) is not None, timeout=4)
            check("HUD shows the match timer", bool(time_ok),
                  h.eval("document.querySelector('.utk-hud-time') && document.querySelector('.utk-hud-time').textContent"))

            # More menu
            h.page.click(".utk-tool-more")
            time.sleep(0.3)
            check("More menu opens",
                  h.eval("getComputedStyle(document.querySelector('.utk-menu')).display") == "flex",
                  h.eval("document.querySelector('.utk-menu') && document.querySelector('.utk-menu').style.display"))
            check("More menu lists seven actions",
                  h.eval("document.querySelectorAll('.utk-menu .utk-menu-item').length") == 7,
                  h.eval("document.querySelectorAll('.utk-menu .utk-menu-item').length"))

            # Self view: mirror -> normal -> hidden -> mirror
            tf = str(h.eval("getComputedStyle(document.getElementById('myVideo')).transform"))
            check("self view starts mirrored", tf not in ("none", ""), tf)
            h.page.click('.utk-menu-item[data-menu="self"]')
            time.sleep(0.35)
            check("self view Normal removes the mirror",
                  h.eval("getComputedStyle(document.getElementById('myVideo')).transform") == "none",
                  h.eval("getComputedStyle(document.getElementById('myVideo')).transform"))
            h.page.click('.utk-menu-item[data-menu="self"]')
            time.sleep(0.35)
            check("self view Hidden hides the preview",
                  h.eval("getComputedStyle(document.getElementById('myVideo')).visibility") == "hidden",
                  h.eval("getComputedStyle(document.getElementById('myVideo')).visibility"))
            h.page.click('.utk-menu-item[data-menu="self"]')
            time.sleep(0.35)
            check("self view cycles back to Mirror",
                  h.eval("getComputedStyle(document.getElementById('myVideo')).visibility") == "visible" and
                  h.eval("getComputedStyle(document.getElementById('myVideo')).transform") != "none",
                  {"vis": h.eval("getComputedStyle(document.getElementById('myVideo')).visibility"),
                   "tf": h.eval("getComputedStyle(document.getElementById('myVideo')).transform")})
            h.page.click("header")
            time.sleep(0.2)
            check("menu closes on an outside click",
                  h.eval("getComputedStyle(document.querySelector('.utk-menu')).display") == "none")

            # Snapshot: no video, then a real canvas stream
            h.page.click(".utk-tool-shot")
            time.sleep(0.4)
            check("snapshot without video explains why",
                  "No stranger video" in str(h.eval("document.querySelector('.utk-toasts') && document.querySelector('.utk-toasts').textContent")),
                  h.eval("document.querySelector('.utk-toasts') && document.querySelector('.utk-toasts').textContent"))
            h.eval("window.__armVideo()")
            poll(lambda: (h.eval("document.getElementById('otherVideo').videoWidth") or 0) > 0, timeout=5)
            snap = None
            snap_err = ""
            try:
                with h.page.expect_download(timeout=10000) as info:
                    h.page.click(".utk-tool-shot")
                snap = info.value
            except Exception as e:
                snap = None
                snap_err = str(e)
            check("snapshot downloads a PNG",
                  bool(snap) and snap.suggested_filename.startswith("umingle-US-") and snap.suggested_filename.endswith(".png"),
                  getattr(snap, "suggested_filename", snap_err))
            snap_bytes = 0
            try:
                snap_bytes = Path(snap.path()).stat().st_size if snap else 0
            except Exception:
                snap_bytes = 0
            check("snapshot PNG has content", snap_bytes > 200, snap_bytes)

            # Chat transcript download
            h.eval("window.__chat('Partner', 'hello there')")
            time.sleep(0.4)
            h.page.click(".utk-tool-more")
            time.sleep(0.25)
            log_dl = None
            log_err = ""
            try:
                with h.page.expect_download(timeout=8000) as info2:
                    h.page.click('.utk-menu-item[data-menu="chatlog"]')
                log_dl = info2.value
            except Exception as e:
                log_dl = None
                log_err = str(e)
            check("chat log downloads a .txt",
                  bool(log_dl) and log_dl.suggested_filename.endswith(".txt"),
                  getattr(log_dl, "suggested_filename", log_err))
            log_text = ""
            try:
                log_text = Path(log_dl.path()).read_text(encoding="utf-8", errors="replace") if log_dl else ""
            except Exception:
                log_text = ""
            check("chat transcript contains the relayed message",
                  "Partner: hello there" in log_text, log_text[:160])

            # Tab title: country + timer
            check("tab title shows the match country",
                  poll(lambda: "United States" in str(h.eval("document.title")), timeout=4) is True,
                  h.eval("document.title"))
            check("tab title shows the match timer",
                  bool(re.search(r"\d\d:\d\d", str(h.eval("document.title")))),
                  h.eval("document.title"))

            h.page.click(".utk-tool-help")
            time.sleep(0.3)
            check("help button opens the overlay",
                  h.eval("getComputedStyle(document.querySelector('.utk-help')).display") == "flex")
            check("help lists hotkeys",
                  "Volume boost" in str(h.eval("document.querySelector('.utk-help') && document.querySelector('.utk-help').textContent")))
            h.page.keyboard.press("Escape")
            time.sleep(0.25)
            check("Escape closes the help overlay",
                  h.eval("getComputedStyle(document.querySelector('.utk-help')).display") == "none")

            h.page.click("body")
            h.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))")
            time.sleep(0.3)
            check("? opens the help overlay",
                  h.eval("getComputedStyle(document.querySelector('.utk-help')).display") == "flex")
            h.page.keyboard.press("Escape")
            time.sleep(0.2)

            set_settings({"toolbar": False})
            time.sleep(0.5)
            check("toolbar hidden when the setting is off",
                  h.eval("getComputedStyle(document.querySelector('.utk-tools')).display") == "none")
            set_settings({"toolbar": True})
            time.sleep(0.5)

            check("leave guard cancels beforeunload",
                  h.eval("(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()") is True)
            set_settings({"leaveGuard": False})
            time.sleep(0.4)
            check("leave guard off lets beforeunload pass",
                  h.eval("(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()") is False)
            set_settings({"leaveGuard": True})

            h.eval("window.__runWorker()")
            time.sleep(0.8)
            msgs = h.eval("window.__h.workerMsgs") or []
            check("vision worker answers faceDetectorLoaded",
                  any(isinstance(m, dict) and m.get("action") == "faceDetectorLoaded" for m in msgs), msgs)
            check("vision worker returns the face-found checksum",
                  any(isinstance(m, dict) and m.get("k") == 1792418337 for m in msgs), msgs)

            expected_cam = h.eval(
                "(() => { const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';"
                " return /mac/i.test(p) ? 'FaceTime HD Camera'"
                " : /linux/i.test(p) ? 'Integrated Webcam (0bda:5520)'"
                " : 'Integrated Camera (04f2:b6dd)'; })()")
            check("camera label spoof maps OBS Virtual Camera",
                  h.eval("window.__umingTest.mapCameraLabel('OBS Virtual Camera', 'videoinput')") == expected_cam,
                  h.eval("window.__umingTest.mapCameraLabel('OBS Virtual Camera', 'videoinput')"))
            check("physical camera label untouched",
                  h.eval("window.__umingTest.mapCameraLabel('Integrated Camera (04f2:b6dd)', 'videoinput')") == "Integrated Camera (04f2:b6dd)")
            check("audio labels untouched",
                  h.eval("window.__umingTest.mapCameraLabel('OBS Virtual Camera', 'audioinput')") == "OBS Virtual Camera")
            check("Obsbot is not treated as a virtual camera",
                  h.eval("window.__umingTest.mapCameraLabel('Obsbot Tiny 4K', 'videoinput')") == "Obsbot Tiny 4K")
            check("isPublicIp rejects RFC1918",
                  h.eval("window.__umingTest.isPublicIp('192.168.1.4')") is False)
            check("isPublicIp accepts a public address",
                  h.eval("window.__umingTest.isPublicIp('198.51.100.9')") is True)

            # PiP: the click is trusted; accept either a real PiP element or
            # the extension's own failure toast (proves the handler ran).
            h.eval("window.__armPip()")
            h.page.click(".utk-tool-pip")
            time.sleep(1.0)
            pip_state = {
                "element": h.eval("!!document.pictureInPictureElement"),
                "calls": h.eval("window.__pipCalls"),
                "toast": str(h.eval("document.querySelector('.utk-toasts') && document.querySelector('.utk-toasts').textContent")),
            }
            check("PiP button runs the PiP path",
                  pip_state["element"] or pip_state["calls"] or "PiP" in pip_state["toast"], pip_state)

            # S hotkey skips the current stranger.
            time.sleep(1.2)
            before = h.eval("window.__h.presses")
            # A neutral target: clicking the page centre would focus the chat
            # field, and hotkeys are ignored while typing.
            h.page.click("header")
            h.page.keyboard.press("s")
            got = poll(lambda: (h.eval("window.__h.presses") or 0) >= before + 2, timeout=5)
            check("S hotkey skips", got, h.eval("window.__h.presses"))
            check("tab title returns to normal after the match",
                  poll(lambda: h.eval("document.title") == "Umingle Toolkit harness", timeout=4) is True,
                  h.eval("document.title"))

            # =============================================================
            # 8. Stats + popup
            # =============================================================
            ctrl.evaluate("chrome.storage.local.set({ stats: { days: {} } })")
            time.sleep(0.3)
            h2 = Harness(ctx, "p2")
            reset_settings()
            time.sleep(0.4)
            h2.conn("US", "United States", "st-us-1")
            time.sleep(0.9)
            h2.page.click('.cf-option[data-country="US"]')
            time.sleep(0.4)
            h2.conn("ID", "Indonesia", "st-id-1")
            got = poll(lambda: (h2.eval("window.__h.presses") or 0) >= 2, timeout=6)
            time.sleep(0.4)
            h2.send({"event": "throttle", "price": "Rp39,900"})
            time.sleep(0.5)
            h2.conn("US", "United States", "st-us-2")
            time.sleep(1.0)
            h2.end()
            poll(lambda: today_stats().get("matches") == 3
                 and today_stats().get("throttles") == 1
                 and (today_stats().get("talkMs") or 0) > 0, timeout=8)

            stats = get_stats()
            today = (stats.get("days") or {}).get(time.strftime("%Y-%m-%d"), {})
            check("stats: three matches", today.get("matches") == 3, today.get("matches"))
            check("stats: one skip", today.get("skips") == 1, today.get("skips"))
            check("stats: one throttle", today.get("throttles") == 1, today.get("throttles"))
            check("stats: wait time recorded", (today.get("waitMs") or 0) > 0, today.get("waitMs"))
            check("stats: talk time recorded", (today.get("talkMs") or 0) > 0, today.get("talkMs"))
            check("stats: country reason counted", (today.get("reasons") or {}).get("country") == 1,
                  today.get("reasons"))
            check("stats: two US matches", ((today.get("countries") or {}).get("US") or {}).get("n") == 2,
                  today.get("countries"))
            check("stats: one ID match", ((today.get("countries") or {}).get("ID") or {}).get("n") == 1,
                  today.get("countries"))

            ctrl.reload(wait_until="domcontentloaded")
            ctrl.wait_for_function("document.querySelector('#statMatches')")
            # Bands start collapsed; open them all so the popup controls are reachable.
            ctrl.evaluate("() => document.querySelectorAll('details.band').forEach(d => { d.open = true })")
            time.sleep(0.6)
            check("popup shows today's matches", ctrl.inner_text("#statMatches") == "3", ctrl.inner_text("#statMatches"))
            check("popup shows skips", ctrl.inner_text("#statSkips") == "1")
            check("popup shows throttles", ctrl.inner_text("#statThrottles") == "1")
            check("popup shows average wait", ctrl.inner_text("#statWait") != "\u2014", ctrl.inner_text("#statWait"))
            check("popup renders country chips",
                  "United States" in ctrl.inner_text("#statCountries") and "Indonesia" in ctrl.inner_text("#statCountries"),
                  ctrl.inner_text("#statCountries"))
            check("popup filter summary shows the saved country",
                  "United States" in ctrl.inner_text("#filterSummary"), ctrl.inner_text("#filterSummary"))
            check("popup version is 3.6.0", ctrl.inner_text("#version") == "3.6.0", ctrl.inner_text("#version"))
            check("popup has no theme picker", ctrl.query_selector("#themeSeg") is None)
            check("popup has the stranger IP memory toggle",
                  ctrl.query_selector('.toggle[data-key="ipHistory"]') is not None)
            ipbook = ctrl.evaluate(
                """async () => (await chrome.storage.local.get('strangerIps')).strangerIps"""
            ) or {}
            expected_ips = len((ipbook.get("ips") or {}))
            check("popup counts the stored stranger IPs",
                  expected_ips >= 2 and ctrl.inner_text("#ipCount") == str(expected_ips),
                  (expected_ips, ctrl.inner_text("#ipCount")))
            ctrl.click("#clearIps")
            time.sleep(0.6)
            check("popup clears the stranger IP memory",
                  ctrl.evaluate(
                      """async () => (await chrome.storage.local.get('strangerIps')).strangerIps"""
                  ) is None and ctrl.inner_text("#ipCount") == "0",
                  ctrl.inner_text("#ipCount"))
            check("popup has the easy skip toggle",
                  ctrl.query_selector('.toggle[data-key="easySkip"]') is not None)
            new_keys = [
                "stealthScreenshot", "stealthRc", "stealthInjection", "stealthHooks",
                "relayOnly", "multiTab", "moderatorMode", "autoNext", "escapeSkip",
                "sbUnblank", "moderationSpoof",
            ]
            missing = [k for k in new_keys if ctrl.query_selector('.toggle[data-key="%s"]' % k) is None]
            check("popup lists all v3.2 toggles", not missing, missing)
            v33_keys = [
                "banBypass", "antiReport", "freshVisitor", "blockRedirects",
                "noLoginGate", "keepPremium", "keepInterests",
            ]
            missing33 = [k for k in v33_keys if ctrl.query_selector('.toggle[data-key="%s"]' % k) is None]
            check("popup lists all v3.3 toggles", not missing33, missing33)
            ctrl.click('.toggle[data-key="relayOnly"]')
            time.sleep(0.5)
            check("popup writes a v3.2 toggle", get_settings().get("relayOnly") is True,
                  get_settings().get("relayOnly"))
            check("v3.2 toggle reaches the page world",
                  h2.eval("window.__umingTest && window.__umingTest.state.relayOnly") is True,
                  h2.eval("window.__umingTest && window.__umingTest.state.relayOnly"))
            ctrl.click('.toggle[data-key="relayOnly"]')
            time.sleep(0.5)
            ctrl.click('.toggle[data-key="banBypass"]')
            time.sleep(0.5)
            check("popup writes a v3.3 toggle", get_settings().get("banBypass") is True,
                  get_settings().get("banBypass"))
            check("v3.3 toggle reaches the page world",
                  h2.eval("window.__umingTest && window.__umingTest.state.banBypass") is True,
                  h2.eval("window.__umingTest && window.__umingTest.state.banBypass"))
            ctrl.click('.toggle[data-key="banBypass"]')
            time.sleep(0.5)

            ctrl.fill("#blockCountries", "US, ID")
            ctrl.dispatch_event("#blockCountries", "change")
            time.sleep(0.4)
            check("popup saves blocked countries",
                  get_settings().get("blockCountries") == ["US", "ID"],
                  get_settings().get("blockCountries"))
            ctrl.fill("#blockCountries", "")
            ctrl.dispatch_event("#blockCountries", "change")
            time.sleep(0.4)
            check("popup clears blocked countries",
                  get_settings().get("blockCountries") == [],
                  get_settings().get("blockCountries"))

            ctrl.fill("#greetText", "yo!|hi!")
            ctrl.dispatch_event("#greetText", "change")
            time.sleep(0.4)
            check("popup saves the greeting",
                  get_settings().get("greetText") == "yo!|hi!", get_settings().get("greetText"))

            ctrl.click('#selfViewSeg button[data-selfview="normal"]')
            time.sleep(0.4)
            check("popup saves self view", get_settings().get("selfView") == "normal",
                  get_settings().get("selfView"))
            check("self view reaches the content page",
                  h2.eval("document.documentElement.classList.contains('utk-self-normal')") is True)
            ctrl.click('#selfViewSeg button[data-selfview="mirror"]')
            time.sleep(0.4)

            # Popup -> content settings sync.
            set_settings({"premium": True})
            time.sleep(0.5)
            ctrl.click('.toggle[data-key="premium"]')
            time.sleep(0.8)
            check("popup toggle writes storage", get_settings().get("premium") is False)
            check("content page reacts to the popup toggle",
                  h2.eval("document.body.classList.contains('is-vip')") is False)
            ctrl.click('.toggle[data-key="premium"]')
            time.sleep(0.6)
            check("popup toggle restores Premium", get_settings().get("premium") is True)

            # Auto-greet on the next accepted match.
            h2.page.click('.cf-option[data-country="ANY"]')
            time.sleep(0.4)
            set_settings({"autoGreet": True, "greetText": "yo!"})
            time.sleep(0.4)
            h2.conn("BR", "Brazil", "greet-1")
            greet = poll(lambda: any(
                isinstance(m, dict) and m.get("event") == "sendMessage" and m.get("message") == "yo!"
                for m in (h2.eval("window.__h.sent") or [])
            ), timeout=6)
            check("auto-greet sends the greeting", bool(greet),
                  (h2.eval("window.__h.sent") or [])[-4:])
            check("auto-greet leaves the input empty",
                  h2.eval("document.querySelector('.messageInput').value") == "",
                  h2.eval("document.querySelector('.messageInput').value"))
            set_settings({"autoGreet": False, "greetText": "hey!|hi!|hello!"})

            # New identity from the popup: the popup button messages the tab.
            check("popup has the New identity button", ctrl.query_selector("#newIdentity") is not None)
            h2.eval("document.cookie='user=popup-old; Max-Age=3600; Path=/'")
            res = ctrl.evaluate(
                """() => new Promise((resolve) => {
                    chrome.tabs.query({ url: 'https://umingle.com/*' }, (tabs) => {
                        if (!tabs || !tabs.length) return resolve({ ok: false, why: 'no-tab' });
                        chrome.tabs.sendMessage(tabs[0].id, { utk: 'identity' }, (r) => {
                            if (chrome.runtime.lastError) {
                                return resolve({ ok: false, why: String(chrome.runtime.lastError) });
                            }
                            resolve(r || { ok: false, why: 'no-reply' });
                        });
                    });
                })"""
            )
            check("popup identity message is accepted", bool(res and res.get("ok")), res)
            check("popup identity clears the visitor cookie",
                  "user=popup-old" not in str(h2.eval("document.cookie")), h2.eval("document.cookie"))
            # The page reloads 420 ms later; let it settle before the next check.
            time.sleep(1.4)
            check("page survived the identity reload",
                  poll(lambda: h2.eval("window.__h && window.__h.ready") is True, timeout=4) is True)

            ctrl.click("#resetStats")
            time.sleep(0.8)
            check("popup Reset stats clears the day", ctrl.inner_text("#statMatches") == "0",
                  ctrl.inner_text("#statMatches"))

            # Update banner: the stored GitHub release info drives the note.
            ctrl.evaluate(
                """async () => {
                    await chrome.storage.local.set({ updateInfo: {
                        latest: '9.9.9', current: '3.6.0', available: true,
                        url: 'https://github.com/alunit3/umingle-toolkit/releases/tag/v9.9.9',
                        checkedAt: Date.now(), error: '',
                    } });
                }"""
            )
            ctrl.reload(wait_until="domcontentloaded")
            ctrl.wait_for_function("document.querySelector('#updateNote').classList.contains('show')")
            check("update banner shows a newer release",
                  ctrl.inner_text("#updateVersion") == "v9.9.9", ctrl.inner_text("#updateVersion"))
            check("update banner links to the release",
                  "releases/tag/v9.9.9" in ctrl.eval_on_selector("#updateLink", "el => el.href"),
                  ctrl.eval_on_selector("#updateLink", "el => el.href"))
            check("popup has an update check button", ctrl.query_selector("#checkUpdate") is not None)
            ctrl.evaluate("async () => { await chrome.storage.local.remove('updateInfo'); }")
            ctrl.reload(wait_until="domcontentloaded")
            ctrl.wait_for_function("document.querySelector('#version')")
            ctrl.wait_for_timeout(500)
            check("update banner hidden without a release",
                  "show" not in ctrl.eval_on_selector("#updateNote", "el => el.className"),
                  ctrl.eval_on_selector("#updateNote", "el => el.className"))

            # Master switch: everything injected disappears.
            set_settings({"enabled": False})
            time.sleep(0.7)
            check("master switch leaves the site theme control alone",
                  h2.eval("!!document.getElementById('toggleDark')") is True)
            check("master switch hides the toolbar",
                  h2.eval("getComputedStyle(document.querySelector('.utk-tools')).display") == "none")
            check("master switch removes the Premium skin",
                  h2.eval("document.body.classList.contains('is-vip')") is False)
            set_settings({"enabled": True})
            time.sleep(0.7)
            check("master switch restores the toolbar",
                  h2.eval("getComputedStyle(document.querySelector('.utk-tools')).display") == "flex")

            # =============================================================
            # 9. Stall auto-skip
            # =============================================================
            reset_settings()
            set_settings({"skipStalled": True, "stallSeconds": 4})
            h3 = Harness(ctx, "p3")
            time.sleep(0.5)
            h3.conn("US", "United States", "stall-1")
            got = poll(lambda: (h3.eval("window.__h.presses") or 0) >= 2, timeout=14)
            check("stall auto-skip leaves a video-less call", got, h3.eval("window.__h.presses"))

            # =============================================================
            # 10. Page stealth: native hooks, ss cover, rc shield, injection
            # =============================================================
            reset_settings()
            h4 = Harness(ctx, "p4")
            time.sleep(0.4)

            check("hooks look native: WebSocket toString",
                  "[native code]" in str(h4.eval("Function.prototype.toString.call(window.WebSocket)")),
                  h4.eval("Function.prototype.toString.call(window.WebSocket)"))
            check("hooks keep WebSocket length", h4.eval("window.WebSocket.length") == 1,
                  h4.eval("window.WebSocket.length"))
            check("hooks keep WebSocket name", h4.eval("window.WebSocket.name") == "WebSocket",
                  h4.eval("window.WebSocket.name"))
            check("socket has no own send",
                  h4.eval("Object.prototype.hasOwnProperty.call(window.__ws, 'send')") is False)
            check("prototype send is masked",
                  "[native code]" in str(h4.eval("Function.prototype.toString.call(WebSocket.prototype.send)")),
                  h4.eval("Function.prototype.toString.call(WebSocket.prototype.send)"))
            check("Blob wrapper is masked",
                  "[native code]" in str(h4.eval("Function.prototype.toString.call(window.Blob)")))

            # ss: the site screenshots document.body; only our UI disappears.
            h4.send({"event": "ss"})
            time.sleep(0.05)
            check("ss hides the toolkit UI",
                  h4.eval("document.documentElement.classList.contains('utk-ss-hide')") is True)
            check("ss cover uses visibility, not layout",
                  h4.eval("getComputedStyle(document.querySelector('.utk-tools')).visibility") == "hidden",
                  h4.eval("getComputedStyle(document.querySelector('.utk-tools')).visibility"))
            shot = poll(lambda: (h4.eval("window.__h.screenshotSends") or 0) >= 1, timeout=6)
            check("page still sends the challenge screenshot", bool(shot),
                  h4.eval("window.__h.screenshotSends"))
            check("ss cover clears after the send",
                  poll(lambda: h4.eval("document.documentElement.classList.contains('utk-ss-hide')") is False,
                       timeout=4) is True)

            set_settings({"stealthScreenshot": False})
            time.sleep(0.5)
            before_shots = h4.eval("window.__h.screenshotSends") or 0
            h4.send({"event": "ss"})
            time.sleep(0.12)
            check("screenshot cover off leaves the UI visible",
                  h4.eval("document.documentElement.classList.contains('utk-ss-hide')") is False)
            check("screenshot cover off still lets ss through",
                  poll(lambda: (h4.eval("window.__h.screenshotSends") or 0) > before_shots,
                       timeout=5) is True)
            set_settings({"stealthScreenshot": True})
            time.sleep(0.4)

            # rc: answer probes from page values, never run server code.
            runs_before = h4.eval("window.__h.rcRuns") or 0
            h4.send({"event": "rc", "code": "navigator.hardwareConcurrency"})
            got = poll(lambda: h4.last_json("evalResult"), timeout=5)
            check("eval shield answers a probe with a real value",
                  bool(got) and isinstance(got.get("result"), int), got)
            check("eval shield keeps the probe from the page",
                  (h4.eval("window.__h.rcRuns") or 0) == runs_before,
                  h4.eval("window.__h.rcRuns"))

            h4.send({"event": "rc", "code": "(window.__h.rcRan = (window.__h.rcRan||0)+1), 42"})
            poll(lambda: (h4.last_json("evalResult") or {}).get("result", "x") is None, timeout=5)
            check("eval shield refuses unknown code with null",
                  (h4.last_json("evalResult") or {}).get("result") is None,
                  h4.last_json("evalResult"))
            check("eval shield never runs server code",
                  (h4.eval("window.__h.rcRan") or 0) == 0, h4.eval("window.__h.rcRan"))

            set_settings({"stealthRc": False})
            time.sleep(0.5)
            h4.send({"event": "rc", "code": "(window.__h.rcRan = (window.__h.rcRan||0)+1), 42"})
            poll(lambda: (h4.eval("window.__h.rcRan") or 0) >= 1, timeout=5)
            check("eval shield off hands the probe to the page",
                  (h4.eval("window.__h.rcRan") or 0) == 1, h4.eval("window.__h.rcRan"))
            set_settings({"stealthRc": True})
            time.sleep(0.4)

            # injection: allowed by default, blocked when the toggle is on.
            h4.send({"event": "injection",
                     "data": "<b id=\"inj-pass\">hi</b><script>window.__h.injectedScriptRan = true;</script>"})
            check("injection reaches the page by default",
                  poll(lambda: h4.eval("!!document.getElementById('inj-pass')"), timeout=4) is True)
            check("injection scripts run by default",
                  h4.eval("window.__h.injectedScriptRan") is True)

            set_settings({"stealthInjection": True})
            time.sleep(0.5)
            h4.send({"event": "injection",
                     "data": "<b id=\"inj-blocked\">no</b><script>window.__h.blockedScript = true;</script>"})
            time.sleep(0.6)
            check("injection block keeps the payload out",
                  h4.eval("!!document.getElementById('inj-blocked')") is False)
            check("injection block stops its scripts",
                  h4.eval("window.__h.blockedScript") in (None, False),
                  h4.eval("window.__h.blockedScript"))
            check("injection block shows a toast",
                  "injected" in str(h4.eval(
                      "document.querySelector('.utk-toasts') && document.querySelector('.utk-toasts').textContent")).lower(),
                  h4.eval("document.querySelector('.utk-toasts') && document.querySelector('.utk-toasts').textContent"))
            set_settings({"stealthInjection": False})
            time.sleep(0.3)

            # Hook masking can be switched off (visible source, same behaviour).
            set_settings({"stealthHooks": False})
            h4.reload()
            time.sleep(0.4)
            check("hooks off shows the wrapper source",
                  "[native code]" not in str(h4.eval("Function.prototype.toString.call(window.WebSocket)")),
                  str(h4.eval("Function.prototype.toString.call(window.WebSocket)"))[:120])
            check("hooks off still watches the socket", h4.eval("window.__h.wsOpen") is True)
            set_settings({"stealthHooks": True})
            h4.reload()
            time.sleep(0.4)
            check("hooks back on look native again",
                  "[native code]" in str(h4.eval("Function.prototype.toString.call(window.WebSocket)")))
            h4.close()

            # =============================================================
            # 11. Session tricks: relay-only, multi-tab, moderator, auto-next
            # =============================================================
            reset_settings()
            set_settings({"relayOnly": True})
            h5 = Harness(ctx, "p5")
            h5.reload()
            time.sleep(0.3)
            h5.eval("window.__makePc()")
            check("relay-only forces relay ICE",
                  h5.eval("window.__pc.getConfiguration().iceTransportPolicy") == "relay",
                  h5.eval("window.__pc.getConfiguration().iceTransportPolicy"))
            set_settings({"relayOnly": False})
            time.sleep(0.4)
            h5.eval("window.__makePc()")
            check("relay-only off uses all ICE",
                  h5.eval("window.__pc.getConfiguration().iceTransportPolicy") == "all",
                  h5.eval("window.__pc.getConfiguration().iceTransportPolicy"))

            # multi-tab: private visitor cookie + private tab channel.
            reset_settings()
            h6 = Harness(ctx, "p6")
            h6.send({"event": "cookie", "id": "u-baseline"})
            time.sleep(0.3)
            check("cookie event stored normally", h6.eval("window.__h.cookies") == 1,
                  h6.eval("window.__h.cookies"))
            check("visitor cookie written normally",
                  "user=u-baseline" in str(h6.eval("document.cookie")), h6.eval("document.cookie"))

            set_settings({"multiTab": True})
            h6.reload()
            time.sleep(0.3)
            check("multi-tab clears the stored visitor cookie",
                  "user=" not in str(h6.eval("document.cookie")), h6.eval("document.cookie"))
            h6.send({"event": "cookie", "id": "u-multitab"})
            time.sleep(0.3)
            check("multi-tab swallows the cookie event", h6.eval("window.__h.cookies") == 0,
                  h6.eval("window.__h.cookies"))
            check("multi-tab keeps the cookie absent",
                  "user=" not in str(h6.eval("document.cookie")), h6.eval("document.cookie"))
            h6.raw("newtab")
            time.sleep(0.3)
            check("multi-tab ignores newtab", h6.eval("window.__h.newtab") == 0,
                  h6.eval("window.__h.newtab"))
            check("multi-tab keeps the tab overlay hidden",
                  h6.eval("getComputedStyle(document.getElementById('multipleTabsOverlay')).display") == "none",
                  h6.eval("getComputedStyle(document.getElementById('multipleTabsOverlay')).display"))

            set_settings({"multiTab": False})
            h6.reload()
            time.sleep(0.2)
            h6.raw("newtab")
            time.sleep(0.3)
            check("newtab works when multi-tab is off", h6.eval("window.__h.newtab") == 1,
                  h6.eval("window.__h.newtab"))
            check("newtab shows the tab overlay",
                  h6.eval("getComputedStyle(document.getElementById('multipleTabsOverlay')).display") == "flex")

            # BroadcastChannel: the site's sibling-tab probe is per tab.
            h8 = Harness(ctx, "p8")
            h9 = Harness(ctx, "p9")
            time.sleep(0.8)
            check("tab channel reaches a sibling tab when multi-tab is off",
                  (h8.eval("window.__h.bcHits") or 0) >= 1, h8.eval("window.__h.bcHits"))
            check("old tab overlay shows when multi-tab is off",
                  h8.eval("getComputedStyle(document.getElementById('multipleTabsOverlay')).display") == "flex")

            set_settings({"multiTab": True})
            h10a = Harness(ctx, "p10a")
            h10a.reload()
            h10b = Harness(ctx, "p10b")
            h10b.reload()
            time.sleep(0.8)
            check("multi-tab isolates the tab channel (first tab)",
                  (h10a.eval("window.__h.bcHits") or 0) == 0, h10a.eval("window.__h.bcHits"))
            check("multi-tab isolates the tab channel (second tab)",
                  (h10b.eval("window.__h.bcHits") or 0) == 0, h10b.eval("window.__h.bcHits"))
            h8.close()
            h9.close()

            # moderator mode: the site's `cm` state, plus the Premium gate.
            reset_settings()
            set_settings({"moderatorMode": True, "premium": False})
            h12 = Harness(ctx, "p12")
            h12.reload()
            time.sleep(0.7)
            check("moderator mode delivers cm", h12.eval("window.__h.cm") is True,
                  h12.eval("window.__h.cmRaw"))
            check("moderator mode draws the Premium skin",
                  h12.eval("document.body.classList.contains('is-vip')") is True)
            h12.eval("localStorage.removeItem('vip_expiry')")
            h12.page.click('.cf-option[data-country="BR"]')
            time.sleep(0.4)
            check("moderator mode passes the country gate",
                  h12.eval("window.__h.checkoutOpens") == 0, h12.eval("window.__h.checkoutOpens"))
            check("moderator mode selects the country",
                  h12.eval("window.__selectedCodes()") == ["BR"], h12.eval("window.__selectedCodes()"))
            h12.page.click('.cf-option[data-country="ANY"]')
            time.sleep(0.4)
            # The BR click saved the filter; clear the saved list explicitly.
            # Otherwise the next reload restores BR, and the restore path also
            # writes vip_expiry, which would make the free-gate check pass for
            # the wrong reason.
            set_settings({"filterCountries": [], "rememberFilter": False})
            time.sleep(0.4)
            check("moderator test cleared the saved filter",
                  get_settings().get("filterCountries") == [] and
                  get_settings().get("rememberFilter") is False,
                  [get_settings().get("filterCountries"), get_settings().get("rememberFilter")])

            set_settings({"moderatorMode": False, "premium": False})
            h12.reload()
            time.sleep(0.6)
            h12.eval("localStorage.removeItem('vip_expiry')")
            check("moderator off delivers no cm", h12.eval("window.__h.cm") is False)
            check("moderator off leaves the Premium skin off",
                  h12.eval("document.body.classList.contains('is-vip')") is False)
            h12.page.click('.cf-option[data-country="JP"]')
            time.sleep(0.4)
            check("moderator off blocks the free country gate",
                  h12.eval("window.__h.checkoutOpens") == 1, h12.eval("window.__h.checkoutOpens"))
            check("moderator off does not select the country",
                  h12.eval("window.__selectedCodes()") == [], h12.eval("window.__selectedCodes()"))

            # auto-next: keep the site's `disabled` flag clear while locked.
            reset_settings()
            h13 = Harness(ctx, "p13")
            time.sleep(0.3)
            check("auto-next keeps the site flag clear",
                  h13.eval("window.disabled = true; String(window.disabled)") == "false",
                  h13.eval("String(window.disabled)"))
            before_search = h13.eval("window.__h.autoSearches") or 0
            h13.end()
            check("auto-next searches after the stranger leaves",
                  poll(lambda: (h13.eval("window.__h.autoSearches") or 0) > before_search,
                       timeout=4) is True, h13.eval("window.__h.autoSearches"))

            set_settings({"autoNext": False})
            h13.reload()
            time.sleep(0.3)
            check("auto-next off stores the site flag",
                  h13.eval("window.disabled = true; String(window.disabled)") == "true",
                  h13.eval("String(window.disabled)"))
            before_search = h13.eval("window.__h.autoSearches") or 0
            h13.end()
            time.sleep(0.6)
            check("auto-next off stops the search",
                  (h13.eval("window.__h.autoSearches") or 0) == before_search,
                  h13.eval("window.__h.autoSearches"))
            set_settings({"autoNext": True})

            # =============================================================
            # 12. sb unblank + moderation snapshot spoof
            # =============================================================
            reset_settings()
            h14 = Harness(ctx, "p14")
            time.sleep(0.4)
            h14.conn("US", "United States", "sb-on-1", sb=True)
            time.sleep(1.0)
            check("shadowban flag reaches the page normally",
                  h14.eval("window.__h.lastSb") is True, h14.eval("window.__h.lastSb"))
            check("shadowban banner shows normally",
                  poll(lambda: h14.eval(
                      "getComputedStyle(document.querySelector('.utk-sb-banner')).display") == "flex",
                      timeout=4) is True)

            set_settings({"sbUnblank": True})
            time.sleep(0.4)
            h14.page.click(".utk-sb-skip")
            time.sleep(0.9)
            h14.conn("US", "United States", "sb-on-2", sb=True)
            time.sleep(1.0)
            check("sb unblank clears the flag for the page",
                  h14.eval("window.__h.lastSb") is False, h14.eval("window.__h.lastSb"))
            check("sb unblank hides the banner",
                  h14.eval("!document.querySelector('.utk-sb-banner') || "
                           "getComputedStyle(document.querySelector('.utk-sb-banner')).display === 'none'") is True,
                  h14.eval("document.querySelector('.utk-sb-banner') && "
                           "getComputedStyle(document.querySelector('.utk-sb-banner')).display"))
            check("sb unblank shows a toast",
                  "shadowban" in str(h14.eval(
                      "document.querySelector('.utk-toasts') && document.querySelector('.utk-toasts').textContent")).lower(),
                  h14.eval("document.querySelector('.utk-toasts') && document.querySelector('.utk-toasts').textContent"))
            h14.close()

            reset_settings()
            h15 = Harness(ctx, "p15")
            time.sleep(0.3)
            neutral_b64 = h15.eval(
                "(() => { const n = window.__umingTest.neutralJpeg();"
                " if (!n) return '';"
                " return btoa(Array.from(n, (b) => String.fromCharCode(b)).join('')); })()")
            check("neutral JPEG is available", bool(neutral_b64), len(neutral_b64 or ""))
            neutral = base64.b64decode(neutral_b64) if neutral_b64 else b""

            h15.eval("window.__moderation()")
            frame = h15.wait_binary(1, timeout=6)
            check("moderation snapshot is a 0x01 frame",
                  bool(frame) and frame[0] == 1, len(frame or b""))
            check("moderation snapshot uses the camera by default",
                  bool(frame) and len(frame) > 200 and frame[1:] != neutral, len(frame or b""))

            set_settings({"moderationSpoof": True})
            time.sleep(0.5)
            h15.eval("window.__moderation()")
            spoofed = poll(lambda: (lambda f: f if f and f[1:] == neutral else None)(h15.binary(1)),
                           timeout=6)
            check("moderation spoof sends the neutral picture",
                  bool(spoofed), len(h15.binary(1) or b""))
            set_settings({"moderationSpoof": False})
            h15.close()

            # =============================================================
            # 13. Escape instant skip
            # =============================================================
            reset_settings()
            h16 = Harness(ctx, "p16")
            time.sleep(0.3)
            h16.conn("US", "United States", "esc-1")
            time.sleep(1.2)
            h16.page.click("header")
            before = h16.eval("window.__h.presses") or 0
            h16.page.keyboard.press("Escape")
            check("Escape instant skip leaves the stranger",
                  poll(lambda: (h16.eval("window.__h.presses") or 0) >= before + 2, timeout=5) is True,
                  h16.eval("window.__h.presses"))

            set_settings({"escapeSkip": False})
            time.sleep(0.4)
            h16.conn("US", "United States", "esc-2")
            time.sleep(1.2)
            h16.page.click("header")
            before = h16.eval("window.__h.presses") or 0
            h16.page.keyboard.press("Escape")
            time.sleep(0.8)
            check("Escape does nothing when the shortcut is off",
                  (h16.eval("window.__h.presses") or 0) == before, h16.eval("window.__h.presses"))
            set_settings({"escapeSkip": True})
            h16.close()

            # =============================================================
            # 14. Ban notices, redirects, login gate, premium, interests
            # =============================================================
            reset_settings()
            time.sleep(0.4)
            h17 = Harness(ctx, "p17")
            time.sleep(0.3)
            h17.send({"event": "banned", "reason": "Under 18", "banId": "ban-17"})
            time.sleep(0.4)
            check("ban notice reaches the page when the switch is off",
                  h17.eval("window.__h.bans") == 1, h17.eval("window.__h.bans"))
            check("the site marks itself banned", h17.eval("window.__h.bannedFlag") is True)
            check("a banned page refuses to search", h17.eval("window.__searchNow()") is False)
            check("the ban overlay is shown", h17.eval(
                "getComputedStyle(document.getElementById('banOverlay')).display") != "none")

            set_settings({"banBypass": True})
            time.sleep(0.4)
            h18 = Harness(ctx, "p18")
            time.sleep(0.3)
            h18.send({"event": "banned", "reason": "Under 18", "banId": "ban-18"})
            time.sleep(0.4)
            check("ban bypass hides the ban from the page",
                  h18.eval("window.__h.bans") == 0, h18.eval("window.__h.bans"))
            check("ban bypass keeps the page unbanned", h18.eval("window.__siteBanned()") is False)
            check("ban bypass leaves the page searchable", h18.eval("window.__searchNow()") is True)
            check("ban bypass lets findPeer through", h18.last_json("findPeer") is not None,
                  h18.last_json("findPeer"))
            check("ban bypass shows the local notice",
                  "ban notice hidden" in str(h18.eval(
                      "(document.querySelector('.utk-toasts') || {}).textContent")).lower() and
                  "change your ip" in str(h18.eval(
                      "(document.querySelector('.utk-toasts') || {}).textContent")).lower(),
                  h18.eval("(document.querySelector('.utk-toasts') || {}).textContent"))
            h18.send({"event": "ageBlock", "reason": "age", "banId": "age-18"})
            time.sleep(0.4)
            check("age block is hidden too", h18.eval("window.__h.ageBlocks") == 0,
                  h18.eval("window.__h.ageBlocks"))
            check("age overlay stays closed", h18.eval(
                "getComputedStyle(document.getElementById('ageVerificationOverlay')).display") == "none")
            # The ban gate stores the last ban; later identity tests must start clean.
            ctrl.evaluate("async () => chrome.storage.local.remove('lastBan')")

            reset_settings()
            set_settings({"blockRedirects": True, "noLoginGate": True,
                          "keepPremium": True, "keepInterests": True})
            time.sleep(0.5)
            h21 = Harness(ctx, "p21")
            time.sleep(0.3)
            h21.send({"event": "redirect", "url": "https://umingle.com/blocked"})
            time.sleep(0.4)
            check("redirect is blocked", h21.eval("window.__h.redirects") == 0,
                  h21.eval("window.__h.redirects"))
            h21.raw("vm")
            time.sleep(0.4)
            check("vm reload is blocked", h21.eval("window.__h.vms") == 0, h21.eval("window.__h.vms"))
            h21.send({"event": "requireLogin"})
            time.sleep(0.4)
            check("login gate is hidden", h21.eval("window.__h.requireLogins") == 0,
                  h21.eval("window.__h.requireLogins"))
            check("login gate leaves search working", h21.eval("window.__searchNow()") is True)
            check("login overlay stays closed", h21.eval(
                "getComputedStyle(document.getElementById('loginOverlay')).display") == "none")
            h21.eval("localStorage.setItem('vip_expiry', String(Date.now() + 3600000))")
            h21.send({"event": "premiumExpired"})
            time.sleep(0.4)
            check("premium expiry is hidden", h21.eval("window.__h.premiumExpireds") == 0,
                  h21.eval("window.__h.premiumExpireds"))
            check("premium expiry keeps the simulated subscription",
                  h21.eval("!!localStorage.getItem('vip_expiry')") is True)
            h21.eval("window.__h.cm = true")
            h21.raw("ncm")
            time.sleep(0.4)
            check("raw ncm is hidden", h21.eval("window.__h.cm") is True, h21.eval("window.__h.cm"))
            h21.send({"event": "clearInterests"})
            time.sleep(0.4)
            check("clearInterests is hidden", h21.eval("window.__h.clearInterests") == 0,
                  h21.eval("window.__h.clearInterests"))
            check("interests survive clearInterests", h21.eval(
                "!!localStorage.getItem('interests')") is True)

            set_settings({"blockRedirects": False, "noLoginGate": False,
                          "keepPremium": False, "keepInterests": False})
            time.sleep(0.5)
            h22 = Harness(ctx, "p22")
            time.sleep(0.3)
            h22.send({"event": "redirect", "url": "https://umingle.com/blocked"})
            time.sleep(0.4)
            check("redirect passes when the switch is off", h22.eval("window.__h.redirects") == 1,
                  h22.eval("window.__h.redirects"))
            h22.raw("vm")
            time.sleep(0.4)
            check("vm passes when the switch is off", h22.eval("window.__h.vms") == 1,
                  h22.eval("window.__h.vms"))
            h22.send({"event": "requireLogin"})
            time.sleep(0.4)
            check("login gate passes when the switch is off",
                  h22.eval("window.__h.requireLogins") == 1, h22.eval("window.__h.requireLogins"))
            check("a login-gated page refuses to search", h22.eval("window.__searchNow()") is False)
            h22.send({"event": "premiumExpired"})
            time.sleep(0.4)
            check("premium expiry reaches the page",
                  h22.eval("window.__h.premiumExpireds") == 1, h22.eval("window.__h.premiumExpireds"))
            h22.send({"event": "clearInterests"})
            time.sleep(0.4)
            check("clearInterests reaches the page",
                  h22.eval("window.__h.clearInterests") == 1, h22.eval("window.__h.clearInterests"))
            check("clearInterests removes the saved interests",
                  h22.eval("localStorage.getItem('interests')") is None,
                  h22.eval("localStorage.getItem('interests')"))
            h22.eval("window.__h.cm = true")
            h22.raw("ncm")
            time.sleep(0.4)
            check("raw ncm reaches the page", h22.eval("window.__h.cm") is False)

            # =============================================================
            # 15. Anti-report
            # =============================================================
            reset_settings()
            set_settings({"antiReport": True})
            time.sleep(0.4)
            h19 = Harness(ctx, "p19")
            time.sleep(0.3)
            check("anti-report hides the site report button",
                  h19.eval("getComputedStyle(document.querySelector('.reportButton')).display") == "none",
                  h19.eval("getComputedStyle(document.querySelector('.reportButton')).display"))
            h19.eval("window.actions.report('peer-9')")
            time.sleep(0.4)
            check("anti-report counts the page attempt", h19.eval("window.__h.reports") == 1,
                  h19.eval("window.__h.reports"))
            check("anti-report drops the report frame", h19.last_json("report") is None,
                  h19.last_json("report"))
            check("anti-report shows the local notice",
                  "Report blocked" in str(h19.eval(
                      "(document.querySelector('.utk-toasts') || {}).textContent")),
                  h19.eval("(document.querySelector('.utk-toasts') || {}).textContent"))
            h19.eval("document.getElementById('confirmBan').click()")
            time.sleep(0.4)
            check("anti-report drops the confirm-button path",
                  h19.last_json("report") is None, h19.last_json("report"))
            set_settings({"antiReport": False})
            time.sleep(0.4)
            check("anti-report restores the site report button",
                  h19.eval("getComputedStyle(document.querySelector('.reportButton')).display") != "none")
            h19.eval("window.actions.report('peer-9')")
            time.sleep(0.4)
            sent_report = h19.last_json("report")
            check("report passes when anti-report is off",
                  bool(sent_report) and sent_report.get("id") == "peer-9", sent_report)

            # =============================================================
            # 16. Fresh visitor per socket
            # =============================================================
            reset_settings()
            set_settings({"freshVisitor": True})
            time.sleep(0.4)
            h20 = Harness(ctx, "p20")
            time.sleep(0.3)
            h20.eval("document.cookie='user=stale-1; Max-Age=3600; Path=/'")
            check("fresh-visitor test cookie is set",
                  "user=stale-1" in str(h20.eval("document.cookie")), h20.eval("document.cookie"))
            h20.eval("window.__connect()")
            time.sleep(0.4)
            check("fresh visitor drops the stored id before the handshake",
                  "user=stale-1" not in str(h20.eval("document.cookie")), h20.eval("document.cookie"))
            set_settings({"freshVisitor": False})
            time.sleep(0.4)
            h20.eval("document.cookie='user=keep-1; Max-Age=3600; Path=/'")
            h20.eval("window.__connect()")
            time.sleep(0.4)
            check("the stored id survives when fresh visitor is off",
                  "user=keep-1" in str(h20.eval("document.cookie")), h20.eval("document.cookie"))

            # =============================================================
            # 17. Multi-tab forceEnd
            # =============================================================
            reset_settings()
            set_settings({"multiTab": True})
            time.sleep(0.4)
            h23 = Harness(ctx, "p23")
            time.sleep(0.3)
            h23.raw("forceEnd")
            time.sleep(0.4)
            check("multi-tab hides forceEnd", h23.eval("window.__h.forceEnds") == 0,
                  h23.eval("window.__h.forceEnds"))
            set_settings({"multiTab": False})
            time.sleep(0.4)
            h23.raw("forceEnd")
            time.sleep(0.4)
            check("forceEnd passes when multi-tab is off", h23.eval("window.__h.forceEnds") == 1,
                  h23.eval("window.__h.forceEnds"))

            # =============================================================
            # 18. New identity
            # =============================================================
            reset_settings()
            time.sleep(0.4)
            h24 = Harness(ctx, "p24")
            time.sleep(0.3)
            check("the toolbar has a New identity button",
                  h24.eval("!!document.querySelector('.utk-tool-identity')") is True)
            h24.page.click(".utk-tool-more")
            time.sleep(0.2)
            check("the More menu lists New identity",
                  "New visitor identity" in str(h24.eval(
                      "document.querySelector('.utk-menu').textContent")),
                  h24.eval("document.querySelector('.utk-menu').textContent"))
            h24.page.click("header")
            h24.eval("document.cookie='user=id-old; Max-Age=3600; Path=/'")
            h24.eval("sessionStorage.setItem('utk-x', '1')")
            check("identity test cookie is set",
                  "user=id-old" in str(h24.eval("document.cookie")), h24.eval("document.cookie"))
            h24.eval("window.__pageMark = 1")
            h24.page.click(".utk-tool-identity")
            time.sleep(0.12)
            check("New identity clears the visitor cookie",
                  "user=id-old" not in str(h24.eval("document.cookie")), h24.eval("document.cookie"))
            check("New identity clears sessionStorage",
                  h24.eval("sessionStorage.getItem('utk-x')") is None,
                  h24.eval("sessionStorage.getItem('utk-x')"))
            check("New identity shows a toast",
                  "New visitor identity" in str(h24.eval(
                      "(document.querySelector('.utk-toasts') || {}).textContent")),
                  h24.eval("(document.querySelector('.utk-toasts') || {}).textContent"))
            check("New identity reloads the page",
                  poll(lambda: h24.eval("typeof window.__pageMark") == "undefined", timeout=5) is True)
            check("the reloaded page is alive",
                  poll(lambda: h24.eval("window.__h && window.__h.ready") is True, timeout=5) is True)
            h24.eval("document.cookie='user=id-hot; Max-Age=3600; Path=/'")
            h24.page.click("header")
            h24.page.keyboard.press("n")
            time.sleep(0.15)
            check("N is the New identity hotkey",
                  "user=id-hot" not in str(h24.eval("document.cookie")), h24.eval("document.cookie"))
            time.sleep(0.8)

            check("no uncaught page errors", not [e for e in PAGE_ERRORS if "favicon" not in e.lower()],
                  PAGE_ERRORS[:5])

            ctx.close()

    report["fails"] = FAILS
    report["total"] = len(CHECKS)
    report["passed"] = sum(1 for c in CHECKS if c["ok"])
    (ROOT / "test" / "ext_test_report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print("\n%d/%d checks passed" % (report["passed"], report["total"]))
    if FAILS:
        print("FAILURES:")
        for f in FAILS:
            print(" -", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
