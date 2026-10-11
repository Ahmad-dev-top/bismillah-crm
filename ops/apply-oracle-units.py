from pathlib import Path

pairs = [
    ("/tmp/bi-api.oracle.service", "/etc/systemd/system/bi-api.service"),
    ("/tmp/bi-worker.oracle.service", "/etc/systemd/system/bi-worker.service"),
    ("/tmp/package.json", "/opt/bismillah/current/apps/api/package.json"),
]
for src, dst in pairs:
    data = Path(src).read_bytes().replace(b"\r\n", b"\n")
    Path(dst).write_bytes(data)
    print("wrote", dst)
