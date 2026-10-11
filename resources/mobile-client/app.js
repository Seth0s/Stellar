// Stellar LAN mobile client — plain script (no bundler), served as-is by
// remote-server.ts. Mirrors the approved StellarMobile prototype chrome in
// 390×844. Speaks auth / cards / pty:* and ignores unknown messages; uses
// optional hello/tasks when the host wires them.

const TOKEN_KEY = "ac-remote-token";

const PROVIDER_AV = {
  commandcode: { bg: "#3a1f30", fg: "#f5a3cc", short: "CC" },
  claude: { bg: "#3d2414", fg: "#ffb27a", short: "CL" },
  antigravity: { bg: "#1b2547", fg: "#a9c1ff", short: "AG" },
  bash: { bg: "#1b2547", fg: "#a9c1ff", short: "SH" },
};

const SPECIAL_KEYS = {
  Escape: "\x1b",
  Tab: "\t",
  Enter: "\r",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowLeft: "\x1b[D",
  ArrowRight: "\x1b[C",
  "Control+C": "\x03",
};

function getToken() {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    history.replaceState(null, "", location.pathname + location.hash);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY);
}

function providerMeta(provider) {
  const key = String(provider || "").toLowerCase();
  if (PROVIDER_AV[key]) return PROVIDER_AV[key];
  const short = (provider || "?").slice(0, 2).toUpperCase();
  return { bg: "#2a3150", fg: "#c7d0ff", short };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const params = new URLSearchParams(location.search);
const forceEmpty = params.get("empty") === "1";

const state = {
  token: getToken(),
  view: getToken() && !forceEmpty ? "agora" : getToken() ? "agora" : "pair",
  connected: false,
  statusText: "conectando…",
  machineLabel: "desktop",
  cards: [],
  tasks: [],
  capabilities: { tasks: false, scrollback: false, verdict: false },
  chatFilter: "all",
  chatQuery: "",
  openId: null,
  openTaskId: null,
  drawer: false,
  keys: true,
  pairInput: "",
  pairError: "",
  forceEmpty,
};

const root = document.getElementById("view-root");
let ws = null;
let term = null;
let fitAddon = null;
let reconnectDelay = 1000;
let termBoundId = null;

function setStatus(text, online) {
  state.statusText = text;
  state.connected = !!online;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  if (!state.token) {
    setStatus("sem token", false);
    render();
    return;
  }
  setStatus("conectando…", false);
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${wsProto}//${location.host}/ws`);

  ws.addEventListener("open", () => {
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: "auth", token: state.token }));
    setStatus("conectado", true);
    if (state.view === "pair") state.view = "agora";
    render();
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      state.machineLabel = msg.device?.label || state.machineLabel;
      state.capabilities = msg.capabilities || state.capabilities;
    } else if (msg.type === "cards") {
      state.cards = msg.cards || [];
      if (state.view !== "chat") render();
      else renderChromeOnly();
    } else if (msg.type === "tasks") {
      state.tasks = msg.tasks || [];
      if (["tasks", "agora", "task"].includes(state.view)) render();
    } else if (msg.type === "task" && msg.task) {
      const idx = state.tasks.findIndex((t) => t.id === msg.task.id);
      if (idx >= 0) state.tasks[idx] = { ...state.tasks[idx], ...msg.task };
      else state.tasks.push(msg.task);
      if (state.view === "task") render();
    } else if (msg.type === "pty:data" && msg.id === state.openId && term) {
      term.write(msg.data);
    } else if (msg.type === "pty:scrollback" && msg.id === state.openId && term) {
      term.write(msg.data);
    } else if (msg.type === "pty:exit" && msg.id === state.openId && term) {
      term.write(`\r\n\x1b[90m[processo encerrado, código ${msg.exitCode}]\x1b[0m\r\n`);
    }
  });

  ws.addEventListener("close", (ev) => {
    if (ev.code === 4001) {
      setStatus("acesso revogado", false);
      localStorage.removeItem(TOKEN_KEY);
      state.token = null;
      state.view = "pair";
      state.pairError = "Token inválido ou revogado. Peça um novo QR no desktop.";
      render();
      return;
    }
    setStatus("reconectando…", false);
    renderChromeOnly();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
  });

  ws.addEventListener("error", () => ws.close());
}

