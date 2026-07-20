"""Environment-backed config. No defaults for anything security-relevant --
missing config must fail loudly at startup, not silently fall back to an
insecure default (the same discipline the bridge Code node uses: no secret
configured means every request is rejected, not accepted)."""
import os


def _require(name: str) -> str:
    val = os.environ.get(name, "")
    if not val:
        raise RuntimeError(f"missing required env var: {name}")
    return val


class Settings:
    def __init__(self) -> None:
        self.telegram_bot_token = _require("TELEGRAM_BOT_TOKEN")
        self.owner_tg_user_id = int(_require("OWNER_TG_USER_ID"))
        self.bridge_secret = _require("MINIAPP_BRIDGE_SECRET")
        self.n8n_internal_url = os.environ.get("N8N_INTERNAL_URL", "http://n8n:5678").rstrip("/")
        self.n8n_tg_webhook_secret = _require("N8N_TG_WEBHOOK_SECRET")
        self.database_url = _require("DATABASE_URL")
        self.miniapp_public_url = os.environ.get("MINIAPP_PUBLIC_URL", "")
        # Dev-only escape hatch: lets `curl localhost:5681/api/...` work without
        # a real Telegram initData blob. OFF unless explicitly set — never
        # default-on, this bypasses the owner-allowlist auth entirely.
        self.dev_mode = os.environ.get("MINIAPP_DEV_MODE", "").lower() in ("1", "true", "yes")


settings = Settings()
