from pathlib import Path
src = Path("/tmp/server.ts")
dst = Path("/opt/bismillah/current/apps/api/src/server.ts")
dst.write_bytes(src.read_bytes().replace(b"\r\n", b"\n"))
print("wrote", dst)
