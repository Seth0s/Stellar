// HTTP-level probe of the real backend's GitHub login flow, exactly as the app
// does it (loopback listener + PKCE S256), to de-risk before driving Electron.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const SCRATCH = "/tmp/commandcode-1000/-home-lucas-Workplace-Projects-Stellar/120e41f8-0ce6-4bf3-b1a8-4803a9363a9c/scratchpad";
const API = `http://127.0.0.1:${Number((await import("node:fs")).readFileSync(`${SCRATCH}/apiport`, "utf8").trim())}`;
const GH = `http://127.0.0.1:${Number((await import("node:fs")).readFileSync(`${SCRATCH}/ghport`, "utf8").trim())}`;

let captured = null;
const listener = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/cb") {
    captured = { code: u.searchParams.get("code"), state: u.searchParams.get("state") };
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
const redirectUri = `http://127.0.0.1:${port}/cb`;

const state = randomBytes(32).toString("base64url");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
const userId = crypto.randomUUID();

const startUrl = new URL("/v1/auth/start", API);
startUrl.searchParams.set("provider", "github");
startUrl.searchParams.set("redirect_uri", redirectUri);
startUrl.searchParams.set("state", state);
startUrl.searchParams.set("code_challenge", challenge);
startUrl.searchParams.set("code_challenge_method", "S256");
startUrl.searchParams.set("user_id", userId);

// 1) app -> backend start -> 302 GH
const r1 = await fetch(startUrl, { redirect: "manual" });
console.log("start:", r1.status, r1.headers.get("location"));
const ghUrl = r1.headers.get("location");

// 2) "browser" -> GH authorize -> 302 backend callback
const r2 = await fetch(ghUrl, { redirect: "manual" });
console.log("gh authorize:", r2.status, r2.headers.get("location"));
const cbUrl = r2.headers.get("location");

// 3) browser -> backend callback -> 302 loopback
const r3 = await fetch(cbUrl, { redirect: "manual" });
console.log("backend callback:", r3.status, r3.headers.get("location"));
const loopUrl = r3.headers.get("location");

// 4) browser -> loopback (our listener captures code)
await fetch(loopUrl, { redirect: "follow" });
console.log("captured:", captured);

// 5) app -> POST /v1/auth/token
const tokenRes = await fetch(`${API}/v1/auth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    grant_type: "authorization_code",
    code: captured.code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    install_id: crypto.randomUUID(),
    device_label: "probe",
  }),
});
console.log("token:", tokenRes.status, await tokenRes.clone().text());
const pair = await tokenRes.json();

// 6) GET /v1/me
const me = await fetch(`${API}/v1/me`, { headers: { Authorization: `Bearer ${pair.access_token}` } });
console.log("me:", me.status, JSON.stringify(await me.json(), null, 2));

listener.close();
