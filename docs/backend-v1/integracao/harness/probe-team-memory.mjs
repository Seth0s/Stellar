// Independent HTTP checks against the REAL backend:
//  (a) a house manifest that references a *_memory_* path is REFUSED in the team base;
//  (b) GET/PUT /v1/profiles/<unknown-id>/house -> 404 (why the app's local profile id fails).
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const SCRATCH = "/tmp/commandcode-1000/-home-lucas-Workplace-Projects-Stellar/120e41f8-0ce6-4bf3-b1a8-4803a9363a9c/scratchpad";
const API = `http://127.0.0.1:${readFileSync(`${SCRATCH}/apiport`, "utf8").trim()}`;

async function login() {
  let captured = null;
  const listener = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/cb") { captured = { code: u.searchParams.get("code"), state: u.searchParams.get("state") }; res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  const redirectUri = `http://127.0.0.1:${port}/cb`;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  const start = new URL("/v1/auth/start", API);
  start.searchParams.set("provider", "github");
  start.searchParams.set("redirect_uri", redirectUri);
  start.searchParams.set("state", state);
  start.searchParams.set("code_challenge", challenge);
  start.searchParams.set("code_challenge_method", "S256");
  start.searchParams.set("user_id", randomUUID());
  let url = start.toString();
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { redirect: "manual" });
    const loc = r.headers.get("location");
    if (!loc) { await r.arrayBuffer(); break; }
    url = loc;
    if (loc.startsWith(redirectUri)) { await fetch(loc, { redirect: "follow" }); break; }
  }
  const tok = await fetch(`${API}/v1/auth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code: captured.code, code_verifier: verifier, redirect_uri: redirectUri, install_id: randomUUID(), device_label: "probe" }),
  });
  const pair = await tok.json();
  listener.close();
  return pair.access_token;
}

const token = await login();
const auth = { Authorization: `Bearer ${token}` };
const put = (sha, body) => fetch(`${API}/v1/blobs/${sha}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream" }, body });

// (b) unknown profile id
const unknown = randomUUID();
const getHouse = await fetch(`${API}/v1/profiles/${unknown}/house`, { headers: auth });
console.log("(b) GET /v1/profiles/<id-unknown>/house ->", getHouse.status, await getHouse.text());

// create a team
const teamRes = await fetch(`${API}/v1/teams`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Memory Probe", slug: `memprobe-${Date.now().toString(36)}` }) });
const team = await teamRes.json();
console.log("team:", teamRes.status, JSON.stringify(team));
const teamId = team.id ?? team.team?.id;

const content = "conteudo\n";
const sha = createHash("sha256").update(Buffer.from(content)).digest("hex");
await put(sha, content);

// (a1) valid rules-only manifest -> 200
const okManifest = { manifest: [{ tool: "claude", path: "{claude}/skills/x/SKILL.md", sha256: sha, size: content.length, mode: "100644" }] };
const putOk = await fetch(`${API}/v1/teams/${teamId}/house`, { method: "PUT", headers: { ...auth, "Content-Type": "application/json", "If-Match": "0" }, body: JSON.stringify(okManifest) });
console.log("(a1) PUT team house (rules only) ->", putOk.status, (await putOk.text()).slice(0, 200));

// (a2) memory path -> must be REFUSED
const memManifest = { manifest: [{ tool: "claude", path: "{claude}/projects/-home-u-proj/memory/notes.md", sha256: sha, size: content.length, mode: "100644" }] };
const putMem = await fetch(`${API}/v1/teams/${teamId}/house`, { method: "PUT", headers: { ...auth, "Content-Type": "application/json", "If-Match": "1" }, body: JSON.stringify(memManifest) });
console.log("(a2) PUT team house (memory) ->", putMem.status, (await putMem.text()).slice(0, 300));
