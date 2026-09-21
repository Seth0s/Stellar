import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { GlobalComposer } from "@renderer/GlobalComposer";
import { useToasts } from "@renderer/useToast";
import type { VoiceStatus } from "@main/voice-transcription";
import type { CardRow } from "../../src/preload/index";
import { setLocale } from "../../src/shared/i18n";

/**
 * O composer global: anexo que CHEGA (caminho no texto), recusa COM MOTIVO de
 * quem não recebe, texto que não se perde quando a entrega falha, e o ditado
 * local dizendo o que falta.
 *
 * O `ToastProbe` existe porque as recusas são ditas por toast — sem ler o
 * canal de toasts, "recusou com motivo" não seria verificável.
 */
function ToastProbe() {
  const toasts = useToasts();
  return <div data-role="toast-probe">{toasts.map((entry) => entry.msg).join(" | ")}</div>;
}

const CARDS = [
  { id: "card-agent", kind: "terminal", provider: "claude", label: "Claude" },
  { id: "card-shell", kind: "terminal", provider: "bash", label: "Shell" },
] as unknown as CardRow[];

function voiceStatus(over: Partial<VoiceStatus> = {}): VoiceStatus {
  return {
    ready: true,
    missing: null,
    enginePath: "/home/test/.unsloth/whisper.cpp/build/bin/whisper-server",
    engineFound: true,
    modelName: "small",
    modelPath: "/home/test/.config/stellar/whisper/models/ggml-small.bin",
    modelFound: true,
    port: 8199,
    downloadUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    downloadCommand:
      'mkdir -p "/home/test/.config/stellar/whisper/models" && curl -fL --create-dirs -o "/home/test/.config/stellar/whisper/models/ggml-small.bin" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"',
    modelSource: "userData",
    running: false,
    ...over,
  };
}

