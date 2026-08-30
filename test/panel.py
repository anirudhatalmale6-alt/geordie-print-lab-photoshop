"""
Drives the real index.html and index.js in a browser, with Photoshop and UXP
stubbed out.

This is not a claim that the plugin works in Photoshop - it cannot be. It is
the layer underneath: that every control is wired to a setting that exists,
that the gate actually gates, that Apply reaches the engine, and that a refused
key puts the customer back at the door. Those are the things that break when a
selector is renamed, and none of them need Photoshop to be wrong.
"""
import http.server
import json
import os
import re
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 0   # let the OS pick, so a stale run cannot block this one

fails = []
oks = 0


def check(label, cond):
    global oks
    print(('  ok    ' if cond else '  FAIL  ') + label)
    if cond:
        oks += 1
    else:
        fails.append(label)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

# A CommonJS shim plus fake photoshop/uxp, injected before index.js runs.
SHIM = r"""
window.__calls = [];
window.__licenceReply = { valid: true, reason: 'ok', plan: 'month', expires: '2026-09-30', trial: false };
window.__store = {};

const DOC = {
  id: 7, name: 'art.psd', mode: 'RGBColor', bitsPerChannel: 8,
  width: 1200, height: 900, resolution: 300,
  activeLayers: [ { id: 3, name: 'Layer 1', kind: 'pixel', locked: false } ]
};
window.__doc = DOC;
window.__noDoc = false;

const photoshop = {
  get app() { return { get activeDocument() { return window.__noDoc ? null : DOC; } }; },
  core: {
    executeAsModal: (fn, o) => {
      window.__calls.push({ modal: o.commandName });
      return Promise.resolve(fn({ hostControl: {
        suspendHistory: () => Promise.resolve(1),
        resumeHistory: () => Promise.resolve()
      } }));
    }
  },
  imaging: {
    getPixels: (o) => {
      window.__calls.push({ getPixels: JSON.parse(JSON.stringify(o)) });
      const w = o.targetSize ? o.targetSize.width : DOC.width;
      const h = o.targetSize ? o.targetSize.height : DOC.height;
      const buf = new Uint8Array(w * h * 4);
      for (let i = 0; i < buf.length; i++) buf[i] = (i * 13) % 256;
      return Promise.resolve({ imageData: {
        width: w, height: h,
        getData: () => Promise.resolve(buf),
        dispose: () => {}
      } });
    },
    createImageDataFromBuffer: (buf, o) => {
      window.__calls.push({ create: o, sum: buf.reduce((a, b) => (a + b) % 1000003, 0) });
      return { dispose: () => {} };
    },
    putPixels: (o) => { window.__calls.push({ putPixels: o.layerID }); return Promise.resolve(); }
  },
  action: { addNotificationListener: () => {} }
};

const uxp = { storage: {} };   // no secureStorage -> exercises the localStorage fallback

window.localStorage.clear();

window.fetch = (url, opts) => {
  window.__calls.push({ fetch: url, body: JSON.parse(opts.body) });
  const r = window.__licenceReply;
  if (r === 'network') return Promise.reject(new Error('down'));
  return Promise.resolve({ status: r.__status || 200, json: () => Promise.resolve(r) });
};

const MODULES = { photoshop, uxp };
window.__define = (name, factory) => {
  const module = { exports: {} };
  factory(module, module.exports);
  MODULES['./' + name] = module.exports;
  MODULES[name] = module.exports;
};
window.require = (n) => {
  if (MODULES[n]) return MODULES[n];
  throw new Error('no module ' + n);
};
"""

MODULE_FILES = ["engine.js", "licence.js", "studio.js", "bridge.js"]


def build_page():
    html = open(os.path.join(ROOT, "index.html")).read()
    # strip the module script tag; we inject the modules ourselves in order
    html = html.replace('<script src="index.js"></script>', "")
    parts = [f"<script>{SHIM}</script>"]
    for f in MODULE_FILES:
        src = open(os.path.join(ROOT, f)).read()
        parts.append(
            "<script>window.__define(%s, function(module, exports){\n%s\n});</script>"
            % (json.dumps(f), src)
        )
    idx = open(os.path.join(ROOT, "index.js")).read()
    parts.append("<script>(function(){\n%s\n})();</script>" % idx)
    html = html.replace("</body>", "\n".join(parts) + "\n</body>")
    open(os.path.join(ROOT, "_panel.html"), "w").write(html)