function displayCards() {
  return state.forceEmpty ? [] : state.cards;
}
function displayTasks() {
  return state.forceEmpty ? [] : state.tasks;
}

function needItems() {
  const items = [];
  for (const c of displayCards()) {
    if (c.needKind === "question" || (c.awaitingHuman && c.needKind !== "none" && c.questionText)) {
      items.push({
        kind: "question",
        id: c.id,
        cardId: c.id,
        title: c.label || c.provider,
        meta: c.needMeta || "pergunta",
        body: c.questionText || c.preview || "",
        provider: c.provider,
        tone: "warn",
      });
    }
  }
  for (const t of displayTasks()) {
    if (t.needKind === "review" || /await|review|revis/i.test(t.phase || "")) {
      items.push({
        kind: "review",
        id: t.id,
        cardId: t.cardId,
        title: t.title,
        meta: t.needMeta || "report entregue",
        badge: t.badge,
        provider: t.provider,
        tone: "neutral",
      });
    } else if (t.needKind === "gate_fail") {
      items.push({
        kind: "gate_fail",
        id: t.id,
        cardId: t.cardId,
        title: t.title,
        meta: t.needMeta || "o report diz ok, o gate falhou",
        detail: t.gateDetail || "",
        provider: t.provider,
        tone: "danger",
      });
    }
  }
  return items;
}

function runningCards() {
  // Cards already shown in the needs section stay out of this list so the
  // two Agora sections do not double-count the same agent.
  const inNeed = new Set(needItems().map((i) => i.cardId).filter(Boolean));
  return displayCards().filter(
    (c) => c.status === "running" && !inNeed.has(c.id),
  );
}

function waitingCards() {
  return displayCards().filter((c) => c.awaitingHuman || c.status === "waiting");
}

function filteredChats() {
  let list = displayCards();
  if (state.chatFilter === "waiting") list = waitingCards();
  else if (state.chatFilter === "running") list = runningCards();
  const q = state.chatQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (c) =>
        (c.label || "").toLowerCase().includes(q) ||
        (c.preview || "").toLowerCase().includes(q) ||
        (c.taskTitle || "").toLowerCase().includes(q) ||
        (c.provider || "").toLowerCase().includes(q),
    );
  }
  return list;
}

function groupChats(cards) {
  const map = new Map();
  for (const c of cards) {
    const board = c.boardName || "Sessão";
    const host = c.machineName || state.machineLabel || "desktop";
    const key = `${board}\0${host}\0${c.machineOffline ? "1" : "0"}\0${c.machineOfflineSince || ""}`;
    if (!map.has(key)) map.set(key, { board, host, offline: !!c.machineOffline, since: c.machineOfflineSince || "", cards: [] });
    map.get(key).cards.push(c);
  }
  return [...map.values()];
}

function tabbar(active) {
  const tabs = [
    ["agora", "Agora", '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>'],
    ["chats", "Chats", '<path d="M4 5h16v11H9l-5 4z"/>'],
    ["tasks", "Tasks", '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>'],
    ["settings", "Ajustes", '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>'],
  ];
  return `<nav class="tabbar" aria-label="Navegação">${tabs
    .map(
      ([id, label, path]) =>
        `<button type="button" class="tab${active === id ? " active" : ""}" data-nav="${id}" data-el="tab-${id}" ${
          active === id ? 'aria-current="page"' : ""
        }><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${path}</svg>${label}</button>`,
    )
    .join("")}</nav>`;
}

function avHtml(provider, statusColor) {
  const m = providerMeta(provider);
  return `<span class="av" style="background:${m.bg};color:${m.fg}">${m.short}${
    statusColor ? `<span class="st" style="background:${statusColor}"></span>` : ""
  }</span>`;
}

