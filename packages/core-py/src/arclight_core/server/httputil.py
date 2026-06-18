"""Small HTTP helpers shared across route modules."""
from starlette.requests import Request


async def json_or_empty(request: Request) -> dict:
    # Parity with TS `await c.req.json().catch(() => ({}))`: any parse failure → {}.
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}
