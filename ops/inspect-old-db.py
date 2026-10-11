import sqlite3
import os

paths = [
    "/home/ubuntu/bismillah-crm/bismillah_networks.db",
    "/home/ubuntu/bismillah-crm/Bismillah Netwoks",
]
db = "/home/ubuntu/bismillah-crm/bismillah_networks.db"
print("size", os.path.getsize(db))
con = sqlite3.connect(db)
tables = con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
print("tables", tables)
for (t,) in tables:
    c = con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
    cols = [x[1] for x in con.execute(f'PRAGMA table_info("{t}")')]
    print(t, c, cols)
    if c and c < 5:
        print(" sample", con.execute(f'SELECT * FROM "{t}" LIMIT 2').fetchall())
    elif c:
        print(" sample", con.execute(f'SELECT * FROM "{t}" LIMIT 1').fetchall())
