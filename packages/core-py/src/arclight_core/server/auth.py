"""Bearer auth middleware. Parity with packages/core/src/server/middleware/auth.ts:
/health and non-/api paths are open; /api/* requires Authorization: Bearer <token>,
compared timing-safe. ARCLIGHT_DEV_NO_AUTH bypass handled via dev_no_auth flag.
"""
import hmac

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


class BearerAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, token: str, dev_no_auth: bool = False):
        super().__init__(app)
        self._token = token
        self._dev_no_auth = dev_no_auth

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if self._dev_no_auth or not path.startswith("/api/"):
            return await call_next(request)
        header = request.headers.get("authorization", "")
        got = header[len("Bearer ") :] if header.startswith("Bearer ") else ""
        if not hmac.compare_digest(got, self._token):
            return JSONResponse(
                {"ok": False, "code": "UNAUTHORIZED", "message": "invalid token"},
                status_code=401,
            )
        return await call_next(request)
