// Regression guard for the 2026-09-07 addition of Antigravity session
// discovery to `watchForSession` (src/main/session-watch.ts). Antigravity
// keeps one sqlite file per conversation under
// `~/.gemini/antigravity-cli/conversations/<id>.db`,
// with the conversation's working directory stored as a real protobuf
// length-delimited string field (tag byte 0x0a or 0x12, single-byte varint
// length, then that many raw UTF-8 bytes of a `file://<cwd>` URI) — see
// `findAntigravitySession`'s doc comment for how this was confirmed against
// 8 real conversation dbs on this machine.
//
// This test writes real (but uniquely-named, cleaned up after) `.db` files
// into that REAL directory — same pattern the Claude/Cursor collision tests
// already use for their own real directories — encoding the same byte
// layout by hand, no mock of `watchForSession` itself.
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { watchForSession } from "../../src/main/session-watch.ts";
import { makeChecker } from "./cdp-client.mjs";

const { check, finish } = makeChecker();

const conversationsDir = join(homedir(), ".gemini", "antigravity-cli", "conversations");
const FAKE_CWD = "/tmp/stellar-antigravity-smoke-fake-project";

function encodeConversationDb(cwdUri) {
  const strBytes = Buffer.from(cwdUri, "utf8");
  if (strBytes.length >= 128) throw new Error("test cwd too long for single-byte varint length");
  // Padding before/after mimics the real files, where this field sits deep
  // inside a larger sqlite page alongside unrelated bytes — makes sure the
  // scan doesn't rely on the field being at offset 0.
  return Buffer.concat([
    Buffer.from("sqlite-page-padding-before-field\n"),
    Buffer.from([0x0a, strBytes.length]),
    strBytes,
    Buffer.from("\x1a\x00trailing-bytes-after-field"),
  ]);
}

function writeConversationFile(id, cwdUri, mtimeMs) {
  const path = join(conversationsDir, `${id}.db`);
  writeFileSync(path, encodeConversationDb(cwdUri));
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

mkdirSync(conversationsDir, { recursive: true });
const idA = "smoke-test-antigravity-A";
const idB = "smoke-test-antigravity-B";
const idOther = "smoke-test-antigravity-other-cwd";
const pathA = join(conversationsDir, `${idA}.db`);
const pathB = join(conversationsDir, `${idB}.db`);
const pathOther = join(conversationsDir, `${idOther}.db`);

try {
  const t0 = Date.now();

  // A candidate for a DIFFERENT cwd, newer than ours — must never be picked.
  writeConversationFile(idOther, "file:///tmp/stellar-antigravity-smoke-OTHER-project", t0 + 500);
  // Our own cwd's session file, appears shortly after spawn.
  writeConversationFile(idA, `file://${FAKE_CWD}`, t0 + 200);

  const found = await new Promise((resolve) => {
    const stop = watchForSession("antigravity", FAKE_CWD, t0, resolve);
    setTimeout(() => {
      stop();
      resolve(null);
    }, 6000);
  });

  check("discovered the id matching our own cwd", found, idA);

  // A second, later conversation for the same cwd — a fresh watcher spawned
  // now (baseline after A was already claimed) must find B, never re-claim A.
  const spawnedAtB = Date.now();
  writeConversationFile(idB, `file://${FAKE_CWD}`, spawnedAtB + 300);

  const foundB = await new Promise((resolve) => {
    const stop = watchForSession("antigravity", FAKE_CWD, spawnedAtB, resolve);
    setTimeout(() => {
      stop();
      resolve(null);
    }, 6000);
  });

  check("a later watcher for the same cwd discovers the NEW id, not the already-claimed one", foundB, idB);
} finally {
  rmSync(pathA, { force: true });
  rmSync(pathB, { force: true });
  rmSync(pathOther, { force: true });
}

finish();
