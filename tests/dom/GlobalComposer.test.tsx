import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
