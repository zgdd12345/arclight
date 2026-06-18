"""Arclight core HTTP server (Python). M1: GET /health (open) + GET /api/projects (auth).

Contract sources of truth:
- /health  : packages/core/src/server/routes/health.ts
- auth     : packages/core/src/server/middleware/auth.ts
- /api/projects : packages/core/src/server/routes/projects.ts
"""
import time

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .auth import BearerAuthMiddleware
from .settings import Settings, from_env

_SERVICE = "arclight-core"
_VERSION = "0.0.1"
_STARTED_AT = time.monotonic()


async def _health(_request: Request) -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "service": _SERVICE,
            "version": _VERSION,
            "uptimeMs": int((time.monotonic() - _STARTED_AT) * 1000),
        }
    )


def create_app(settings: Settings | None = None) -> Starlette:
    settings = settings or from_env()
    # Imported here so /health-only apps (slice 1 tests) don't require the projects deps path.
    from .projects import make_projects_delete, make_projects_get, make_projects_patch

    routes = [
        Route("/health", _health, methods=["GET"]),
        Route("/api/projects", make_projects_get(settings), methods=["GET"]),
        Route("/api/projects/{workspace_id}", make_projects_patch(settings), methods=["PATCH"]),
        Route("/api/projects/{workspace_id}", make_projects_delete(settings), methods=["DELETE"]),
    ]
    middleware = [
        Middleware(BearerAuthMiddleware, token=settings.token, dev_no_auth=settings.dev_no_auth),
    ]
    return Starlette(routes=routes, middleware=middleware)


app = create_app()
