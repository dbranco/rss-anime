"""Supabase falso (auth + PostgREST mínimo + storage) para probar sync y cron. Puerto 8002."""
import json, re, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from datetime import datetime, timezone

SERVICE = "service-key"
TABLES, STORAGE, USERS = {}, {}, {}


def uid_for(email):
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, email))


def now():
    return datetime.now(timezone.utc).isoformat()


class H(BaseHTTPRequestHandler):
    def send(self, code, obj=None, raw=None, ctype="application/json"):
        body = raw if raw is not None else (b"" if obj is None else json.dumps(obj).encode())
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def who(self):
        a = self.headers.get("Authorization", "")
        if a == f"Bearer {SERVICE}":
            return "service", None
        m = re.fullmatch(r"Bearer tok-(.+)", a)
        return ("user", uid_for(m[1])) if m else (None, None)

    def session(self, email):
        return {"access_token": f"tok-{email}", "refresh_token": f"r-{email}", "expires_in": 3600,
                "user": {"id": uid_for(email), "email": email}}

    def do_POST(self):
        u = urlparse(self.path)
        data = self.body()
        if u.path == "/auth/v1/signup":
            j = json.loads(data)
            USERS[j["email"]] = j["password"]
            return self.send(200, self.session(j["email"]))
        if u.path == "/auth/v1/token":
            j = json.loads(data)
            if parse_qs(u.query)["grant_type"][0] == "refresh_token":
                return self.send(200, self.session(j["refresh_token"][2:]))
            if USERS.get(j["email"]) != j["password"]:
                return self.send(400, {"msg": "Invalid login credentials"})
            return self.send(200, self.session(j["email"]))
        m = re.fullmatch(r"/storage/v1/object/feeds/(.+)", u.path)
        if m:
            if self.who()[0] != "service":
                return self.send(403, {"message": "forbidden"})
            STORAGE[m[1]] = data
            return self.send(200, {"Key": m[1]})
        m = re.fullmatch(r"/rest/v1/(\w+)", u.path)
        if m:
            kind, uid = self.who()
            if not kind:
                return self.send(401, {"message": "no auth"})
            q = parse_qs(u.query)
            pk = q["on_conflict"][0].split(",")
            prefer = self.headers.get("Prefer", "")
            table = TABLES.setdefault(m[1], [])
            is_admin = uid in {r.get("user_id") for r in TABLES.get("admins", [])}
            for row in json.loads(data):
                if m[1] == "app_config":
                    if kind == "user" and not is_admin:
                        return self.send(403, {"message": "RLS: solo admin puede escribir app_config"})
                elif kind == "user" and row.get("user_id") != uid:
                    return self.send(403, {"message": "RLS: new row violates policy"})
                cur = next((r for r in table if all(r.get(k) == row.get(k) for k in pk)), None)
                if cur:
                    if "ignore-duplicates" not in prefer:
                        cur.update(row)
                else:
                    row = dict(row)
                    if m[1] == "user_settings":
                        row.setdefault("feed_token", uuid.uuid4().hex)
                        row.setdefault("updated_at", now())
                    if m[1] == "episodes_found":
                        row.setdefault("found_at", now())
                    table.append(row)
            return self.send(201)
        self.send(404, {"message": "not found"})

    def do_GET(self):
        u = urlparse(self.path)
        m = re.fullmatch(r"/storage/v1/object/public/feeds/(.+)", u.path)
        if m:
            if m[1] not in STORAGE:
                return self.send(404, {"message": "not found"})
            return self.send(200, raw=STORAGE[m[1]], ctype="application/rss+xml")
        m = re.fullmatch(r"/rest/v1/(\w+)", u.path)
        if m:
            kind, uid = self.who()
            if not kind:
                return self.send(401, {"message": "no auth"})
            rows = list(TABLES.get(m[1], []))
            if kind == "user" and m[1] != "app_config":  # simula RLS (app_config: lectura abierta)
                rows = [r for r in rows if r.get("user_id") == uid]
            q = parse_qs(u.query)
            for col, vals in q.items():
                if col in ("select", "order", "limit"):
                    continue
                if vals[0].startswith("eq."):
                    want = vals[0][3:]
                    rows = [r for r in rows if str(r.get(col)).lower() == want.lower()]
            if "order" in q:
                col, _, d = q["order"][0].partition(".")
                rows.sort(key=lambda r: str(r.get(col)), reverse=(d == "desc"))
            if "limit" in q:
                rows = rows[: int(q["limit"][0])]
            return self.send(200, rows)
        self.send(404, {"message": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8002), H).serve_forever()
