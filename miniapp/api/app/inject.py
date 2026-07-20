"""Synthetic Telegram Update injection -- how the Mini App triggers real bot
actions (apply/find/track) without any new n8n intent-handling nodes. The
full existing pipeline (Extract Input -> Intent Router -> Route Intent -> ...)
runs exactly as it would for a real typed message; results are delivered in
the Telegram chat as they are today.

Traced against the live workflow (`Extract Input`, `IF: Is Callback Query?`,
`IF: Has Document?`, and the 4 nodes that read `$('Telegram Trigger')`
directly): the minimal fields the text-message path needs are
`message.chat.id` and `message.text`; `Simple Memory`'s session key reads
`message.chat.id` with NO optional chaining, so it is mandatory. In a
private chat chat.id == from.id == the owner's Telegram user id.

The Telegram Trigger node (typeVersion 1.1, > 1) enforces a secret token
n8n derives as `<workflowId>_<triggerNodeId>` (confirmed against the
installed TelegramTrigger.node.js) -- every injected POST must carry it or
the webhook 403s before Extract Input ever runs.
"""
import time

import httpx
from fastapi import HTTPException

from .config import settings
from . import bridge

_update_counter = 900_000_000


def _next_update_id() -> int:
    global _update_counter
    _update_counter += 1
    return _update_counter


def build_update(text: str) -> dict:
    now = int(time.time())
    update_id = _next_update_id()
    owner = settings.owner_tg_user_id
    return {
        "update_id": update_id,
        "message": {
            "message_id": update_id,
            "date": now,
            "text": text,
            "chat": {"id": owner, "type": "private", "first_name": "Owner"},
            "from": {"id": owner, "is_bot": False, "first_name": "Owner"},
        },
    }


async def send_text(text: str) -> None:
    # NOTE: the Telegram Trigger node's actual registered path has a
    # "/webhook" suffix appended to its webhookId (confirmed empirically
    # against the live webhook_entity table: "careerforge-telegram/webhook",
    # not the bare "careerforge-telegram" the id alone might suggest).
    url = f"{settings.n8n_internal_url}/webhook/careerforge-telegram/webhook"
    headers = {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": settings.n8n_tg_webhook_secret,
    }
    update = build_update(text)
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.post(url, json=update, headers=headers)
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"telegram trigger unreachable: {e}")

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"telegram trigger returned {resp.status_code}: {resp.text[:200]}")

    # The injected message will (eventually) mutate staticData (last_jobs,
    # last_apply, tracked_applications...) -- drop the bridge cache so the
    # next snapshot read isn't stale for up to a minute.
    bridge.invalidate()
