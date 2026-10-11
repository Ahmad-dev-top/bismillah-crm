import json
import urllib.error
import urllib.request
from pathlib import Path

pw = None
for line in Path("/etc/bismillah/admin-once.txt").read_text().splitlines():
    if line.startswith("password="):
        pw = line.split("=", 1)[1]
        break
if not pw:
    raise SystemExit("no password file")

def post(email, password):
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:3010/api/auth/login",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            data = json.loads(res.read().decode())
            print(res.status, "token" in data, data.get("role"))
    except urllib.error.HTTPError as e:
        print(e.code, e.read().decode())

print("wrong:")
post("admin@localhost", "nope")
print("ok:")
post("admin@localhost", pw)
