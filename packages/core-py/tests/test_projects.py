import os
import sqlite3

from starlette.testclient import TestClient

from arclight_core.server.app import create_app
from arclight_core.server.settings import Settings


def _seed_db(path):
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, "
        "name TEXT NOT NULL, repo_path TEXT NOT NULL, arclight_dir TEXT, "
        "current_session_id TEXT, default_branch TEXT, head_sha TEXT, "
        "created_at INTEGER, updated_at INTEGER)"
    )
    conn.execute(
        "INSERT INTO workspaces (id, name, repo_path, arclight_dir) VALUES (?,?,?,?)",
        ("ws1", "alpha", "/projects/alpha", "/projects/alpha/.arclight"),
    )
    conn.commit()
    conn.close()


def _client(tmp_path):
    db = tmp_path / "arclight.sqlite"
    _seed_db(str(db))
    root = tmp_path / "projects"
    root.mkdir()
    (root / "alpha").mkdir()          # registered (repo_path points here once abspath'd? no — repo_path is /projects/alpha)
    (root / "beta").mkdir()           # available
    (root / ".hidden").mkdir()        # skipped (hidden)
    (root / "afile").write_text("x")  # skipped (not a dir)
    s = Settings(db_path=str(db), projects_root=str(root), token="t", dev_no_auth=True)
    return TestClient(create_app(s)), str(root)


def test_projects_contract(tmp_path):
    client, root = _client(tmp_path)
    r = client.get("/api/projects")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["projectsRoot"] == os.path.abspath(root)
    assert body["projects"] == [{"workspaceId": "ws1", "name": "alpha", "repoPath": "/projects/alpha"}]
    # alpha dir is under root but its abspath != the workspace repo_path (/projects/alpha),
    # so it is NOT registered-by-path and appears in available alongside beta; hidden + file excluded.
    names = [d["name"] for d in body["available"]]
    assert names == ["alpha", "beta"]
    assert all(not n.startswith(".") for n in names)


def test_missing_db_returns_500_no_phantom_file(tmp_path):
    # A nonexistent db_path must surface as HTTP 500 without creating a phantom file.
    db_path = str(tmp_path / "nonexistent.sqlite")
    root = tmp_path / "projects"
    root.mkdir()
    s = Settings(db_path=db_path, projects_root=str(root), token="t", dev_no_auth=True)
    client = TestClient(create_app(s))
    r = client.get("/api/projects")
    assert r.status_code == 500
    body = r.json()
    assert body["ok"] is False
    assert "not found" in body["message"]
    assert not os.path.exists(db_path)


def test_available_excludes_registered(tmp_path):
    # When a workspace repo_path resolves to a dir under root, that dir is excluded from available.
    db = tmp_path / "arclight.sqlite"
    root = tmp_path / "projects"
    root.mkdir()
    (root / "gamma").mkdir()
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL)"
    )
    conn.execute(
        "INSERT INTO workspaces (id, name, repo_path) VALUES (?,?,?)",
        ("ws2", "gamma", str(root / "gamma")),
    )
    conn.commit()
    conn.close()
    s = Settings(db_path=str(db), projects_root=str(root), token="t", dev_no_auth=True)
    body = TestClient(create_app(s)).get("/api/projects").json()
    assert [d["name"] for d in body["available"]] == []  # gamma is registered → excluded


def test_projects_order_is_insertion_order(tmp_path):
    db = tmp_path / "arclight.sqlite"
    root = tmp_path / "projects"
    root.mkdir()
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL)"
    )
    # Insert zeta before alpha; rowid order must preserve insertion, not name sort.
    conn.execute("INSERT INTO workspaces (id,name,repo_path) VALUES ('w2','zeta','/p/zeta')")
    conn.execute("INSERT INTO workspaces (id,name,repo_path) VALUES ('w1','alpha','/p/alpha')")
    conn.commit()
    conn.close()
    s = Settings(db_path=str(db), projects_root=str(root), token="t", dev_no_auth=True)
    body = TestClient(create_app(s)).get("/api/projects").json()
    assert [p["name"] for p in body["projects"]] == ["zeta", "alpha"]
