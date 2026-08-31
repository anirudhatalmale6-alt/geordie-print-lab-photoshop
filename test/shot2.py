"""
Screenshots of the new controls in the Photoshop panel.

Runs against the same stubbed harness the panel tests use - _panel.html, which
test/panel.py writes. So this is the real index.html, the real index.js and the
real stylesheet, with Photoshop faked underneath. It is a picture of the panel,
not a picture of Photoshop.
"""
import http.server
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else ROOT


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 360, "height": 940}, device_scale_factor=2)
    pg.goto(f"http://127.0.0.1:{PORT}/_panel.html", wait_until="domcontentloaded")
    pg.wait_for_timeout(700)

    # An allowance and a colour book, so the panel is shown as a customer with
    # a live membership actually sees it rather than mid-handshake.
    pg.evaluate("""() => {
        window.__licenceReply = Object.assign({}, window.__licenceReply, {
            upscales: { left: 7, monthly: 20, used: 13, extra: 0, period: '2026-08' },
            garments: [ { name: 'Heather Sapphire', code: 'GD001-HSA', hex: '#4f7fa8' } ]
        });
    }""")

    pg.fill("#key", "gpl-t5g26 65vkz-hxkxj 76p4p")
    pg.click("#unlock")
    pg.wait_for_timeout(700)

    pg.evaluate("() => document.querySelectorAll('details').forEach(d => { d.open = true; })")

    pg.check('[data-k="halftone"]')
    pg.select_option('[data-k="screenSource"]', "garment")
    pg.click('#garments button[data-g="#b5202e"]')          # red garment
    pg.wait_for_timeout(400)

    for k, v in [("brightness", 12), ("contrast", 28), ("lightRed", -45),
                 ("lightYellow", 25), ("lightBlue", -20), ("lightMagenta", 35)]:
        pg.evaluate("""([k, v]) => {
            const el = document.querySelector('[data-k="' + k + '"]');
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }""", [k, v])
    pg.wait_for_timeout(300)

    def shot(name, anchor):
        pg.evaluate("""(sel) => {
            document.querySelector(sel).scrollIntoView({ block: 'start' });
        }""", anchor)
        pg.wait_for_timeout(300)
        pg.screenshot(path=os.path.join(OUT, name))
        print("wrote " + name)

    shot("ps-1-garment.png", ".preview .cap")
    shot("ps-2-halftone.png", '[data-k="screenSource"]')
    shot("ps-3-bycolour.png", '[data-k="lightRed"]')

    b.close()

httpd.shutdown()