build_page()

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 380, "height": 900})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    pg.goto(f"http://127.0.0.1:{PORT}/_panel.html", wait_until="domcontentloaded")
    pg.wait_for_timeout(700)

    check("the panel loads with no script errors: " + ("; ".join(errors[:2]) or "none"), not errors)

    # --- every control must map to a real setting -----------------------
    keys = pg.eval_on_selector_all("[data-k]", "els => els.map(e => e.getAttribute('data-k'))")
    defaults = pg.evaluate("() => require('studio.js').defaults()")
    engine_keys = pg.evaluate("() => require('studio.js').ENGINE_KEYS")
    unknown = [k for k in keys if k not in defaults]
    check("every control maps to a real setting" + (" (%s)" % unknown if unknown else ""), not unknown)
    check("%d controls on the panel" % len(keys), len(keys) >= 20)

    # A control the engine never reads is a dial that does nothing.
    inert = [k for k in keys if k not in engine_keys]
    check("no control is inert" + (" (%s)" % inert if inert else ""), not inert)

    # --- the gate ------------------------------------------------------
    # It opened with a good stubbed reply and no stored key, so it should be
    # at the door: check() with no key returns 'no-key' before any fetch.
    check("with no key stored, the door is shut", pg.is_visible("#gate") and pg.is_hidden("#tool"))

    pg.fill("#key", "not a key")
    pg.click("#unlock")
    pg.wait_for_timeout(300)
    calls = pg.evaluate("() => window.__calls.filter(c => c.fetch).length")
    check("a malformed key is refused without a network call", calls == 0)
    check("and the customer is told why", "GPL-" in pg.inner_text("#gate-msg"))

    pg.fill("#key", "gpl-t5g26 65vkz-hxkxj 76p4p")
    pg.click("#unlock")
    pg.wait_for_timeout(500)
    check("a good key opens the tool", pg.is_visible("#tool") and pg.is_hidden("#gate"))
    body = pg.evaluate("() => window.__calls.filter(c => c.fetch).slice(-1)[0].body")
    check("the key is sent tidied up", body["key"] == "GPLT5G2665VKZHXKXJ76P4P".replace("GPL", "GPL"))
    check("a device id is sent", len(body.get("device", "")) >= 16)
    check("the membership is shown", "Monthly" in pg.inner_text("#plan"))
    check("the document is described", "art.psd" in pg.inner_text("#doc"))

    # --- applying ------------------------------------------------------
    pg.evaluate("() => window.__calls.length = 0")
    pg.check('[data-k="halftone"]')
    pg.click("#apply")
    pg.wait_for_timeout(2500)

    put = pg.evaluate("() => window.__calls.filter(c => c.putPixels).length")
    got = pg.evaluate("() => window.__calls.filter(c => c.getPixels).length")
    check("Apply reads the layer once", got == 1)
    check("Apply writes back once", put == 1)
    check("it says it is done", "Done" in pg.inner_text("#status"))
    check("the membership is re-checked on Apply, not just at start-up",
          pg.evaluate("() => window.__calls.filter(c => c.fetch).length") >= 1)

    # the halftone actually did something to the bytes
    checksum = pg.evaluate("() => window.__calls.find(c => c.create).sum")
    pg.evaluate("() => window.__calls.length = 0")
    pg.uncheck('[data-k="halftone"]')
    pg.click("#apply")
    pg.wait_for_timeout(2500)
    plain = pg.evaluate("() => (window.__calls.find(c => c.create) || {}).sum")
    check("turning the halftone off produces different pixels", checksum != plain)

    # --- a lapsed membership mid-session -------------------------------
    pg.evaluate("() => { window.__licenceReply = { valid: false, reason: 'membership_inactive' }; }")
    pg.evaluate("() => window.__calls.length = 0")
    pg.click("#apply")
    pg.wait_for_timeout(800)
    check("a membership that lapsed mid-session shuts the door", pg.is_visible("#gate"))
    check("and nothing was written", pg.evaluate("() => window.__calls.filter(c => c.putPixels).length") == 0)
    check("and the key is still remembered for when they pay",
          pg.evaluate("() => localStorage.getItem('printlab.licence.key')") is not None)

    # --- guards --------------------------------------------------------
    pg.evaluate("() => { window.__licenceReply = { valid: true, reason: 'ok', plan: 'year', expires: '2027-01-01', trial: false }; }")
    pg.fill("#key", "gpl-t5g26-65vkz-hxkxj-76p4p")
    pg.click("#unlock")
    pg.wait_for_timeout(500)
    pg.evaluate("() => { window.__doc.mode = 'CMYKColor'; }")
    pg.evaluate("() => window.__calls.length = 0")
    pg.click("#apply")
    pg.wait_for_timeout(800)
    check("a CMYK document is refused", "RGB" in pg.inner_text("#status"))
    check("and no pixels were read", pg.evaluate("() => window.__calls.filter(c => c.getPixels).length") == 0)

    # --- is every word on the panel actually readable? -----------------
    # Reading the stylesheet cannot tell you which rule won, so ask the
    # browser what it painted and work the ratio out from that.
    contrast = pg.evaluate("""() => {
      const lum = (c) => {
        const [r,g,b] = c.match(/\\d+/g).slice(0,3).map(Number).map(v => {
          v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
        });
        return 0.2126*r + 0.7152*g + 0.0722*b;
      };
      const bgOf = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c;
        }
        return 'rgb(255,255,255)';
      };
      const out = [];
      document.querySelectorAll('#tool *').forEach(el => {
        if (!el.offsetParent) return;
        const t = Array.from(el.childNodes).filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim()).join(' ').trim();
        if (!t) return;
        const st = getComputedStyle(el);
        const a = lum(st.color), b = lum(bgOf(el));
        const ratio = (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
        out.push({ text: t.slice(0, 28), ratio: Math.round(ratio * 100) / 100,
                   size: parseFloat(st.fontSize) });
      });
      return out;
    }""")
    worst = sorted(contrast, key=lambda c: c["ratio"])[:3]
    for w in worst:
        print("    %-30s %.2f:1 at %gpx" % (w["text"], w["ratio"], w["size"]))
    bad = [c for c in contrast if c["ratio"] < 4.5]
    check("%d text elements measured, all at least 4.5:1%s" % (
        len(contrast), (" - worst %s at %.2f" % (bad[0]["text"], bad[0]["ratio"])) if bad else ""),
        len(contrast) >= 15 and not bad)

    # --- nothing may be cut off ----------------------------------------
    clipped = pg.evaluate("""() => Array.from(document.querySelectorAll('#tool select, #tool button, #tool output'))
      .filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1)
      .map(e => (e.tagName + ':' + (e.value || e.textContent || '').trim()))""")
    check("nothing on the panel is cut off" + (" (%s)" % clipped if clipped else ""), not clipped)

    pg.screenshot(path=os.path.join(ROOT, "test", "panel-tool.png"))
    pg.evaluate("() => { window.__doc.mode = 'RGBColor'; }")
    pg.click("#signout")
    pg.wait_for_timeout(300)
    check("sign out shuts the door", pg.is_visible("#gate"))
    check("and forgets the key", pg.evaluate("() => localStorage.getItem('printlab.licence.key')") is None)
    pg.screenshot(path=os.path.join(ROOT, "test", "panel-gate.png"))

    b.close()

httpd.shutdown()

if oks + len(fails) < 26:
    fails.append("only %d checks ran, expected at least 26" % (oks + len(fails)))

print("\n" + ("%d FAILED of %d" % (len(fails), oks + len(fails)) if fails else "PANEL: ALL %d PASSED" % oks))
for f in fails:
    print(" -", f)
sys.exit(1 if fails else 0)
