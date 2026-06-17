from starlette.testclient import TestClient

from arclight_core.server.app import create_app


def test_health_matches_ts_contract():
    client = TestClient(create_app())
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    # Exact key set — the TS Hono route returns precisely these four.
    assert set(body.keys()) == {"ok", "service", "version", "uptimeMs"}
    assert body["ok"] is True
    assert body["service"] == "arclight-core"
    assert body["version"] == "0.0.1"
    assert isinstance(body["uptimeMs"], int)
    assert body["uptimeMs"] >= 0