function btn(label, { primary, disabled, action, openChat, openTask, tip } = {}) {
  const cls = `btn${primary ? " primary" : ""}`;
  const title = tip || (disabled ? "Ainda não disponível neste canal" : "");
  if (disabled) {
    return `<button class="${cls}" type="button" disabled title="${escapeHtml(title)}" data-el="btn">${escapeHtml(label)}</button>`;
  }
  const attrs = [
    action ? `data-action="${escapeHtml(action)}"` : "",
    openChat ? `data-open-chat="${escapeHtml(openChat)}"` : "",
    openTask ? `data-open-task="${escapeHtml(openTask)}"` : "",
    `data-el="btn${primary ? "-primary" : ""}"`,
  ]
    .filter(Boolean)
    .join(" ");
  return `<button class="${cls}" type="button" ${attrs}>${escapeHtml(label)}</button>`;
}

function renderNeedCard(item) {
  const m = providerMeta(item.provider);
  const border =
    item.tone === "warn"
      ? "border-color:#4a3f1c;background:#15130c"
      : item.tone === "danger"
        ? "border-color:#4a2226;background:#170f11"
        : "";
  const canChat = !!item.cardId;
  const canVerdict = !!state.capabilities.verdict;
  const canAnswer = !!item.cardId;

  let actions = "";
  if (item.kind === "question") {
    actions = `<div class="need-actions" style="display:flex;gap:8px">
      ${btn("Sim", { primary: true, disabled: !canAnswer, openChat: item.cardId, tip: canAnswer ? "" : "Resposta pelo chat quando o desktop ligar o canal" })}
      ${btn("Não", { disabled: !canAnswer, openChat: item.cardId })}
      ${btn("Abrir chat", { disabled: !canChat, openChat: item.cardId })}
    </div>`;
  } else if (item.kind === "review") {
    actions = `<div class="need-actions" style="display:flex;gap:8px">
      ${btn("Revisar", { primary: true, disabled: !item.id, openTask: item.id, tip: state.capabilities.tasks ? "" : "Revisão quando tasks chegarem neste canal" })}
      ${btn("Abrir chat", { disabled: !canChat, openChat: item.cardId })}
    </div>`;
  } else {
    actions = `<div class="need-actions" style="display:flex;gap:8px">
      ${btn("Ver a falha", { disabled: !item.id, openTask: item.id })}
      ${btn("Falar com o agente", { disabled: !canChat, openChat: item.cardId })}
    </div>`;
  }

  const avatar =
    item.kind === "gate_fail"
      ? `<span class="av" style="background:#2e1517;color:#ff9b9b" data-el="list-item"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></span>`
      : avHtml(item.provider);

  return `<section class="need" data-el="list-item" style="${border}">
    <div style="display:flex;align-items:center;gap:10px">
      ${avatar}
      <span style="flex:1;display:flex;flex-direction:column;gap:1px">
        <span style="font-size:14px;font-weight:600">${escapeHtml(item.title)}</span>
        <span style="font-size:12px;color:var(--muted)">${escapeHtml(item.meta)}</span>
      </span>
      ${item.badge ? `<span class="chip" style="background:#18301f;color:var(--ok)">${escapeHtml(item.badge)}</span>` : ""}
    </div>
    ${item.body ? `<p class="need-body" style="margin:0;font-size:14.5px;line-height:1.45">${escapeHtml(item.body)}</p>` : ""}
    ${item.detail ? `<span style="font-family:var(--mono);font-size:11.5px;color:#e0b0b0">${escapeHtml(item.detail)}</span>` : ""}
    ${actions}
  </section>`;
}

