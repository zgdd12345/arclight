import sqlite3

from starlette.testclient import TestClient

from arclight_core.server.app import create_app
from arclight_core.server.settings import Settings

# Real on-disk schema (subset) matching packages/core/src/db/migrations/0001_*.sql.
_SCHEMA = (
    "CREATE TABLE memories (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT DEFAULT 'local' NOT NULL, "
    "content TEXT NOT NULL, enabled integer DEFAULT true NOT NULL, "
    "created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, "
    "updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL)"
)


def _seed(tmp_path, rows=()):
    db = tmp_path / "arclight.sqlite"
    conn = sqlite3.connect(str(db))
    conn.execute(_SCHEMA)
    # rows: (id, content, enabled 0/1, created_at)
    for r in rows:
        conn.execute(
            "INSERT INTO memories (id, content, enabled, created_at) VALUES (?,?,?,?)", r
        )
    conn.commit()
    conn.close()
    return db


def _client(db, tmp_path):
    s = Settings(db_path=str(db), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    return TestClient(create_app(s))


def test_get_lists_newest_first_with_bool_enabled(tmp_path):
    db = _seed(tmp_path, rows=[("m1", "older", 1, 100), ("m2", "newer", 0, 200)])
    r = _client(db, tmp_path).get("/api/memories")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["memories"] == [
        {"id": "m2", "content": "newer", "enabled": False, "createdAt": 200},
        {"id": "m1", "content": "older", "enabled": True, "createdAt": 100},
    ]


def test_post_creates_and_returns_id(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).post("/api/memories", json={"content": "  remember this  "})
    assert r.status_code == 201
    new_id = r.json()["id"]
    assert r.json()["ok"] is True
    conn = sqlite3.connect(str(db))
    row = conn.execute("SELECT content, enabled FROM memories WHERE id=?", (new_id,)).fetchone()
    conn.close()
    assert row[0] == "remember this"  # trimmed
    assert row[1] == 1  # enabled defaults true


def test_post_truncates_to_500(tmp_path):
    db = _seed(tmp_path)
    new_id = _client(db, tmp_path).post("/api/memories", json={"content": "x" * 600}).json()["id"]
    conn = sqlite3.connect(str(db))
    content = conn.execute("SELECT content FROM memories WHERE id=?", (new_id,)).fetchone()[0]
    conn.close()
    assert len(content) == 500


def test_post_empty_content_is_400(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).post("/api/memories", json={"content": "   "})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "code": "VALIDATION", "message": "content required"}
