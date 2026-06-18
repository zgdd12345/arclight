import sqlite3

from starlette.testclient import TestClient

from arclight_core.server.app import create_app
from arclight_core.server.settings import Settings

# Real on-disk schema (subset) matching packages/core/src/db/migrations/0000_*.sql,
# with the FK cascade clauses the DELETE handler relies on.
_SCHEMA = [
    "CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT DEFAULT 'local' NOT NULL, "
    "name TEXT NOT NULL, repo_path TEXT NOT NULL, arclight_dir TEXT, "
    "created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, "
    "updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL)",
    "CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, "
    "FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE)",
    "CREATE TABLE turns (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, "
    "FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE)",
]


def _seed(tmp_path, *, sessions=(), turns=()):
    db = tmp_path / "arclight.sqlite"
    conn = sqlite3.connect(str(db))
    for stmt in _SCHEMA:
        conn.execute(stmt)
    conn.execute(
        "INSERT INTO workspaces (id, name, repo_path, arclight_dir) VALUES ('w1','alpha','/p/alpha','/p/alpha/.arclight')"
    )
    for sid, wsid in sessions:
        conn.execute("INSERT INTO sessions (id, workspace_id) VALUES (?,?)", (sid, wsid))
    for tid, sid, status in turns:
        conn.execute("INSERT INTO turns (id, session_id, status) VALUES (?,?,?)", (tid, sid, status))
    conn.commit()
    conn.close()
    return db


def _client(db, tmp_path):
    s = Settings(db_path=str(db), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    return TestClient(create_app(s))


def test_patch_renames(tmp_path):
    db = _seed(tmp_path)
    c = _client(db, tmp_path)
    r = c.patch("/api/projects/w1", json={"name": "  beta  "})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    conn = sqlite3.connect(str(db))
    assert conn.execute("SELECT name FROM workspaces WHERE id='w1'").fetchone()[0] == "beta"  # trimmed
    conn.close()


def test_patch_truncates_to_60_chars(tmp_path):
    db = _seed(tmp_path)
    c = _client(db, tmp_path)
    long = "x" * 100
    c.patch("/api/projects/w1", json={"name": long})
    conn = sqlite3.connect(str(db))
    assert conn.execute("SELECT name FROM workspaces WHERE id='w1'").fetchone()[0] == "x" * 60
    conn.close()


def test_patch_empty_name_is_400(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/projects/w1", json={"name": "   "})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "code": "VALIDATION", "message": "name required"}


def test_patch_unknown_id_is_404(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/projects/nope", json={"name": "beta"})
    assert r.status_code == 404
    assert r.json() == {"ok": False, "code": "NOT_FOUND"}


def test_patch_missing_db_is_404(tmp_path):
    s = Settings(db_path=str(tmp_path / "absent.sqlite"), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    r = TestClient(create_app(s)).patch("/api/projects/w1", json={"name": "beta"})
    assert r.status_code == 404
    assert not (tmp_path / "absent.sqlite").exists()  # no phantom file created