function renderPair() {
  return `<div class="screen" data-screen="pair">
    <header class="screen-header" style="padding:28px 24px 8px;gap:8px">
      <h1 data-el="title">Parear com o desktop</h1>
      <p class="sub" data-el="subtitle" style="margin:0;font-size:14px;line-height:1.5">Uma vez por celular. Depois ele entra sozinho, de qualquer rede.</p>
    </header>
    <main class="screen-main" style="padding:16px 24px;gap:18px">
      <ol class="pair-steps">
        <li class="step"><span class="num done"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3.5 8.5l3 3 6-7"/></svg></span>
          <span><span style="font-size:14.5px;display:block">Pronto para parear</span>
          <span style="font-size:12.5px;color:var(--dim)">Fase A · servidor LAN do desktop</span></span></li>
        <li class="step"><span class="num">2</span>
          <span><span style="font-size:14.5px;display:block">No desktop, abra Ajustes › Celular › Parear</span>
          <span style="font-size:12.5px;color:var(--dim)">Ele mostra um QR com o link deste servidor.</span></span></li>
        <li class="step"><span class="num">3</span><span style="font-size:14.5px">Escaneie o QR ou cole o link abaixo</span></li>
      </ol>
      <div class="qr-frame" role="img" aria-label="Ilustração do QR do desktop" data-el="list-item">
        <div class="qr-corners">
          <span class="c tl"></span><span class="c tr"></span><span class="c bl"></span><span class="c br"></span>
          <div class="qr-dots" aria-hidden="true">${Array.from({ length: 49 }, (_, i) => {
            const on = [0, 2, 3, 5, 6, 8, 10, 11, 13, 14, 15, 18, 19, 22, 23, 24, 26, 27, 28, 30, 32, 34, 35, 37, 38, 41, 42, 44, 45, 46].includes(i);
            return on ? '<span class="on"></span>' : "<span></span>";
          }).join("")}</div>
        </div>
        <span class="qr-caption">lendo…</span>
      </div>
      <input class="pair-input" id="pair-url" type="text" placeholder="http://…/?token=…" value="${escapeHtml(state.pairInput)}" autocomplete="off" data-el="search" />
      ${state.pairError ? `<p class="empty" style="padding:0;color:var(--warn)">${escapeHtml(state.pairError)}</p>` : ""}
      <div class="pair-box">Só quem tem o token do QR consegue ver ou digitar nos terminais desta máquina.</div>
    </main>
    <footer class="pair-footer">
      <button class="btn primary" type="button" data-action="pair-confirm" data-el="btn-primary" style="min-height:48px;border-radius:12px;font-size:15px">Entrar com este link</button>
      <span style="font-size:12px;text-align:center;color:var(--dim)">O token fica só neste aparelho.</span>
    </footer>
  </div>`;
}

function renderAgora() {
  const need = needItems();
  const run = runningCards();
  return `<div class="screen" data-screen="agora">
    <header class="screen-header">
      <div style="display:flex;align-items:center;gap:10px">
        <h1 style="flex:1" data-el="title">Agora</h1>
        <span class="machine-pill" data-el="machine"><span class="dot"></span>${escapeHtml(state.machineLabel)}</span>
      </div>
      <span class="sub" data-el="subtitle">O que precisa de você e o que está rodando.</span>
    </header>
    <main class="screen-main" style="padding:8px 16px 16px;gap:10px">
      <h2 class="sec" data-el="chip">Precisa de você <span style="color:var(--warn)">${need.length}</span></h2>
      ${need.length === 0 ? `<p class="empty" style="padding:16px">Nada esperando você agora.</p>` : need.map(renderNeedCard).join("")}
      <h2 class="sec">Rodando agora <span style="color:var(--link)">${run.length}</span></h2>
      <nav class="run-box" aria-label="Agentes rodando">
      ${
        run.length === 0
          ? `<p class="empty" style="padding:16px">Nenhum terminal rodando.</p>`
          : run
              .map(
                (c) => `<button type="button" class="run" data-open-chat="${c.id}" data-el="list-item">
            ${avHtml(c.provider)}
            <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
              <span style="font-size:14px">${escapeHtml(c.label || c.provider)}</span>
              <span style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(
                c.preview || c.cwd || "",
              )}</span>
            </span>
            <span style="font-size:11.5px;color:var(--dim)">${escapeHtml(c.ageLabel || "")}</span>
          </button>`,
              )
              .join("")
      }
      </nav>
    </main>
    ${tabbar("agora")}
  </div>`;
}

