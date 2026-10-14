#!/usr/bin/env python3
"""Locked, atomically replaced JSON state for the Mantis Triage box.

Overlapping routine runs must share one state file. Writers take an exclusive
flock and replace the file with os.replace so readers never see a partial write.
"""

from __future__ import annotations

import fcntl
import json
import os
import tempfile
from pathlib import Path
from typing import Callable


def empty_state() -> dict:
    return {"cursor": None, "submissions": {}, "sent_mantis_message_ids": []}


def update_state(path: Path, mutator: Callable[[dict], None]) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    with open(lock_path, "a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            if path.exists():
                data = json.loads(path.read_text(encoding="utf-8") or "{}")
                if not isinstance(data, dict):
                    data = empty_state()
            else:
                data = empty_state()
            mutator(data)
            _replace_atomic(path, data)
            return data
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def read_state(path: Path) -> dict:
    if not path.exists():
        return empty_state()
    data = json.loads(path.read_text(encoding="utf-8") or "{}")
    if not isinstance(data, dict):
        return empty_state()
    return data


def _replace_atomic(path: Path, data: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
