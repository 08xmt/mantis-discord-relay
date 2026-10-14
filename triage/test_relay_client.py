import hashlib
import hmac
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from relay_client import RelayError, post_json, sign_headers


SECRET = "relay-secret-0123456789abcdef0123456789"


class RelayClientTest(unittest.TestCase):
    def test_signature_matches_body_bytes(self) -> None:
        seen: dict[str, object] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                timestamp = self.headers["X-Relay-Timestamp"]
                nonce = self.headers["X-Relay-Nonce"]
                signature = self.headers["X-Relay-Signature"]
                message = f"{timestamp}.{nonce}.".encode() + raw
                expected = hmac.new(SECRET.encode(), message, hashlib.sha256).hexdigest()
                seen["match"] = hmac.compare_digest(expected, signature)
                seen["body"] = json.loads(raw.decode())
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"thread_id":"1","duplicate":false}')

            def log_message(self, fmt: str, *args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            result = post_json(
                f"http://127.0.0.1:{port}/v1/submissions",
                SECRET,
                {"submission_id": "sub_1", "title": "A title with emoji 🔒"},
            )
            self.assertEqual(result["thread_id"], "1")
            self.assertTrue(seen["match"])
            self.assertEqual(seen["body"]["title"], "A title with emoji 🔒")
            headers = sign_headers(SECRET, b"{}")
            self.assertEqual(len(headers["X-Relay-Nonce"]), 32)
        finally:
            server.shutdown()
            server.server_close()

    def test_http_error_raises(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":"bad_signature"}')

            def log_message(self, fmt: str, *args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            with self.assertRaises(RelayError) as caught:
                post_json(f"http://127.0.0.1:{port}/v1/submissions", SECRET, {"a": 1})
            self.assertEqual(caught.exception.status, 401)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
