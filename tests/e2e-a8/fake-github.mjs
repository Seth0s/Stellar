// Fake GitHub OAuth server for the A8 E2E (measurement only). Copy of the E v2
// harness server (docs/backend-v1/integracao/harness/fake-github.mjs), kept in
// tests/e2e-a8/ so nothing under docs/ is edited.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 0);
const state = {
  next: { id: 1234567, login: "alice-gh", name: "Alice GitHub", email: "alice@example.com" },
  default: { id: 1234567, login: "alice-gh", name: "Alice GitHub", email: "alice@example.com" },
  codes: new Map(),
};

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");

    if (url.pathname === "/__control" && req.method === "POST") {
      try {
        const body = JSON.parse(raw || "{}");
        if (body.user) state.next = body.user;
        return json(res, 200, { ok: true, next: state.next });
      } catch {
        return json(res, 400, { error: "bad json" });
      }
    }

    if (url.pathname.startsWith("/login/oauth/authorize")) {
      const redirectUri = url.searchParams.get("redirect_uri");
      const ghState = url.searchParams.get("state");
      const identity = state.next ?? state.default;
      state.next = state.default;
      const code = `ghcode-${Math.random().toString(36).slice(2)}`;
      state.codes.set(code, identity);
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", ghState ?? "");
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }

    if (url.pathname.startsWith("/login/oauth/access_token") && req.method === "POST") {
      const params = new URLSearchParams(raw);
      const code = params.get("code");
      const identity = state.codes.get(code) ?? state.default;
      state.codes.delete(code);
      state.lastIdentity = identity;
      return json(res, 200, { access_token: `ghtok-${code}`, token_type: "bearer", scope: "read:user,user:email" });
    }

    if (url.pathname === "/user") {
      const identity = state.next ?? state.default;
      const last = state.lastIdentity ?? identity;
      return json(res, 200, { id: last.id, login: last.login, name: last.name, email: last.email });
    }

    if (url.pathname === "/user/emails") {
      const identity = state.lastIdentity ?? state.default;
      return json(res, 200, [{ email: identity.email, primary: true, verified: true }]);
    }

    json(res, 404, { error: "not_found", path: url.pathname });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-github listening on ${port}`);
});