let send: ReturnType<typeof vi.fn>;
let transcribe: ReturnType<typeof vi.fn>;
let warmup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setLocale("pt-BR");
  send = vi.fn(async () => ({ ok: true, delivery: "delivered", id: "d1" }));
  warmup = vi.fn(async () => ({ ok: true }));
  transcribe = vi.fn(async () => ({ ok: true, text: "olá mundo" }));
  Object.assign(window, {
    store: { list: vi.fn(async () => CARDS) },
    bus: { send, getDelivery: vi.fn(async () => ({ ok: true, delivery: "delivered" })) },
    boardAssets: { getPathForFile: vi.fn(() => "/tmp/relatorio.pdf") },
    clipboardImage: { saveAttachment: vi.fn(async () => ({ ok: true, path: "/tmp/paste-1.pdf" })) },
    voice: { status: vi.fn(async () => voiceStatus()), warmup, transcribe },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function pickTarget(label: string) {
  fireEvent.click(await screen.findByRole("button", { name: /Destino/ }));
  fireEvent.click(await screen.findByRole("button", { name: label }));
}

function attachFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

function textarea(): HTMLTextAreaElement {
  return document.querySelector("textarea") as HTMLTextAreaElement;
}

describe("GlobalComposer — anexo", () => {
  it("documento vira chip e o CAMINHO entra no texto entregue", async () => {
    render(
      <>
        <GlobalComposer boardId="board-1" />
        <ToastProbe />
      </>,
    );
    await pickTarget("Claude");

    attachFile(new File(["conteudo"], "relatorio.pdf", { type: "application/pdf" }));

    const chip = await waitFor(() => {
      const found = document.querySelector('[data-role="composer-attachment-doc"]');
      if (!found) throw new Error("chip de documento não apareceu");
      return found;
    });
    expect(chip.textContent).toContain("relatorio.pdf");
    expect(chip.textContent).toContain("PDF");

    fireEvent.change(textarea(), { target: { value: "olha o arquivo" } });
    fireEvent.click(document.querySelector('[data-role="composer-send"]') as HTMLElement);

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("card-agent", 'olha o arquivo "/tmp/relatorio.pdf"'),
    );
    // Entregue pelo bus: a barra esvazia (texto E anexo).
    await waitFor(() => expect(textarea().value).toBe(""));
    expect(document.querySelector('[data-role="composer-attachment-doc"]')).toBeNull();
  });

  it("paste de imagem (File sintético): o anexo NÃO some — envia o caminho salvo", async () => {
    // Paste do clipboard entrega um `File` só em memória, e `getPathForFile`
    // LANÇA para ele (mesmo motivo do try/catch de App.tsx's `getRealPath`).
    // Antes do guard, esse throw abortava `addFiles` inteiro: nenhum chip,
    // nenhum toast, nenhum envio — o "mando imagem e não envia" relatado.
    (window.boardAssets.getPathForFile as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Not a File");
    });
    render(<><GlobalComposer boardId="board-1" /><ToastProbe /></>);
    await pickTarget("Claude");

    const file = new File([new Uint8Array([1, 2, 3])], "foto.png", { type: "image/png" });
    fireEvent.paste(textarea(), {
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] },
    });

    // Os bytes vão pro diretório efêmero e o caminho salvo é o que viaja.
    await waitFor(() => expect(window.clipboardImage.saveAttachment).toHaveBeenCalled());
    expect(document.querySelector('[data-role="composer-attachments"]')).not.toBeNull();

    fireEvent.click(document.querySelector('[data-role="composer-send"]') as HTMLElement);
    await waitFor(() => expect(send).toHaveBeenCalledWith("card-agent", '"/tmp/paste-1.pdf"'));
  });

  it("bash é recusado COM MOTIVO — o anexo não é engolido", async () => {
    render(
      <>
        <GlobalComposer boardId="board-1" />
        <ToastProbe />
      </>,
    );
    await pickTarget("Shell");

    attachFile(new File(["conteudo"], "relatorio.pdf", { type: "application/pdf" }));

    await waitFor(() =>
      expect(document.querySelector('[data-role="toast-probe"]')?.textContent).toContain("shell"),
    );
    expect(document.querySelector('[data-role="composer-attachment-doc"]')).toBeNull();
  });

  it("formato fora da whitelist é recusado dizendo o nome", async () => {
    render(
      <>
        <GlobalComposer boardId="board-1" />
        <ToastProbe />
      </>,
    );
    await pickTarget("Claude");

    attachFile(new File(["x"], "programa.exe", { type: "" }));

    await waitFor(() =>
      expect(document.querySelector('[data-role="toast-probe"]')?.textContent).toContain(
        "programa.exe",
      ),
    );
    expect(document.querySelector('[data-role="composer-attachment-doc"]')).toBeNull();
  });

  it("entrega FALHA não come o texto digitado (bug relatado)", async () => {
    send.mockResolvedValue({ ok: false, error: "no open terminal card" });
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");

    fireEvent.change(textarea(), { target: { value: "mensagem importante" } });
    fireEvent.click(document.querySelector('[data-role="composer-send"]') as HTMLElement);

    await waitFor(() => expect(send).toHaveBeenCalled());
    // O textarea continua com a mensagem — antes ele era limpo ANTES do await.
    expect(textarea().value).toBe("mensagem importante");
  });
});

/** Limpeza no ACEITE (task 3ef2314b) — a barra esvazia texto E anexos quando o
 * bus ACEITA, antes de qualquer veredito da FIFO. */
