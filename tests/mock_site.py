"""Web falsa para probar el motor: python tests/mock_site.py  (puerto 8001)"""
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

SERIES = {
    "re-zero": ("Re:Zero", 3),
    "frieren": ("Frieren", 3),
    "dandadan": ("Dandadan", 3),
    "longrun": ("Long Run", 30),
}


class H(BaseHTTPRequestHandler):
    def _send(self, code, body):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/catalogo":
            q = parse_qs(u.query).get("search", [""])[0].lower()
            cards = "".join(
                f'<div class="card"><a href="/blabla/{s}"><img src="/img/{s}.jpg"><span class="card-title">{n}</span></a></div>'
                for s, (n, _) in SERIES.items() if q in n.lower())
            return self._send(200, f"<html><body>{cards}</body></html>")
        m = re.fullmatch(r"/blabla/([\w-]+)", u.path)
        if m and m[1] in SERIES:
            eps = "".join(f'<a href="/blabla/{m[1]}/{i}">Episodio {i}</a>' for i in range(1, SERIES[m[1]][1] + 1))
            return self._send(200, f"<html><body><div class='episodes'>{eps}</div></body></html>")
        m = re.fullmatch(r"/blabla/([\w-]+)/(\d+)", u.path)
        if m and m[1] in SERIES and int(m[2]) <= SERIES[m[1]][1]:
            return self._send(200, "<html><body><video src='x.mp4'></video></body></html>")
        self._send(404, "<html><body>No encontrado</body></html>")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8001), H).serve_forever()
