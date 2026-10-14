#!/usr/bin/env python3
"""Sign and POST JSON to the Discord bot relay.

String to sign, UTF-8:

    {timestamp}.{nonce}.{raw_body}

Headers:

    X-Relay-Timestamp: 2026-10-14T07:42:00Z
    X-Relay-Nonce: 32 lowercase hex characters
    X-Relay-Signature: hex HMAC-SHA256 of the string above

The raw body bytes that are signed are the bytes on the wire.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import urllib.error
import urllib.request
from datetime import datetime, timezone


class RelayError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"relay_http_{status}")
        self.status = status
        self.body = body


def payload_timestamp(now: datetime | None = None) -> str:
    current = now or datetime.now(timezone.utc)
    return current.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sign_headers(secret: str, raw: bytes, now: datetime | None = None, nonce: str | None = None) -> dict[str, str]:
    timestamp = payload_timestamp(now)
    nonce_value = nonce or secrets.token_hex(16)
    message = timestamp.encode("utf-8") + b"." + nonce_value.encode("utf-8") + b"." + raw
    signature = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return {
        "X-Relay-Timestamp": timestamp,
        "X-Relay-Nonce": nonce_value,
        "X-Relay-Signature": signature,
        "Content-Type": "application/json",
    }


def post_json(url: str, secret: str, body: dict, timeout: float = 30) -> dict:
    raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=raw, headers=sign_headers(secret, raw), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RelayError(error.code, detail) from None