describe("GlobalComposer — limpeza no ACEITE, não no veredito", () => {
  it("anexos NÃO ficam presos quando a entrega é ACEITA e só depois o veredito falha", async () => {
    // Task 3ef2314b: a barra limpa texto E anexos no ACEITE do bus (antes do
    // veredito da FIFO). Então um veredito posterior `unconfirmed`/`failed`
    // NÃO deixa os anexos presos — se o dono viu o badge com o veredito na
    // tela, o que estava ali era um rascunho NOVO (a pílula persiste de
    // propósito), não o anexo do envio já aceito.
    send.mockResolvedValue({ ok: true, delivery: "queued", id: "d1" });
    (window.bus.getDelivery as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      delivery: "unconfirmed",
      id: "d1",
      target: "card-agent",
      confirm: { result: "unsent" },
    });
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [1, 2, 3].map((n) => new File([new Uint8Array([n])], `foto${n}.png`, { type: "image/png" }));
    Object.defineProperty(input, "files", { value: files, configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(attachmentCountForTest()).toBe(3));

    fireEvent.click(document.querySelector('[data-role="composer-send"]') as HTMLElement);

    // Aceito pelo bus: a barra esvazia JÁ aqui, antes de qualquer veredito.
    await waitFor(() => expect(attachmentCountForTest()).toBe(0));
    // E o veredito posterior aparece como "Sem confirmação", não "Falhou".
    await waitFor(() =>
      expect(document.querySelector('[data-role="composer-status"]')?.textContent).toContain("Sem confirmação"),
    );
    expect(attachmentCountForTest()).toBe(0);
  });
});

function attachmentCountForTest(): number {
  return document.querySelectorAll('[data-role="composer-attachments"] > *').length;
}

describe("GlobalComposer — o picker só oferece quem RECEBE", () => {
  it("card de chat e de navegador NÃO aparecem como destino (o bus não entrega neles)", async () => {
    // O `bus.send` entrega só `kind === "terminal"`; a barra oferecia três
    // kinds. Oferecer o que se engole é o defeito da 3f701053 — medido: 7
    // cards de chat oferecidos e impossíveis de receber no board do conserto.
    (window.store.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "card-agent", kind: "terminal", provider: "claude", label: "Claude" },
      { id: "card-chat", kind: "chat", provider: "", label: "Conversa" },
      { id: "card-browser", kind: "browser", provider: "", label: "Navegador" },
    ] as unknown as CardRow[]);
    render(<GlobalComposer boardId="board-1" />);

    fireEvent.click(await screen.findByRole("button", { name: /Destino/ }));

    expect(await screen.findByRole("button", { name: /Claude/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Conversa/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Navegador/ })).toBeNull();
  });
});

/**
 * Teto de anexos POR MENSAGEM (4). O defeito era ler `attachments.length`
 * dentro do laço: cada arquivo do lote via o comprimento de ANTES dele, então
 * um lote inteiro passava. Os dois casos que travam o conserto são o LOTE e as
 * DUAS LEVAS — um contador local que reiniciasse a cada chamada passaria no
 * primeiro e quebraria o segundo. Os três gestos (seletor, drop, paste) entram
 * porque chegam por caminhos diferentes ao mesmo `addFiles`.
 */
