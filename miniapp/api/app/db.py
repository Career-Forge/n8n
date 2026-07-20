"""asyncpg connection pool, created once at app startup (see main.py's lifespan)."""
import datetime

import asyncpg

from .config import settings

_pool: asyncpg.Pool | None = None


async def connect() -> None:
    global _pool
    _pool = await asyncpg.create_pool(settings.database_url, min_size=1, max_size=5)


async def disconnect() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("db pool not initialized -- did the app lifespan run?")
    return _pool


def parse_dt(value) -> datetime.datetime | None:
    """asyncpg's timestamptz codec requires a real datetime.datetime object
    (or None) -- passing an ISO string raises `DataError: expected a
    datetime.date or datetime.datetime instance, got 'str'`, and an
    explicit ::timestamptz SQL cast does NOT change that (the column's own
    type already drives asyncpg's parameter-type inference). Pass every
    ISO-string timestamp through this before binding; a value that's
    already a datetime (e.g. read back from a previous fetchrow) passes
    through untouched."""
    if value is None or isinstance(value, datetime.datetime):
        return value
    return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))


async def url_norm(url: str | None) -> str | None:
    """Delegates to the Postgres cf_url_norm() function (db/migrations/
    001_applications.sql) so this service and the n8n dual-write node never
    maintain two copies of the normalization rule."""
    if not url:
        return None
    async with pool().acquire() as conn:
        return await conn.fetchval("SELECT cf_url_norm($1)", url)
