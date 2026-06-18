from arclight_core.server.db import connect


def _make_schema(conn):
    conn.execute(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL "
        "REFERENCES workspaces(id) ON DELETE CASCADE)"
    )


def test_connect_enables_foreign_keys_cascade(tmp_path):
    db = str(tmp_path / "arclight.sqlite")
    c = connect(db)
    _make_schema(c)
    c.execute("INSERT INTO workspaces (id, name, repo_path) VALUES ('w1','a','/p/a')")
    c.execute("INSERT INTO sessions (id, workspace_id) VALUES ('s1','w1')")
    c.commit()
    # FK cascade must be ON: deleting the workspace removes the child session.
    c.execute("DELETE FROM workspaces WHERE id='w1'")
    c.commit()
    assert c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    c.close()


def test_connect_returns_row_factory(tmp_path):
    db = str(tmp_path / "arclight.sqlite")
    c = connect(db)
    c.execute("CREATE TABLE t (k TEXT)")
    c.execute("INSERT INTO t (k) VALUES ('v')")
    row = c.execute("SELECT k FROM t").fetchone()
    assert row["k"] == "v"  # sqlite3.Row keyed access
    c.close()