describe("GlobalComposer — teto de anexos por mensagem", () => {
  const png = (n: number) => new File([new Uint8Array([n])], `foto${n}.png`, { type: "image/png" });

  function attachmentCount(): number {
    return document.querySelectorAll('[data-role="composer-attachments"] > *').length;
  }
  function toastText(): string {
    return document.querySelector('[data-role="toast-probe"]')?.textContent ?? "";
  }
  function occurrences(needle: string): number {
    return toastText().split(needle).length - 1;
  }
  // O store de toast é module-global e NÃO é limpo entre testes (`useToast.ts`),
  // então a asserção é o DELTA da mensagem: uma sobra de um teste anterior não
  // pode fazer este passar sem que o aviso tenha saído de verdade agora.
  async function expectNewToast(needle: string, gesture: () => void) {
    const before = occurrences(needle);
    gesture();
    await waitFor(() => expect(occurrences(needle)).toBe(before + 1));
  }
  function pickFiles(files: File[]) {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    fireEvent.change(input);
  }
  function dropFiles(files: File[]) {
    fireEvent.drop(textarea(), { dataTransfer: { files } });
  }
  function pasteFiles(files: File[]) {
    fireEvent.paste(textarea(), {
      clipboardData: {
        items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
      },
    });
  }

  it("LOTE de 5 no seletor: entram 4, e o 5º é DITO — não some calado", async () => {
    render(<><GlobalComposer boardId="board-1" /><ToastProbe /></>);
    await pickTarget("Claude");

    await expectNewToast("1 anexo(s) de fora", () => pickFiles([1, 2, 3, 4, 5].map(png)));
    expect(attachmentCount()).toBe(4);
  });

  it("DUAS LEVAS (3 + 3): o teto é por MENSAGEM, não por lote", async () => {
    render(<><GlobalComposer boardId="board-1" /><ToastProbe /></>);
    await pickTarget("Claude");

    pickFiles([1, 2, 3].map(png));
    await waitFor(() => expect(attachmentCount()).toBe(3));

    // Só 1 coube na segunda leva (3 + 1 = 4); os outros 2 são contados e ditos.
    await expectNewToast("2 anexo(s) de fora", () => pickFiles([4, 5, 6].map(png)));
    expect(attachmentCount()).toBe(4);
  });

  it("DROP de 5: mesmo caminho, mesmo teto, mesmo aviso", async () => {
    render(<><GlobalComposer boardId="board-1" /><ToastProbe /></>);
    await pickTarget("Claude");

    await expectNewToast("1 anexo(s) de fora", () => dropFiles([1, 2, 3, 4, 5].map(png)));
    expect(attachmentCount()).toBe(4);
  });

  it("PASTE de 5: mesmo caminho, mesmo teto, mesmo aviso", async () => {
    render(<><GlobalComposer boardId="board-1" /><ToastProbe /></>);
    await pickTarget("Claude");

    await expectNewToast("1 anexo(s) de fora", () => pasteFiles([1, 2, 3, 4, 5].map(png)));
    expect(attachmentCount()).toBe(4);
  });

  it("ENTRE MENSAGENS o teto reinicia: 3, envia, mais 3 — cabem as 3, sem aviso", async () => {
    render(<><GlobalComposer boardId="board-1" /><ToastProbe /></>);
    await pickTarget("Claude");
    const excessBefore = occurrences("de fora");

    pickFiles([1, 2, 3].map(png));
    await waitFor(() => expect(attachmentCount()).toBe(3));

    fireEvent.click(document.querySelector('[data-role="composer-send"]') as HTMLElement);
    await waitFor(() => expect(send).toHaveBeenCalled());
    await waitFor(() => expect(attachmentCount()).toBe(0));

    pickFiles([4, 5, 6].map(png));
    await waitFor(() => expect(attachmentCount()).toBe(3));
    // Mensagem nova, teto inteiro: nada foi contado como excedente.
    expect(occurrences("de fora")).toBe(excessBefore);
  });
});

