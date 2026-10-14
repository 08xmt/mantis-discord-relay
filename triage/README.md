# Triage helpers

These scripts run on the Mantis Triage box. They do not import the Discord bot and they do not contain a Discord token.

| File | Role |
|---|---|
| `verify_action.py` | Reference verifier for `{payload, sig}` action envelopes |
| `relay_client.py` | Signs `POST` bodies for the bot's relay API |
| `state.py` | `flock` plus atomic replace for `state.json` |
| `prompts/` | Routine text to paste into the Grok Bot assistant |
| `allowlist.example.json` | Shape of Triage's own allowlist copy |

```sh
python3 -m unittest discover -s . -p 'test_*.py'
```

From the repository root, `npm test` runs these as well.

Set `ACTION_HMAC_SECRET` and `NONCE_LEDGER` before `verify_action.py`. Pass `RELAY_HMAC_SECRET` into `relay_client.post_json`. Keep secrets in the box's secret store, not in `state.json`.
