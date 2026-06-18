from starlette.responses import JSONResponse


def make_projects_get(settings):
    async def _handler(request):
        # Task 3 replaces this file wholesale with the real implementation.
        return JSONResponse(
            {"ok": False, "message": "implemented in Task 3"},
            status_code=500,
        )

    return _handler
