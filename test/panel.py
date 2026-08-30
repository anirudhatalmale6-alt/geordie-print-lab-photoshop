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

    # A control nothing reads is a dial that does nothing. Most feed the
    # engine; a few are the panel's own (the garment colour behind the
    # preview is never printed, so the engine must never see it). Both count
    # as wired - being read by NEITHER does not.
    panel_src = open(os.path.join(ROOT, "index.js"), encoding="utf-8").read()
    inert = [
        k for k in keys
        if k not in engine_keys
        and not re.search(r"\bS\.%s\b" % re.escape(k), panel_src)
    ]
    check("no control is inert" + (" (%s)" % inert if inert else ""), not inert)

    # The colour boxes are not data-k, so they would slip past the sweep above.
    hex_keys = pg.eval_on_selector_all(
        "[data-hex]", "els => els.map(e => e.getAttribute('data-hex'))")
    check("%d colour boxes, all real settings" % len(hex_keys),
          len(hex_keys) >= 2 and all(k in defaults for k in hex_keys))

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

    # --- ink colour and the preview ------------------------------------
    pg.check('[data-k="halftone"]')
    pg.check('[data-k="inkEnabled"]')

    # The setting itself is module-private, and rather than open a hole in the
    # plugin to look at it, every claim below is checked where it shows: on
    # the box, on the swatch, and finally in the painted pixels.
    pg.click('#swatches button[data-ink="#c8102e"]')
    check("a swatch fills the hex box", pg.input_value("#ink-hex").lower() == "#c8102e")
    check("and exactly one swatch shows as chosen",
          pg.evaluate("() => document.querySelectorAll('#swatches .is-on').length") == 1)

    # Deliberately a colour that is NOT one of the swatches, so the
    # selection has something to clear.
    pg.fill("#ink-hex", "#7a2f8a")
    pg.dispatch_event("#ink-hex", "change")
    check("typing a colour outside the swatches clears the selection",
          pg.evaluate("() => document.querySelectorAll('#swatches .is-on').length") == 0)

    # A half-typed hex must be refused outright. Accepting "#12" as some
    # colour would print something nobody picked.
    pg.fill("#ink-hex", "#12")
    pg.dispatch_event("#ink-hex", "change")
    check("a half-typed hex is rejected and the box put back",
          pg.input_value("#ink-hex").lower() == "#7a2f8a")

    pg.evaluate("() => window.__calls.length = 0")
    pg.click("#preview")
    pg.wait_for_timeout(2500)

    check("preview reads the layer", pg.evaluate("() => window.__calls.filter(c => c.getPixels).length") == 1)
    # The whole point of preview being separate from apply.
    check("preview writes nothing to the document",
          pg.evaluate("() => window.__calls.filter(c => c.putPixels).length") == 0)

    # Measure the canvas rather than trusting the status line: count the
    # pixels actually painted in the chosen ink.
    painted = pg.evaluate("""() => {
        const c = document.getElementById('pv');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let ink = 0, other = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i] === 122 && d[i+1] === 47 && d[i+2] === 138) ink++;
            else other++;
        }
        return { ink, other };
    }""")
    check("the preview canvas is painted in the chosen ink (%d px)" % painted["ink"],
          painted["ink"] > 200)
    check("and it is not a solid block of it", painted["other"] > 200)

    # Turning the ink off must repaint in something else, or the canvas is
    # showing a stale picture.
    pg.uncheck('[data-k="inkEnabled"]')
    pg.click("#preview")
    pg.wait_for_timeout(2500)
    after = pg.evaluate("""() => {
        const c = document.getElementById('pv');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i] === 122 && d[i+1] === 47 && d[i+2] === 138) ink++;
        }
        return ink;
    }""")
    check("turning the ink off repaints without it (%d px left)" % after, after < painted["ink"] / 4)

    # --- garment colour --------------------------------------------------
    #
    # Counting a specific colour on the canvas, because "the checkbox is
    # ticked" would pass on a backdrop that was never drawn.
    def count(rgb):
        return pg.evaluate("""(c) => {
            const cv = document.getElementById('pv');
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] === c[0] && d[i+1] === c[1] && d[i+2] === c[2] && d[i+3] === 255) n++;
            }
            return n;
        }""", list(rgb))

    NAVY, ROYAL = (0x1b, 0x2a, 0x44), (0x1d, 0x4f, 0x91)

    check("there is a row of garment colours (%d)" %
          pg.evaluate("() => document.querySelectorAll('#garments button').length"),
          pg.evaluate("() => document.querySelectorAll('#garments button').length") == 16)
    check("none is chosen until one is pressed",
          pg.evaluate("() => document.querySelectorAll('#garments .is-on').length") == 0)
    check("and no garment is showing yet (%d navy px)" % count(NAVY), count(NAVY) == 0)

    pg.evaluate("() => window.__calls.length = 0")
    pg.click('#garments button[data-g="#1b2a44"]')
    pg.wait_for_timeout(400)

    check("one press paints the garment behind the artwork (%d navy px)" % count(NAVY),
          count(NAVY) > 500)
    check("  and it did not have to run the engine again to do it",
          pg.evaluate("() => window.__calls.length") == 0)
    check("the switch came on by itself", pg.is_checked('[data-k="shirtPreview"]'))
    check("the hex box followed the swatch", pg.input_value("#shirt-hex").lower() == "#1b2a44")
    check("exactly one garment shows as chosen",
          pg.evaluate("() => document.querySelectorAll('#garments .is-on').length") == 1)

    # A second colour, so the first is not a constant.
    pg.click('#garments button[data-g="#1d4f91"]')
    pg.wait_for_timeout(400)
    check("a second colour replaces the first (%d royal, %d navy left)"
          % (count(ROYAL), count(NAVY)),
          count(ROYAL) > 500 and count(NAVY) == 0)

    # The claim printed under the control.
    check("changing the garment never writes to the document",
          pg.evaluate("() => window.__calls.filter(c => c.putPixels).length") == 0)

    pg.uncheck('[data-k="shirtPreview"]')
    pg.wait_for_timeout(400)
    check("switching it off takes the garment away (%d royal left)" % count(ROYAL),
          count(ROYAL) == 0)
    check("and no garment is marked once it is off",
          pg.evaluate("() => document.querySelectorAll('#garments .is-on').length") == 0)

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
