import json
import tempfile
import threading
import unittest
from pathlib import Path

from state import read_state, update_state


class StateTest(unittest.TestCase):
    def test_concurrent_updates_are_complete(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"

            def bump() -> None:
                def mutate(data: dict) -> None:
                    data["cursor"] = int(data.get("cursor") or 0) + 1

                for _ in range(20):
                    update_state(path, mutate)

            threads = [threading.Thread(target=bump) for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            data = read_state(path)
            self.assertEqual(data["cursor"], 160)
            json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(list(path.parent.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
