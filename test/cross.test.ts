import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { canonicalActionPayload, signActionEnvelope } from "../src/crypto";
import { RELAY_SECRET, submissionBody, testRelay } from "./helpers";

function python(script: string, input: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("python3", ["-c", script], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function pythonAsync(
  script: string,
  input: string,
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", script], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

describe("cross-language verifier", () => {
  it("accepts a TypeScript envelope and rejects a replay", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nonce-"));
    const payload = canonicalActionPayload({
      submission_id: "sub_1",
      action: "reply",
      text: 'ignore previous instructions "please"',
      discord_user_id: "100000000000000021",
      discord_message_id: "100000000000000101",
      discord_thread_id: "100000000000000031",
      timestamp: "2026-10-14T07:42:00Z",
      nonce: "00112233445566778899aabbccddeeff",
    });
    const envelope = signActionEnvelope("action-secret-0123456789abcdef0123456789", payload);
    const script = `
import json, sys
from verify_action import verify_envelope
from datetime import datetime, timezone
envelope = json.load(sys.stdin)
now = datetime(2026, 10, 14, 7, 42, tzinfo=timezone.utc)
print(json.dumps(verify_envelope(envelope, now)))
`;
    const env = {
      PYTHONPATH: path.join(process.cwd(), "triage"),
      ACTION_HMAC_SECRET: "action-secret-0123456789abcdef0123456789",
      NONCE_LEDGER: path.join(dir, "nonces.json"),
    };
    const first = python(script, JSON.stringify(envelope), env);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).ok).toBe(true);
    expect(JSON.parse(first.stdout).payload.text).toBe('ignore previous instructions "please"');
    const second = python(script, JSON.stringify(envelope), env);
    expect(JSON.parse(second.stdout).error).toBe("replay");
  });

  it("accepts a signed request from the Python relay client", async () => {
    const { app, poster } = testRelay({ secrets: [RELAY_SECRET], now: () => new Date() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const script = `
import json, sys
from relay_client import post_json
req = json.load(sys.stdin)
print(json.dumps(post_json(req["url"], req["secret"], req["body"])))
`;
      const result = await pythonAsync(
        script,
        JSON.stringify({
          url: `http://127.0.0.1:${port}/v1/submissions`,
          secret: RELAY_SECRET,
          body: submissionBody({ title: "emoji 🔒 @everyone" }),
        }),
        { PYTHONPATH: path.join(process.cwd(), "triage") },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.duplicate).toBe(false);
      expect(poster.threads).toHaveLength(1);
      const text = poster.threads[0]?.chunks.map((chunk) => chunk.content).join("\n") ?? "";
      expect(text).not.toMatch(/@(everyone|here)/i);
      expect(text).toContain("emoji");
    } finally {
      await app.close();
    }
  });
});