describe("GlobalComposer — histórico (seta ↑/↓)", () => {
  // O histórico persiste em `localStorage` — sem limpar, um teste veria o do
  // anterior. Cada teste começa com a caixa de histórico vazia.
  beforeEach(() => localStorage.clear());

  function sendBtn(): HTMLElement {
    return document.querySelector('[data-role="composer-send"]') as HTMLElement;
  }
  async function sendText(value: string, expectedCalls: number) {
    fireEvent.change(textarea(), { target: { value } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(expectedCalls));
  }
  function caret(pos: number) {
    const el = textarea();
    el.selectionStart = el.selectionEnd = pos;
    return el;
  }

  it("seta ↑ traz o último prompt enviado, e ↑ de novo o anterior", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");

    await sendText("um", 1);
    await sendText("dois", 2);
    await waitFor(() => expect(textarea().value).toBe(""));

    // Consumiu a tecla (preventDefault) porque o caret está na 1ª linha.
    expect(fireEvent.keyDown(caret(0), { key: "ArrowUp" })).toBe(false);
    await waitFor(() => expect(textarea().value).toBe("dois"));

    fireEvent.keyDown(caret(0), { key: "ArrowUp" });
    await waitFor(() => expect(textarea().value).toBe("um"));
  });

  it("o RASCUNHO não se perde: ↑ navega e ↓ devolve o que estava na caixa", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");

    await sendText("antiga", 1);
    await waitFor(() => expect(textarea().value).toBe(""));

    fireEvent.change(textarea(), { target: { value: "rascunho a meio" } });
    fireEvent.keyDown(caret(0), { key: "ArrowUp" });
    await waitFor(() => expect(textarea().value).toBe("antiga"));

    fireEvent.keyDown(caret(textarea().value.length), { key: "ArrowDown" });
    await waitFor(() => expect(textarea().value).toBe("rascunho a meio"));
  });

  it("multi-linha: fora da 1ª linha a seta ↑ NÃO recupera (o cursor continua do textarea)", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");

    await sendText("antiga", 1);
    await waitFor(() => expect(textarea().value).toBe(""));

    fireEvent.change(textarea(), { target: { value: "linha1\nlinha2" } });
    // Caret no início da 2ª linha: a seta tem trabalho de cursor a fazer.
    const notConsumed = fireEvent.keyDown(caret(7), { key: "ArrowUp" });
    expect(notConsumed).toBe(true); // NÃO fez preventDefault
    expect(textarea().value).toBe("linha1\nlinha2"); // e não virou histórico
  });

  it("não quebra o envio: Enter envia, Shift+Enter NÃO", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");

    fireEvent.change(textarea(), { target: { value: "manda isso" } });
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled(); // Shift+Enter é quebra de linha, não envio

    fireEvent.keyDown(textarea(), { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledWith("card-agent", "manda isso"));
  });

  it("PERSISTE: o que foi enviado fica gravado no localStorage", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");

    await sendText("guardar isso", 1);

    const raw = localStorage.getItem("stellar.global-composer.history");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toContain("guardar isso");
  });
});