function renderChats() {
  const cards = filteredChats();
  const groups = groupChats(cards);
  const waitingN = waitingCards().length;
  let body = "";
  if (cards.length === 0) {
    body = `<p class="empty">Nenhum chat nesta sessão.</p>`;
  } else {
    for (const g of groups) {
      const head = g.offline
        ? `<h2 class="grp" style="opacity:.7" data-el="list-item"><span style="color:#c9cede;font-weight:600">${escapeHtml(g.host)}</span> · offline${g.since ? ` desde ${escapeHtml(g.since)}` : ""}</h2>`
        : `<h2 class="grp" data-el="list-item"><span style="color:var(--text);font-weight:600">${escapeHtml(g.board)}</span> · ${escapeHtml(g.host)}</h2>`;
      body += head;
      body += g.cards
        .map((c) => {
          const waiting = !!(c.awaitingHuman || c.status === "waiting");
          const running = c.status === "running";
          const st = waiting ? "var(--warn)" : running ? "#6f86ff" : "#5a6070";
          const age = waiting ? "var(--warn)" : "var(--dim)";
          return `<button type="button" class="c" data-open-chat="${c.id}" data-el="list-item" ${g.offline ? 'style="opacity:.55"' : ""}>
            ${avHtml(c.provider, st)}
            <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px">
              <span style="display:flex;gap:8px">
                <span style="flex:1;font-size:15px;font-weight:600">${escapeHtml(c.label || c.provider)}</span>
                <span style="font-size:11.5px;color:${age}">${escapeHtml(c.ageLabel || (waiting ? "espera" : "ativo"))}</span>
              </span>
              <span class="pv" style="${waiting ? "color:#e6d39a" : ""}">${escapeHtml(c.preview || c.cwd || c.provider)}</span>
            </span>
            ${c.badgeCount ? `<span class="badge-count">${escapeHtml(String(c.badgeCount))}</span>` : ""}
          </button>`;
        })
        .join("");
    }
  }
  return `<div class="screen" data-screen="chats">
    <header class="screen-header" style="padding:22px 20px 8px;gap:10px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <h1 data-el="title">Chats</h1>
        <span class="sub" data-el="subtitle">Uma conversa por agente, de todas as máquinas.</span>
      </div>
      <label for="q" class="sr-only">Buscar agente</label>
      <input id="q" class="search" data-el="search" placeholder="Buscar agente ou task" value="${escapeHtml(state.chatQuery)}" />
      <div style="display:flex;gap:8px">
        <button class="fchip" type="button" data-chat-filter="all" data-el="chip" aria-pressed="${state.chatFilter === "all"}">Todos</button>
        <button class="fchip" type="button" data-chat-filter="waiting" data-el="chip" aria-pressed="${state.chatFilter === "waiting"}">Esperando <span style="color:var(--warn)">${waitingN}</span></button>
        <button class="fchip" type="button" data-chat-filter="running" data-el="chip" aria-pressed="${state.chatFilter === "running"}">Rodando</button>
      </div>
    </header>
    <main class="screen-main" style="padding:0 16px 16px">${body}</main>
    ${tabbar("chats")}
  </div>`;
}

