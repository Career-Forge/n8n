#!/usr/bin/env python3
"""Forges a valid Telegram Mini App initData string for local testing --
signed with the REAL bot token, so it validates against miniapp/api/app/
auth.py exactly the way a real Telegram client's initData would. Only
useful because we hold the bot token ourselves (this is the same
verification anyone with the bot token could construct); it proves the
HMAC check is correct without needing an actual Telegram client.

Usage (from the repo root):
    python3 scripts/miniapp_sign_initdata.py
    python3 scripts/miniapp_sign_initdata.py --user-id 12345 --tampered

Reads TELEGRAM_BOT_TOKEN and OWNER_TG_USER_ID from docker/.env unless
overridden by real environment variables or --user-id.
"""
import argparse
import hashlib
import hmac
import json
import os
import time
import urllib.parse
from pathlib import Path


def load_env_file(path: Path) -> dict:
    out = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-id", type=int, default=None, help="override the user id in the signed payload")
    parser.add_argument("--tampered", action="store_true", help="flip one character of the hash to prove validation rejects it")
    parser.add_argument("--stale", action="store_true", help="set auth_date far in the past to prove max-age rejection")
    args = parser.parse_args()

    env_file = load_env_file(Path(__file__).resolve().parent.parent / "docker" / ".env")
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN") or env_file.get("TELEGRAM_BOT_TOKEN")
    owner_id = args.user_id or int(os.environ.get("OWNER_TG_USER_ID") or env_file.get("OWNER_TG_USER_ID", "0"))

    if not bot_token:
        raise SystemExit("TELEGRAM_BOT_TOKEN not found in env or docker/.env")
    if not owner_id:
        raise SystemExit("OWNER_TG_USER_ID not found in env or docker/.env (or pass --user-id)")

    auth_date = int(time.time()) - (90 * 86400 if args.stale else 0)
    user = json.dumps({"id": owner_id, "first_name": "Owner", "is_bot": False}, separators=(",", ":"))

    pairs = {"auth_date": str(auth_date), "user": user, "query_id": "AAtest"}
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    signed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if args.tampered:
        signed_hash = ("0" if signed_hash[0] != "0" else "1") + signed_hash[1:]

    pairs["hash"] = signed_hash
    init_data = "&".join(f"{k}={urllib.parse.quote(v, safe='')}" for k, v in pairs.items())
    print(init_data)


if __name__ == "__main__":
    main()
