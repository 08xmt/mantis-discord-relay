#!/usr/bin/env python3
"""Reference verifier for Discord → Triage action envelopes.

The signature covers the exact ``payload`` string inside the envelope. This
script is the receiving-side check: constant-time HMAC (current and next
secret), a ±10 minute timestamp window, a 24 hour nonce ledger, and schema
limits. The model runtime must not perform the cryptography itself.

    ACTION_HMAC_SECRET=... ACTION_HMAC_SECRET_NEXT=... \\
      python3 verify_action.py < envelope.json

Stdout is one JSON object. Exit 0 on success, 1 otherwise.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

STATUS_VALUES = {
    "new",
    "acknowledged",
    "accepted",
    "rejected",
    "duplicate",
    "paid",
    "closed",
}
ACTIONS = {"reply", "note", "status", "open"}
BODY_MAX = 16_000
STATUS_NOTE_MAX = 4_000
SNOWFLAKE = re.compile(r"^\d{17,20}$")
NONCE = re.compile(r"^[0-9a-f]{32}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$")
SKEW = timedelta(seconds=int(os.environ.get("MAX_SKEW_SECONDS", "600")))
NONCE_TTL = timedelta(hours=24)


def fail(error: str) -> dict:
    return {"ok": False, "error": error}


def secrets() -> list[str]:
    values = [os.environ.get("ACTION_HMAC_SECRET", ""), os.environ.get("ACTION_HMAC_SECRET_NEXT", "")]
    return [value for value in values if value]


def signatures_match(expected_hex: str, presented_hex: str) -> bool:
    if len(expected_hex) != len(presented_hex):
        return False
    return hmac.compare_digest(expected_hex.lower(), presented_hex.lower())


def verify_hmac(keys: list[str], message: str, presented: str) -> bool:
    if not re.fullmatch(r"[0-9a-fA-F]{64}", presented):
        for key in keys:
            dummy = hmac.new(key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()
            signatures_match(dummy, "0" * 64)
        return False
    ok = False
    for key in keys:
        expected = hmac.new(key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()
        if signatures_match(expected, presented):
            ok = True
    return ok


def parse_timestamp(value: str) -> datetime | None:
    if not TIMESTAMP.fullmatch(value):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def validate_payload(value: object) -> tuple[dict | None, str | None]:
    if not isinstance(value, dict):
        return None, "invalid"
    if value.get("v") != 1:
        return None, "invalid"
    submission_id = value.get("submission_id")
    if not isinstance(submission_id, str) or not _safe_id(submission_id, 128):
        return None, "invalid"
    action = value.get("action")
    if action not in ACTIONS:
        return None, "invalid"
    text = value.get("text")
    if not isinstance(text, str):
        return None, "invalid"
    limit = STATUS_NOTE_MAX if action == "status" else BODY_MAX
    if len(text) > limit:
        return None, "invalid"
    if action in {"reply", "note"} and text.strip() == "":
        return None, "invalid"
    if action == "open" and text != "":
        return None, "invalid"
    status = value.get("status", None)
    if action == "status":
        if status not in STATUS_VALUES:
            return None, "invalid"
    elif status is not None:
        return None, "invalid"
    for field in ("discord_user_id", "discord_message_id", "discord_thread_id"):
        field_value = value.get(field)
        if not isinstance(field_value, str) or not SNOWFLAKE.fullmatch(field_value):
            return None, "invalid"
    timestamp = value.get("timestamp")
    if not isinstance(timestamp, str) or parse_timestamp(timestamp) is None:
        return None, "invalid"
    nonce = value.get("nonce")
    if not isinstance(nonce, str) or not NONCE.fullmatch(nonce):
        return None, "invalid"
    return value, None


def _safe_id(value: str, limit: int) -> bool:
    if not 1 <= len(value) <= limit:
        return False
    return not any(ord(char) <= 0x1F or ord(char) == 0x7F or char.isspace() for char in value)


def nonce_path() -> Path:
    raw = os.environ.get("NONCE_LEDGER", "nonces.json")
    return Path(raw)


def remember_nonce(path: Path, nonce: str, now: datetime) -> bool:
    """Return False when the nonce was already seen in the last 24 hours."""
    import fcntl

    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    with open(lock_path, "a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            ledger: dict[str, str] = {}
            if path.exists():
                try:
                    loaded = json.loads(path.read_text(encoding="utf-8") or "{}")
                except json.JSONDecodeError as exc:
                    raise ValueError("nonce ledger unreadable") from exc
                if isinstance(loaded, dict):
                    ledger = {str(key): str(val) for key, val in loaded.items()}
            cutoff = (now - NONCE_TTL).strftime("%Y-%m-%dT%H:%M:%SZ")
            ledger = {key: seen for key, seen in ledger.items() if seen >= cutoff}
            if nonce in ledger:
                _write_atomic(path, ledger)
                return False
            ledger[nonce] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
            _write_atomic(path, ledger)
            return True
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _write_atomic(path: Path, data: dict) -> None:
    import os as _os
    import tempfile

    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with _os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            _os.fsync(handle.fileno())
        _os.replace(tmp, path)
    except Exception:
        try:
            _os.unlink(tmp)
        except OSError:
            pass
        raise


def verify_envelope(envelope: object, now: datetime | None = None) -> dict:
    if not isinstance(envelope, dict):
        return fail("invalid")
    payload = envelope.get("payload")
    sig = envelope.get("sig")
    if not isinstance(payload, str) or not isinstance(sig, str):
        return fail("invalid")
    keys = secrets()
    if not keys or not verify_hmac(keys, payload, sig):
        return fail("bad_signature")
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return fail("invalid")
    validated, error = validate_payload(parsed)
    if error or validated is None:
        return fail("invalid")
    current = now or datetime.now(timezone.utc)
    stamped = parse_timestamp(validated["timestamp"])
    if stamped is None or abs(current - stamped) > SKEW:
        return fail("invalid")
    try:
        fresh = remember_nonce(nonce_path(), validated["nonce"], current)
    except ValueError:
        return fail("invalid")
    if not fresh:
        return fail("replay")
    return {"ok": True, "payload": validated}


def main() -> int:
    raw = sys.stdin.read()
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError:
        json.dump(fail("invalid"), sys.stdout)
        sys.stdout.write("\n")
        return 1
    result = verify_envelope(envelope)
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