function renderChat() {
  const card = displayCards().find((c) => c.id === state.openId);
  const waiting = !!(card && (card.awaitingHuman || card.status === "waiting"));
  const title = card ? card.label || card.provider : "";
  const sub = card
    ? `${card.provider}${card.boardName ? " · " + card.boardName : ""}${waiting ? ' · <span style="color:var(--warn)">espera você</span>' : ""}`
    : "";
  const drawer = state.drawer
    ? `<div class="drawer-backdrop">
        <nav class="drawer" aria-label="Agentes">
          <span style="padding:0 6px;font-size:18px;font-weight:600">Agentes</span>
          <span style="padding:0 6px 6px;font-size:12px;color:var(--dim)">${escapeHtml(card?.boardName || "Sessão")} · ${escapeHtml(
            card?.machineName || state.machineLabel,
          )}</span>
          ${displayCards()
            .map((c) => {
              const w = !!(c.awaitingHuman || c.status === "waiting");
              return `<button type="button" class="dr${c.id === state.openId ? " current" : ""}" data-open-chat="${c.id}">
                ${avHtml(c.provider, w ? "var(--warn)" : undefined)}
                <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px">
                  <span style="font-size:14px">${escapeHtml(c.label || c.provider)}</span>
                  <span style="font-size:11.5px;color:${w ? "var(--warn)" : "var(--link)"}">${w ? "espera você" : "rodando"}</span>
                </span>
              </button>`;
            })
            .join("")}
          <button type="button" class="btn" style="margin-top:8px" data-nav="chats">Todos os chats</button>
        </nav>
        <button type="button" class="drawer-scrim" data-action="close-drawer" aria-label="Fechar"></button>
      </div>`
    : "";

  return `<div class="screen relative" data-screen="chat">
    <header class="chat-header">
      <button class="ib" type="button" data-action="open-drawer" aria-label="Agentes"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h10"/></svg></button>
      ${card ? avHtml(card.provider, waiting ? "var(--warn)" : undefined) : ""}
      <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px">
        <span style="font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" data-el="title">${escapeHtml(title)}</span>
        <span style="font-size:11.5px;color:var(--dim)" data-el="subtitle">${sub}</span>
      </span>
      <button class="ib" type="button" data-nav="chats" aria-label="Voltar"><svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M11 7H3M6.5 3.5L3 7l3.5 3.5"/></svg></button>
    </header>
    <section class="term-pane" aria-label="Terminal cru">
      <span class="hint">Terminal cru: menus e telas que ainda não viram mensagem de chat.</span>
      <div id="term"></div>
    </section>
    <footer class="chat-footer">
      ${
        state.keys
          ? `<div class="keys" role="group" aria-label="Teclas especiais">
            <button class="key" type="button" data-key="Escape">Esc</button>
            <button class="key" type="button" data-key="Control+C">Ctrl C</button>
            <button class="key" type="button" data-key="ArrowUp">↑</button>
            <button class="key" type="button" data-key="ArrowDown">↓</button>
            <button class="key" type="button" data-key="Tab">Tab</button>
            <button class="key" type="button" data-key="Enter">Enter</button>
          </div>`
          : ""
      }
      <div class="composer">
        <button class="ib" type="button" data-action="toggle-keys" aria-pressed="${state.keys}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/></svg></button>
        <textarea id="composer" rows="1" placeholder="Mensagem para o agente"></textarea>
        <button class="send" type="button" data-action="send" data-el="btn-primary" aria-label="Enviar"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 13V3M4 7l4-4 4 4"/></svg></button>
      </div>
    </footer>
    ${drawer}
  </div>`;
}

function renderTasks() {
  const tasks = displayTasks();
  const offline = !state.connected;
  const review = tasks.filter((t) => t.needKind === "review" || /await|review|revis/i.test(t.phase || ""));
  const running = tasks.filter((t) => t.section === "running" || /run|doing/i.test(t.phase || ""));
  const ready = tasks.filter((t) => t.section === "ready" || (/ready|pronta|pending/i.test(t.phase || "") && !t.cardId));
  const blocked = tasks.filter((t) => t.section === "blocked");
  const hasAny = tasks.length > 0;
  return `<div class="screen" data-screen="tasks">
    <header class="screen-header" style="padding:20px 20px 10px;gap:12px">
      <div><h1 data-el="title">Tasks</h1><span class="sub" data-el="subtitle">O que os agentes fazem e o que espera sua revisão.</span></div>
      <div class="segbar" role="tablist">
        <button class="seg" type="button" role="tab" aria-selected="true" data-el="chip">Ativas</button>
        <button class="seg" type="button" role="tab" aria-selected="false" disabled>Do time</button>
        <button class="seg" type="button" role="tab" aria-selected="false" disabled>Concluídas</button>
      </div>
    </header>
    <main class="screen-main">
      ${
        !hasAny
          ? `<p class="empty">${
              offline
                ? "Desconectado do desktop. Reconecte para ver a sessão."
                : "Nenhuma task neste canal ainda."
            }</p>`
          : ""
      }
      ${
        review.length
          ? `<h2 class="sec">Aguardando revisão <span style="color:var(--warn)">${review.length}</span></h2>` +
            review
              .map(
                (t) => `<button type="button" class="t" data-open-task="${t.id}" data-el="list-item" style="border-color:#4a3f1c">
              <span style="font-size:14.5px">${escapeHtml(t.title)}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">${(t.chips || [t.phase])
                .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
                .join("")}</div>
            </button>`,
              )
              .join("")
          : ""
      }
      ${
        running.length
          ? `<h2 class="sec">Rodando <span style="color:var(--link)">${running.length}</span></h2>` +
            running
              .map(
                (t) => `<button type="button" class="t" data-open-task="${t.id}" data-el="list-item">
              <span style="font-size:14.5px">${escapeHtml(t.title)}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">${(t.chips || [t.phase])
                .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
                .join("")}</div>
            </button>`,
              )
              .join("")
          : ""
      }
      ${
        ready.length
          ? `<h2 class="sec">Prontas para despachar <span style="color:#c9cede">${ready.length}</span></h2>` +
            ready
              .map(
                (t) => `<button type="button" class="t" data-el="list-item" disabled title="Despacho quando o desktop ligar o canal">
              <span style="font-size:14.5px">${escapeHtml(t.title)}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap"><span class="chip">sem card</span><span style="font-size:12.5px;color:var(--link)">despachar</span></div>
            </button>`,
              )
              .join("")
          : ""
      }
      ${
        blocked.length
          ? `<h2 class="sec">Esperando dependência <span style="color:#c9cede">${blocked.length}</span></h2>` +
            blocked
              .map(
                (t) => `<div class="t" style="background:#0f1218" data-el="list-item">
              <span style="font-size:14px;color:var(--muted)">${escapeHtml(t.title)}</span>
              <span style="font-size:12px;color:var(--dim)">${escapeHtml(t.needMeta || "")}</span>
            </div>`,
              )
              .join("")
          : ""
      }
    </main>
    ${tabbar("tasks")}
  </div>`;
}

