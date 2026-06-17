"""Arclight core HTTP server (Python). M1 slice 1: only GET /health.

Contract source of truth: packages/core/src/server/routes/health.ts —
returns {ok, service, version, uptimeMs}. /health is OPEN (no auth);
/api/* (added in later slices) will require a bearer token.
"""
import time

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

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


def create_app() -> Starlette:
    return Starlette(routes=[Route("/health", _health, methods=["GET"])])


app = create_app()
