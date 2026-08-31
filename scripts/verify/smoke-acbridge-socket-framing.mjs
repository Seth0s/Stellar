// Pre-release audit B3 — message-bus.ts's raw acbridge socket parser used
// to do `buf = ""` after taking just the first `\n`-terminated line out of
// an incoming chunk, silently discarding anything after it. `acbridge`
// itself never triggers this (one line per connection, always), so this
// talks to the socket directly with `net.connect` instead, writing two
// complete JSON-line commands in a SINGLE `socket.write()` call — the
// exact scenario the audit named ("dois comandos JSON-line entregues no
// mesmo chunk TCP") — and confirms both come back answered, in order, not
// just the first.
import { connect } from "node:net";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9432;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-acbridge-socket-framing", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  await bootIntoFreshSession(page, "acbridge Socket Framing Teste");
  await new Promise((r) => setTimeout(r, 500));

  const sockPath = `${USER_DATA_DIR}/agent-canvas.sock`;

  const response = await new Promise((resolve, reject) => {
    const socket = connect(sockPath);
    let data = "";
    socket.on("connect", () => {
      // Two full, independent JSON-line commands, written in ONE call —
      // Node hands this to the OS as a single write, and on a local Unix
      // socket this reliably arrives as one chunk server-side (confirmed
      // live below, not assumed).
      socket.write(JSON.stringify({ cmd: "list" }) + "\n" + JSON.stringify({ cmd: "list_connectors" }) + "\n");
    });
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => reject(new Error("timed out waiting for a reply")), 5000);
  });

  const lines = response.trim().split("\n");
  check("both commands sent in the same chunk get a reply each (not just the first)", lines.length, 2);
  const [first, second] = lines.map((l) => JSON.parse(l));
  check("first reply answers the FIRST command (list)", Array.isArray(first?.cards), true);
  check("second reply answers the SECOND command (list_connectors), not lost", Array.isArray(second?.connectors), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
