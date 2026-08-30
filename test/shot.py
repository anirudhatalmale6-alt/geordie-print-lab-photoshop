"""
Screenshot the panel as it actually renders, with the preview painted.

Numbers in a test report do not show a smudged logo or a swatch row that
wraps badly. This does.
"""
import http.server
import json
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "panel.png")


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
    # Well under the 2000px limit in both directions.
    pg = b.new_page(viewport={"width": 360, "height": 940}, device_scale_factor=2)
    pg.goto(f"http://127.0.0.1:{PORT}/_panel.html", wait_until="domcontentloaded")
    pg.wait_for_timeout(700)

    pg.fill("#key", "gpl-t5g26 65vkz-hxkxj 76p4p")
    pg.click("#unlock")
    pg.wait_for_timeout(600)

    pg.check('[data-k="halftone"]')
    pg.check('[data-k="inkEnabled"]')
    pg.click('#swatches button[data-ink="#c8102e"]')

    # Garment behind it, so the preview shows the job rather than the artwork.
    pg.check('[data-k="shirtPreview"]')
    pg.fill("#shirt-hex", "#e8e4dc")
    pg.dispatch_event("#shirt-hex", "change")

    pg.click("#preview")
    pg.wait_for_timeout(3000)

    pg.screenshot(path=OUT)
    print("wrote " + OUT)
    b.close()
