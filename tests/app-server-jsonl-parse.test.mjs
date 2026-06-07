import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { AppServerClientBase } from "../plugins/codex/scripts/lib/app-server.mjs";

const ESC = String.fromCharCode(27); // 0x1B

// AppServerClientBase.handleLine is the single chokepoint that parses raw Codex
// app-server stdout (used by both the direct SpawnedCodexAppServerClient and the
// broker's in-process appClient). A robust reader must skip non-JSONL noise
// (banners, log lines, ANSI) instead of tearing down the whole connection — and
// killing the running turn — on the first unparseable line.
class CollectingClient extends AppServerClientBase {
  constructor() {
    super("/tmp");
    this.notifications = [];
    this.setNotificationHandler((message) => this.notifications.push(message));
  }
  sendMessage() {}
}

test("handleLine skips a non-JSON garbage line without tearing down the connection", () => {
  const client = new CollectingClient();
  client.handleLine("codex: starting app-server (this is not JSONL)");
  assert.equal(client.notifications.length, 0, "a non-JSON line must not be delivered as a notification");
  assert.ok(!client.exitResolved, "a single garbage stdout line must NOT close the connection");
});

test("handleLine strips ANSI wrapping then parses the embedded JSON notification", () => {
  const client = new CollectingClient();
  client.handleLine(`${ESC}[32m{"method":"turn/started","params":{"threadId":"t1"}}${ESC}[0m`);
  assert.equal(client.notifications.length, 1);
  assert.equal(client.notifications[0].method, "turn/started");
  assert.equal(client.notifications[0].params.threadId, "t1");
  assert.ok(!client.exitResolved);
});

test("handleLine skips a line that is only ANSI/whitespace", () => {
  const client = new CollectingClient();
  client.handleLine(`${ESC}[2K${ESC}[1G   `);
  assert.equal(client.notifications.length, 0);
  assert.ok(!client.exitResolved);
});

test("handleLine still tears down on a JSON-shaped but malformed line (preserved behavior)", () => {
  const client = new CollectingClient();
  client.handleLine('{"method": }');
  assert.ok(client.exitResolved, "a line that looks like JSON but fails to parse is a real protocol error");
  assert.match(client.exitError?.message ?? "", /Failed to parse/);
});

test("handleLine preserves a JSON-encoded ESC escape inside a string value", () => {
  const client = new CollectingClient();
  // JSON.stringify encodes a real ESC char as the 6 printable chars \u001b.
  // stripAnsi must not touch that, so the decoded value keeps its ESC char.
  const line = JSON.stringify({ method: "item/completed", params: { text: `a${ESC}b` } });
  client.handleLine(line);
  assert.equal(client.notifications.length, 1);
  assert.equal(client.notifications[0].params.text, `a${ESC}b`);
  assert.ok(!client.exitResolved);
});
