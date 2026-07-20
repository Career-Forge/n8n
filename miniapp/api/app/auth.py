"""Telegram Mini App initData validation.

Per the current Telegram platform docs (docs.telegram-mini-apps.com/platform/
init-data, core.telegram.org/bots/webapps): the client-side `Telegram.WebApp
.initData` string is a URL-encoded key=value set signed with an HMAC-SHA256
whose key is itself HMAC-SHA256("WebAppData", bot_token). Validate server-side
on every request -- never trust `initDataUnsafe` (the client can rewrite it).

This is a single-user bot: successful HMAC validation only proves "this
request really came from this Telegram bot's Mini App," not "this is the
owner." The owner check (`user.id == OWNER_TG_USER_ID`) is a second,
independent gate -- anyone could in principle open the bot and load the Mini
App URL, so the allowlist is load-bearing, not a formality.
"""
import hashlib
import hmac
import json
import time
import urllib.parse

from fastapi import Header, HTTPException

from .config import settings


class AuthError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail


def validate_init_data(init_data: str, bot_token: str, owner_id: int, max_age_seconds: int = 86400) -> dict:
    if not init_data:
        raise AuthError(401, "missing init data")

    pairs = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
    their_hash = pairs.pop("hash", None)
    if not their_hash:
        raise AuthError(401, "init data missing hash")

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    our_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(our_hash, their_hash):
        raise AuthError(401, "init data signature invalid")

    auth_date = int(pairs.get("auth_date", 0))
    if time.time() - auth_date > max_age_seconds:
        raise AuthError(401, "init data expired")

    try:
        user = json.loads(pairs.get("user", "{}"))
    except json.JSONDecodeError:
        raise AuthError(401, "init data user field malformed")

    if int(user.get("id", -1)) != owner_id:
        raise AuthError(403, "not the bot owner")

    return user


async def require_owner(x_tg_init_data: str | None = Header(default=None, alias="X-Tg-Init-Data")) -> dict:
    """FastAPI dependency -- attach to every route except /api/healthz."""
    if settings.dev_mode and not x_tg_init_data:
        return {"id": settings.owner_tg_user_id, "first_name": "Dev"}
    try:
        return validate_init_data(x_tg_init_data or "", settings.telegram_bot_token, settings.owner_tg_user_id)
    except AuthError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
