import sqlite3

from starlette.testclient import TestClient

from arclight_core.server.app import create_app
from arclight_core.server.settings import Settings

_SCHEMA = (
    "CREATE TABLE memories (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT DEFAULT 'local' NOT NULL, "
    "content TEXT NOT NULL, enabled integer DEFAULT true NOT NULL, "
    "created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, "
    "updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL)"
)


def _seed(tmp_path):
    db = tmp_path / "arclight.sqlite"
    conn = sqlite3.connect(str(db))
    conn.execute(_SCHEMA)
    conn.execute(
        "INSERT INTO memories (id, content, enabled, created_at, updated_at) VALUES "
        "('m1','original',1,100,100)"
    )
    conn.commit()
    conn.close()
    return db


def _client(db, tmp_path):
    s = Settings(db_path=str(db), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    return TestClient(create_app(s))


def _row(db):
    conn = sqlite3.connect(str(db))
    row = conn.execute("SELECT content, enabled, updated_at FROM memories WHERE id='m1'").fetchone()
    conn.close()
    return row


def test_patch_content_only_bumps_updated_at(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/m1", json={"content": "  edited  "})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    content, enabled, updated_at = _row(db)
    assert content == "edited"  # trimmed
    assert enabled == 1  # untouched
    assert updated_at > 100  # bumped


def test_patch_enabled_only(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/m1", json={"enabled": False})
    assert r.status_code == 200
    content, enabled, _ = _row(db)
    assert content == "original"  # untouched
    assert enabled == 0


def test_patch_truncates_content_to_500(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/m1", json={"content": "y" * 600})
    assert r.status_code == 200
    assert len(_row(db)[0]) == 500


def test_patch_empty_content_is_400(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/m1", json={"content": "   "})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "code": "VALIDATION", "message": "content required"}


def test_patch_non_boolean_enabled_is_400(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/m1", json={"enabled": "yes"})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "code": "VALIDATION", "message": "enabled 须为布尔"}


def test_patch_unknown_id_is_404(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/nope", json={"content": "x"})
    assert r.status_code == 404
    assert r.json() == {"ok": False, "code": "NOT_FOUND"}


def test_patch_missing_db_is_404(tmp_path):
    s = Settings(db_path=str(tmp_path / "absent.sqlite"), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    r = TestClient(create_app(s)).patch("/api/memories/m1", json={"content": "x"})
    assert r.status_code == 404
    assert not (tmp_path / "absent.sqlite").exists()  # no phantom file