function renderSettings() {
  return `<div class="screen" data-screen="settings">
    <header class="screen-header">
      <h1 data-el="title">Ajustes</h1>
      <span class="sub" data-el="subtitle">Conexão local, aparelho e segurança desta fase.</span>
    </header>
    <main class="screen-main" style="gap:14px">
      <h2 class="sec">Conexão</h2>
      <div class="settings-grp">
        <div class="settings-li" data-el="list-item">
          <span style="width:8px;height:8px;border-radius:50%;background:${state.connected ? "var(--ok)" : "#5a6070"}"></span>
          <span style="flex:1;display:flex;flex-direction:column;gap:2px">
            <span>${state.connected ? "Desktop na rede local" : "Desconectado"}</span>
            <span style="font-family:var(--mono);font-size:11px;color:var(--dim)">${escapeHtml(state.machineLabel)} · ${escapeHtml(
              state.statusText,
            )}</span>
          </span>
        </div>
      </div>
      <h2 class="sec">Este celular</h2>
      <div class="settings-grp">
        <div class="settings-li">
          <span style="flex:1;font-size:14.5px">Esquecer o token deste aparelho</span>
          <button class="link-btn" type="button" data-action="forget">Desparear</button>
        </div>
      </div>
      <p style="padding:0 4px;font-size:12px;line-height:1.5;color:var(--dim)">Conta, push e biometria entram com o relay. Nesta fase o pareamento é o QR do desktop na LAN.</p>
    </main>
    ${tabbar("settings")}
  </div>`;
}

function disposeTerm() {
  term?.dispose();
  term = null;
  fitAddon = null;
  termBoundId = null;
}

