"""PIN gate.

- Signing secret loaded from / generated into .secret (survives restarts).
- HMAC-signed session cookie via itsdangerous TimestampSigner.
- Per-IP brute-force counter: 5 failures → 10-minute lockout.
- Middleware enforces the cookie on every route; WS rejects with code 4003.
"""

from __future__ import annotations

import logging
import secrets
import time
from pathlib import Path
from typing import Optional

from itsdangerous import BadSignature, SignatureExpired, TimestampSigner

log = logging.getLogger("auth")

COOKIE_NAME = "asciline_auth"
COOKIE_MAX_AGE = 30 * 24 * 3600          # 30 days
_TOKEN_PAYLOAD = "ok"                     # fixed payload; signature is the proof
_MAX_ATTEMPTS = 5
_LOCKOUT_SECONDS = 600                    # 10 minutes

SECRET_FILE = Path(__file__).parent / ".secret"


def _load_or_create_secret() -> str:
    if SECRET_FILE.exists():
        secret = SECRET_FILE.read_text().strip()
        if secret:
            return secret
    secret = secrets.token_hex(32)
    SECRET_FILE.write_text(secret)
    SECRET_FILE.chmod(0o600)
    log.info("Generated new signing secret → %s", SECRET_FILE)
    return secret


_SECRET: Optional[str] = None
_SIGNER: Optional[TimestampSigner] = None


def _signer() -> TimestampSigner:
    if _SIGNER is None:
        raise RuntimeError("auth not initialised — call auth.init() first")
    return _SIGNER


def init() -> None:
    """Load (or generate) the signing secret.  Must be called before serving."""
    global _SECRET, _SIGNER
    _SECRET = _load_or_create_secret()
    _SIGNER = TimestampSigner(_SECRET)


# Brute-force tracker keyed by IP.  In-memory is enough for a personal service.
# {ip: {"count": int, "locked_until": float}}
_attempts: dict[str, dict] = {}


def _ip_from_scope(scope) -> str:
    """CF-Connecting-IP first (the real client behind Cloudflare), then peer."""
    headers = dict(scope.get("headers") or [])
    cf_ip = headers.get(b"cf-connecting-ip", b"").decode("latin-1").strip()
    if cf_ip:
        return cf_ip
    client = scope.get("client")
    if client:
        return client[0]
    return "unknown"


def is_locked_out(ip: str) -> bool:
    entry = _attempts.get(ip)
    if entry is None:
        return False
    if entry["locked_until"] and time.monotonic() < entry["locked_until"]:
        return True
    if entry["locked_until"] and time.monotonic() >= entry["locked_until"]:
        _attempts.pop(ip, None)
    return False


def record_failure(ip: str) -> bool:
    """Record a failed attempt; return True if this IP is now locked out."""
    entry = _attempts.setdefault(ip, {"count": 0, "locked_until": 0.0})
    entry["count"] += 1
    if entry["count"] >= _MAX_ATTEMPTS:
        entry["locked_until"] = time.monotonic() + _LOCKOUT_SECONDS
        log.warning("IP %s locked out for %ds after %d failures",
                    ip, _LOCKOUT_SECONDS, entry["count"])
        return True
    return False


def record_success(ip: str) -> None:
    _attempts.pop(ip, None)


def make_cookie_value() -> str:
    return _signer().sign(_TOKEN_PAYLOAD).decode()


def verify_cookie(value: str) -> bool:
    try:
        _signer().unsign(value, max_age=COOKIE_MAX_AGE)
        return True
    except (BadSignature, SignatureExpired):
        return False


def cookie_header(value: str, *, secure: bool = True) -> str:
    """Build the Set-Cookie header string.

    Pass ``secure=False`` only when the request that triggered this
    Set-Cookie was itself served over plain http — browsers refuse to send
    Secure cookies over plain http, which would silently 403 the
    /audio GET on http://localhost:* while the WebSocket still works
    (different upgrade path).
    """
    parts = [
        f"{COOKIE_NAME}={value}",
        f"Max-Age={COOKIE_MAX_AGE}",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


_PIN: Optional[str] = None


def set_pin(pin: str) -> None:
    global _PIN
    _PIN = pin


def check_pin(provided: str) -> bool:
    return _PIN is not None and provided == _PIN


def get_cookie(scope) -> Optional[str]:
    """Extract the auth cookie value from a Starlette scope's headers."""
    headers = scope.get("headers") or []
    for name, value in headers:
        if name.lower() == b"cookie":
            for part in value.decode("latin-1").split(";"):
                part = part.strip()
                if part.startswith(COOKIE_NAME + "="):
                    return part[len(COOKIE_NAME) + 1:]
    return None


def is_authenticated(scope) -> bool:
    value = get_cookie(scope)
    return value is not None and verify_cookie(value)