describe("GlobalComposer — falha de entrega é PERSISTENTE (e o sucesso não)", () => {
  function pill(): HTMLElement | null {
    return document.querySelector('[data-role="composer-status"]');
  }
  function pillText(): string {
    return pill()?.textContent ?? "";
  }
  function sendBtn(): HTMLElement {
    return document.querySelector('[data-role="composer-send"]') as HTMLElement;
  }
  function getDelivery(): ReturnType<typeof vi.fn> {
    return window.bus.getDelivery as unknown as ReturnType<typeof vi.fn>;
  }
  // Flush de microtasks sob relógio falso: o `handleSend` espera `bus.send` e o
  // primeiro `tick` do poll espera `getDelivery` — nenhum dos dois usa timer.
  async function flush() {
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
  }

  it("bus RECUSA: a pílula diz o card, o motivo REAL e o que tentar", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");
    send.mockResolvedValue({ ok: false, error: 'no open terminal card with id "card-agent"' });

    fireEvent.change(textarea(), { target: { value: "mensagem que não vai" } });
    fireEvent.click(sendBtn());

    await waitFor(() => expect(pillText()).toContain("Falhou"));
    expect(pillText()).toContain("Claude"); // qual card
    expect(pillText()).toContain('no open terminal card with id "card-agent"'); // motivo real do bus
    expect(pillText()).toContain("tentar de novo"); // o que fazer
    // A mensagem continua na caixa — é ela que se reenvia.
    expect(textarea().value).toBe("mensagem que não vai");
  });

  it("bus RECUSA: o relógio passa e a pílula NÃO some (só o clique ou a próxima tentativa)", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");
    send.mockResolvedValue({ ok: false, error: "boom" });

    vi.useFakeTimers();
    try {
      fireEvent.change(textarea(), { target: { value: "oi" } });
      fireEvent.click(sendBtn());
      await flush();
      expect(pill()).not.toBeNull();

      // Muito além do antigo TTL de `failed` (4000ms), e além de qualquer outro.
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(pill()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("CONTROLE da assimetria: `parked` (espera) SOME sozinho", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");
    send.mockResolvedValue({ ok: true, delivery: "queued", id: "d1" });
    getDelivery().mockResolvedValue({ ok: true, delivery: "parked", id: "d1", target: "card-agent" });

    vi.useFakeTimers();
    try {
      fireEvent.change(textarea(), { target: { value: "oi" } });
      fireEvent.click(sendBtn());
      await flush();
      expect(pillText()).toContain("Na fila do agente");

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(pill()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("`unconfirmed` também persiste e diz o card + o veredito do laço", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");
    send.mockResolvedValue({ ok: true, delivery: "queued", id: "d1" });
    getDelivery().mockResolvedValue({
      ok: true,
      delivery: "unconfirmed",
      id: "d1",
      target: "card-agent",
      confirm: { result: "read-failed" },
    });

    fireEvent.change(textarea(), { target: { value: "oi" } });
    fireEvent.click(sendBtn());

    await waitFor(() => expect(pillText()).toContain("Sem confirmação"));
    expect(pillText()).toContain("Claude");
    expect(pillText()).toContain("read-failed");
    expect(pillText()).toContain("tentar de novo");
  });

  it("clicar é RECONHECER: o clique tira a falha persistente", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");
    send.mockResolvedValue({ ok: false, error: "boom" });

    fireEvent.change(textarea(), { target: { value: "oi" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(pill()).not.toBeNull());

    fireEvent.click(pill() as HTMLElement);
    await waitFor(() => expect(pill()).toBeNull());
  });

  it("falha NOVA SUBSTITUI a anterior (não acumula duas pílulas)", async () => {
    render(<GlobalComposer boardId="board-1" />);
    await pickTarget("Claude");
    send
      .mockResolvedValueOnce({ ok: false, error: "primeiro motivo" })
      .mockResolvedValueOnce({ ok: false, error: "segundo motivo" });

    fireEvent.change(textarea(), { target: { value: "oi" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(pillText()).toContain("primeiro motivo"));

    fireEvent.click(sendBtn());
    await waitFor(() => expect(pillText()).toContain("segundo motivo"));

    expect(document.querySelectorAll('[data-role="composer-status"]').length).toBe(1);
    expect(pillText()).not.toContain("primeiro motivo");
  });
});

describe("GlobalComposer — ditado", () => {
  it("modelo ausente: o botão DIZ o que falta, com o comando exato", async () => {
    (window.voice.status as ReturnType<typeof vi.fn>).mockResolvedValue(
      voiceStatus({ ready: false, missing: "model", modelFound: false }),
    );
    render(<GlobalComposer boardId="board-1" />);

    fireEvent.click(document.querySelector('[data-role="composer-voice"]') as HTMLElement);

    const hint = await waitFor(() => {
      const found = document.querySelector('[data-role="composer-voice-hint"]');
      if (!found) throw new Error("hint de voz não apareceu");
      return found;
    });
    expect(hint.textContent).toContain("ggml-small.bin");
    expect(hint.textContent).toContain("curl -fL");
    // Nada de gravação quando falta o modelo.
    expect(warmup).not.toHaveBeenCalled();
  });

  it("motor pronto: aquece ao gravar, transcreve e insere o texto", async () => {
    class FakeMediaRecorder {
      mimeType = "audio/webm";
      state = "inactive";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }),
        });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });

    render(<GlobalComposer boardId="board-1" />);
    const mic = document.querySelector('[data-role="composer-voice"]') as HTMLElement;

    fireEvent.click(mic);
    await waitFor(() => expect(warmup).toHaveBeenCalled());
    expect(mic.getAttribute("data-voice-state")).toBe("recording");

    fireEvent.click(mic);
    await waitFor(() => expect(transcribe).toHaveBeenCalled());
    await waitFor(() => expect(textarea().value).toContain("olá mundo"));
    expect(mic.getAttribute("data-voice-state")).toBe("idle");
  });
});