function mountTerm() {
  const el = document.getElementById("term");
  if (!el || !state.openId) return;
  if (term && termBoundId === state.openId) {
    fitAddon?.fit();
    return;
  }
  disposeTerm();
  term = new Terminal({
    convertEol: true,
    fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace",
    theme: { background: "#07080c", foreground: "#c9cede", cursor: "#a9b8ff" },
    scrollback: 4000,
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(el);
  fitAddon.fit();
  termBoundId = state.openId;
  send({ type: "pty:subscribe", id: state.openId });
  send({ type: "pty:resize", id: state.openId, cols: term.cols, rows: term.rows });
  term.onData((data) => send({ type: "pty:write", id: state.openId, data }));
}

function renderChromeOnly() {
  const pill = root.querySelector(".machine-pill");
  if (pill && state.connected) pill.classList.add("online");
}

function render() {
  let html;
  switch (state.view) {
    case "pair":
      html = renderPair();
      break;
    case "agora":
      html = renderAgora();
      break;
    case "chats":
      html = renderChats();
      break;
    case "chat":
      html = renderChat();
      break;
    case "tasks":
      html = renderTasks();
      break;
    case "settings":
      html = renderSettings();
      break;
    default:
      html = renderAgora();
  }
  if (state.view !== "chat") disposeTerm();
  root.innerHTML = html;
  if (state.view === "chat") requestAnimationFrame(() => mountTerm());
  bind();
}

function bind() {
  root.querySelectorAll("[data-nav]").forEach((el) => {
    el.addEventListener("click", () => {
      state.view = el.getAttribute("data-nav");
      state.drawer = false;
      if (state.view !== "chat") state.openId = null;
      render();
    });
  });
  root.querySelectorAll("[data-open-chat]").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.disabled) return;
      state.openId = el.getAttribute("data-open-chat");
      state.view = "chat";
      state.drawer = false;
      render();
    });
  });
  root.querySelectorAll("[data-open-task]").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.disabled) return;
      state.openTaskId = el.getAttribute("data-open-task");
      state.view = "tasks";
      send({ type: "task:get", id: state.openTaskId });
      render();
    });
  });
  root.querySelectorAll("[data-chat-filter]").forEach((el) => {
    el.addEventListener("click", () => {
      state.chatFilter = el.getAttribute("data-chat-filter");
      render();
    });
  });
  root.querySelectorAll("[data-key]").forEach((el) => {
    el.addEventListener("click", () => {
      if (!state.openId) return;
      send({ type: "pty:write", id: state.openId, data: SPECIAL_KEYS[el.getAttribute("data-key")] ?? "" });
      term?.focus();
    });
  });
  root.querySelector("[data-action='pair-confirm']")?.addEventListener("click", () => {
    const raw = (document.getElementById("pair-url")?.value || state.pairInput || "").trim();
    state.pairInput = raw;
    let token = raw;
    try {
      if (raw.includes("token=")) token = new URL(raw).searchParams.get("token") || raw;
    } catch {
      /* bare */
    }
    if (!token) {
      state.pairError = "Cole o link do QR ou o token.";
      render();
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    state.token = token;
    state.pairError = "";
    connect();
    render();
  });
  root.querySelector("[data-action='forget']")?.addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
    state.view = "pair";
    ws?.close();
    render();
  });
  root.querySelector("[data-action='open-drawer']")?.addEventListener("click", () => {
    state.drawer = true;
    render();
  });
  root.querySelector("[data-action='close-drawer']")?.addEventListener("click", () => {
    state.drawer = false;
    render();
  });
  root.querySelector("[data-action='toggle-keys']")?.addEventListener("click", () => {
    state.keys = !state.keys;
    render();
  });
  root.querySelector("[data-action='send']")?.addEventListener("click", () => {
    const ta = document.getElementById("composer");
    if (!ta || !state.openId) return;
    const text = ta.value;
    if (!text) return;
    send({ type: "pty:write", id: state.openId, data: text.endsWith("\n") ? text : text + "\n" });
    ta.value = "";
    term?.focus();
  });
  document.getElementById("pair-url")?.addEventListener("input", (e) => {
    state.pairInput = e.target.value;
  });
  document.getElementById("q")?.addEventListener("input", (e) => {
    state.chatQuery = e.target.value;
    // live filter without full remount of input caret: re-render
    render();
    const q = document.getElementById("q");
    if (q) {
      q.focus();
      q.setSelectionRange(state.chatQuery.length, state.chatQuery.length);
    }
  });
}

window.addEventListener("resize", () => {
  if (!fitAddon || !state.openId || !term) return;
  fitAddon.fit();
  send({ type: "pty:resize", id: state.openId, cols: term.cols, rows: term.rows });
});

// Expose for smoke harness
window.__stellarMobile = {
  go: (view) => {
    state.view = view;
    state.drawer = view === "chat-drawer";
    if (view === "chat" || view === "chat-drawer" || view === "chat-terminal") {
      state.view = "chat";
      state.drawer = view === "chat-drawer";
      state.keys = view === "chat-terminal" || state.keys;
      if (!state.openId && state.cards[0]) state.openId = state.cards[0].id;
    }
    render();
  },
  state: () => state,
};

render();
if (state.token) connect();
else state.view = "pair";
if (!state.token) render();
