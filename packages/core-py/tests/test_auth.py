from starlette.testclient import TestClient

from arclight_core.server.app import create_app
from arclight_core.server.settings import Settings


def _client(token="secret", dev_no_auth=False):
    s = Settings(db_path="/nonexistent.sqlite", projects_root="/tmp", token=token, dev_no_auth=dev_no_auth)
    return TestClient(create_app(s))


def test_health_is_open_without_token():
    r = _client().get("/health")
    assert r.status_code == 200


def test_api_requires_bearer_token():
    r = _client().get("/api/projects")  # no Authorization header
    assert r.status_code == 401
    assert r.json() == {"ok": False, "code": "UNAUTHORIZED", "message": "invalid token"}


def test_api_rejects_wrong_token():
    r = _client().get("/api/projects", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_dev_no_auth_bypasses():
    # dev_no_auth lets the request through to the route layer (which may 500 on the
    # missing DB, but must NOT 401). Assert it is not a 401.
    r = _client(dev_no_auth=True).get("/api/projects")
    assert r.status_code != 401
