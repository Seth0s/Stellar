// agent-canvas mobile client — Phase A (LAN only), DESIGN-BACKLOG.md item 2.
// Deliberately not a build output: plain script, no bundler, so this can be
// served as-is by remote-server.ts with zero build step. Talks to the same
// terminal state the desktop app and `acbridge` do, over one WebSocket —
// not a pixel mirror (see remote-server.ts's doc comment for why).

const TOKEN_KEY = "ac-remote-token";

function getToken() {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    history.replaceState(null, "", location.pathname);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY);
}

const els = {
  status: document.getElementById("status"),
  back: document.getElementById("back"),
  title: document.getElementById("title"),
  authError: document.getElementById("auth-error"),
  list: document.getElementById("list"),
  termView: document.getElementById("term-view"),
  termContainer: document.getElementById("term"),
  keys: document.getElementById("keys"),
};

const token = getToken();
let ws = null;
let cards = [];
let openId = null;
let term = null;
let fitAddon = null;
let reconnectDelay = 1000;

const SPECIAL_KEYS = {
  Escape: "\x1b",
  Tab: "\t",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowLeft: "\x1b[D",
  ArrowRight: "\x1b[C",
  "Control+C": "\x03",
};

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = "status " + cls;
}

function renderList() {
  els.list.innerHTML = "";
  if (cards.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nenhum terminal rodando agora.";
    els.list.appendChild(li);
    return;
  }
  for (const c of cards) {
    const li = document.createElement("li");
    li.className = "card-row";
    const name = document.createElement("div");
    name.className = "card-row-name";
    name.textContent = c.label || c.provider;
    const cwd = document.createElement("div");
    cwd.className = "card-row-cwd";
    cwd.textContent = c.cwd;
    li.appendChild(name);
    li.appendChild(cwd);
    li.addEventListener("click", () => openTerminal(c.id));
    els.list.appendChild(li);
  }
}

function connect() {
  if (!token) {
    els.authError.classList.remove("hidden");
    setStatus("sem token", "offline");
    return;
  }
  setStatus("conectando…", "offline");
  // Not hardcoded to ws:// — Phase B (DESIGN-BACKLOG.md item 2) reaches
  // this same server through a TLS-terminating tunnel (Tailscale
  // Funnel/Cloudflare Tunnel), where the page itself loads over https:,
  // and a plain ws:// call from an https: page is mixed content most
  // browsers refuse outright. Matching the page's own scheme costs
  // nothing on LAN (still ws://) and is what makes the tunnel case work
  // at all without a second code path.
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${wsProto}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.addEventListener("open", () => {
    reconnectDelay = 1000;
    setStatus("conectado", "online");
    els.authError.classList.add("hidden");
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "cards") {
      cards = msg.cards;
      if (!openId) renderList();
    } else if (msg.type === "pty:data" && msg.id === openId && term) {
      term.write(msg.data);
    } else if (msg.type === "pty:exit" && msg.id === openId && term) {
      term.write(`\r\n\x1b[90m[processo encerrado, código ${msg.exitCode}]\x1b[0m\r\n`);
    }
  });

  ws.addEventListener("close", (ev) => {
    if (ev.code === 4001) {
      setStatus("acesso revogado", "offline");
      els.authError.classList.remove("hidden");
      localStorage.removeItem(TOKEN_KEY);
      return;
    }
    setStatus("reconectando…", "offline");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
  });

  ws.addEventListener("error", () => ws.close());
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function openTerminal(id) {
  openId = id;
  const card = cards.find((c) => c.id === id);
  els.title.textContent = card ? card.label || card.provider : "";
  els.list.classList.add("hidden");
  els.termView.classList.remove("hidden");
  els.back.classList.remove("hidden");

  term = new Terminal({
    convertEol: true,
    fontSize: 13,
    fontFamily: "monospace",
    theme: { background: "#0a0b0d", foreground: "#e6e6e6" },
    scrollback: 2000,
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(els.termContainer);
  fitAddon.fit();
  send({ type: "pty:resize", id, cols: term.cols, rows: term.rows });

  term.onData((data) => send({ type: "pty:write", id, data }));
}

function closeTerminal() {
  openId = null;
  els.termView.classList.add("hidden");
  els.back.classList.add("hidden");
  els.title.textContent = "";
  els.list.classList.remove("hidden");
  term?.dispose();
  term = null;
  fitAddon = null;
  renderList();
}

els.back.addEventListener("click", closeTerminal);

for (const btn of els.keys.querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    if (!openId) return;
    send({ type: "pty:write", id: openId, data: SPECIAL_KEYS[btn.dataset.key] ?? "" });
    term?.focus();
  });
}

window.addEventListener("resize", () => {
  if (!fitAddon || !openId) return;
  fitAddon.fit();
  send({ type: "pty:resize", id: openId, cols: term.cols, rows: term.rows });
});

renderList();
connect();
