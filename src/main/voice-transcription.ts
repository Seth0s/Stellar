/**
 * MOTOR DE VOZ — whisper.cpp LOCAL. Decisão do dono do repo (2026-09-20,
 * aprovada a partir da medição do relatório seq 453): nada de API remota, o
 * áudio NÃO sai da máquina.
 *
 * O que já existe nesta máquina, MEDIDO (não presumido):
 *   - engine: `~/.unsloth/whisper.cpp/build/bin/whisper-server` (prebuilt
 *     unsloth v1.9.2-unsloth.10, backend CUDA, enxerga a RTX 5060 Ti). Não
 *     está no PATH — por isso o caminho default aqui.
 *   - ffmpeg 8.1.2 em `/usr/bin/ffmpeg` (o `--convert` do server precisa
 *     dele para aceitar webm/opus do MediaRecorder).
 *   - porta 8080 NÃO serve: é o llama-swap do dono (Qwen3.6-27B). Ver
 *     `WHISPER_DEFAULT_PORT` para a escolha e o porquê.
 * O que NÃO existe: o MODELO. Não há nenhum `ggml-*.bin` de whisper no disco
 * — daí "modelo ausente" ser estado de PRIMEIRA CLASSE aqui (`missing`), com
 * o comando de download exposto para a UI dizer o que falta, em vez de um
 * botão que não responde (era exatamente o defeito relatado).
 *
 * Ciclo de vida: o server sobe quando o usuário vai gravar (`warmup`, que
 * esconde o load do modelo atrás da fala) e MORRE depois da transcrição —
 * nada de processo de GPU vivo à toa. Há um teto de segurança para o caso de
 * o usuário cancelar a gravação e nunca transcrever.
 *
 * Divisão de camadas (a mesma de `providers-dynamic.ts`): a DECISÃO é pura em
 * cima (`resolveVoiceConfig`), o I/O é a casca embaixo. Nada aqui importa
 * `electron` — quem chama passa `homeDir`/`userDataDir`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { t } from "../shared/i18n";

export const WHISPER_ENGINE_ENV = "STELLAR_WHISPER_SERVER";
export const WHISPER_MODEL_ENV = "STELLAR_WHISPER_MODEL";
export const WHISPER_MODEL_NAME_ENV = "STELLAR_WHISPER_MODEL_NAME";
export const WHISPER_PORT_ENV = "STELLAR_WHISPER_PORT";

/**
 * 8199, e não 8080: a 8080 está OCUPADA pelo llama-swap do dono (medido com
 * `ss -ltnp`: pid 1201 servindo só o Qwen3.6-27B). 8199 é livre nesta máquina
 * (medido), fora da faixa que os smoke tests usam para CDP, e configurável
 * por `STELLAR_WHISPER_PORT` — a porta não é cativa, é um default dito.
 */
export const WHISPER_DEFAULT_PORT = 8199;

/** `small` (multilíngue, ~466 MB) e não `base`: ver o argumento no relatório
 * — `base` é o menor multilíngue que existe, mas a qualidade em português
 * (acentuação/concordância) não se sustenta para ditado real; `medium` custa
 * ~3x o tempo de GPU e ~3x o download sem ganho proporcional em frases
 * curtas. O nome fica configurável (`STELLAR_WHISPER_MODEL_NAME`). */
export const WHISPER_DEFAULT_MODEL_NAME = "small";

/** Fonte canônica dos modelos do whisper.cpp (o próprio README do projeto
 * aponta este repositório). O download é do dono do repo fazer. */
export const WHISPER_MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/** Teto de segurança: aquecido mas sem transcrição nenhuma depois disto. */
const IDLE_KILL_MS = 5 * 60_000;
/** Quanto esperar o server abrir a porta (CUDA + load do modelo). */
const READY_TIMEOUT_MS = 60_000;
/** Limite de payload aceito (base64). Opus ~24 kbps: 30 MB são ~2h40. */
const MAX_AUDIO_BASE64 = 30 * 1024 * 1024;

export type VoiceMissing = "engine" | "model";

export type VoiceConfig = {
  enginePath: string;
  engineFound: boolean;
  modelName: string;
  modelPath: string;
  modelFound: boolean;
  modelDir: string;
  tmpDir: string;
  port: number;
  downloadUrl: string;
  downloadCommand: string;
  /** Origem do caminho do modelo — `env` é override explícito do usuário. */
  modelSource: "env" | "userData";
};

export type VoiceConfigInput = {
  env: Record<string, string | undefined>;
  homeDir: string;
  userDataDir: string;
  /** Injetável para teste (o de verdade é `existsSync`). */
  exists?: (path: string) => boolean;
};

/** Nome de modelo é usado para montar um PATH — então só passa o que é
 * inequivocamente um nome (`ggml-small`, `large-v3-turbo`, `.en` etc.). Sem
 * isto um env malicioso/errado (`../../etc/...`) escaparia do diretório. */
function validModelName(name: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*$/.test(name);
}

function validPort(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return null;
  return parsed;
}

/**
 * Resolve o que o motor precisa, sem tocar em nada: caminhos, porta,
 * URL/comando de download e o que está FALTANDO. Pura (só o `exists`
 * injetado lê disco), então testável em node.
 */
export function resolveVoiceConfig(input: VoiceConfigInput): VoiceConfig {
  const exists = input.exists ?? existsSync;
  const env = input.env;

  const enginePath = env[WHISPER_ENGINE_ENV]?.trim()
    ? env[WHISPER_ENGINE_ENV]!.trim()
    : join(input.homeDir, ".unsloth", "whisper.cpp", "build", "bin", "whisper-server");

  const modelDir = join(input.userDataDir, "whisper", "models");
  const envModel = env[WHISPER_MODEL_ENV]?.trim() ?? "";
  const envName = env[WHISPER_MODEL_NAME_ENV]?.trim() ?? "";
  const modelName = validModelName(envName) ? envName : WHISPER_DEFAULT_MODEL_NAME;
  const modelPath = envModel !== "" ? envModel : join(modelDir, `ggml-${modelName}.bin`);

  const downloadUrl = `${WHISPER_MODEL_BASE_URL}/${basename(modelPath)}`;
  // `mkdir -p` + `curl -fL`: o `-f` falha em HTTP de erro em vez de gravar um
  // HTML de 404 com nome de modelo, e `--create-dirs` cobre o -o aninhado.
  const downloadCommand = `mkdir -p "${modelDir}" && curl -fL --create-dirs -o "${modelPath}" "${downloadUrl}"`;

  return {
    enginePath,
    engineFound: exists(enginePath),
    modelName,
    modelPath,
    modelFound: exists(modelPath),
    modelDir,
    tmpDir: join(input.userDataDir, "whisper", "tmp"),
    port: validPort(env[WHISPER_PORT_ENV]) ?? WHISPER_DEFAULT_PORT,
    downloadUrl,
    downloadCommand,
    modelSource: envModel !== "" ? "env" : "userData",
  };
}

export type VoiceStatus = {
  /** Pronto para ditar AGORA (engine + modelo no disco). */
  ready: boolean;
  /** O que falta, quando não está pronto — a UI diz isso ao usuário. */
  missing: VoiceMissing | null;
  enginePath: string;
  engineFound: boolean;
  modelName: string;
  modelPath: string;
  modelFound: boolean;
  port: number;
  downloadUrl: string;
  downloadCommand: string;
  modelSource: "env" | "userData";
  /** Server no ar neste instante (para diagnóstico/telemetria honesta). */
  running: boolean;
};

export type TranscribeResult = { ok: true; text: string } | { ok: false; error: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * O server do whisper.cpp, sob demanda.
 *
 * `transcribe` faz o ciclo inteiro (garante que está no ar → POST
 * `/inference` → derruba), então não existe estado "ligado" que sobreviva a
 * uma transcrição. `warmup` é o único caso em que ele fica vivo sem trabalho:
 * subir no começo da gravação esconde o load do modelo (CUDA) atrás da fala.
 */
export class WhisperTranscriber {
  private child: ChildProcess | null = null;
  private starting: Promise<TranscribeResult | null> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLog: string[] = [];

  constructor(
    private readonly config: () => VoiceConfig,
    private readonly opts: { spawnFn?: typeof spawn } = {},
  ) {}

  status(): VoiceStatus {
    const cfg = this.config();
    const missing: VoiceMissing | null = !cfg.engineFound
      ? "engine"
      : !cfg.modelFound
        ? "model"
        : null;
    return {
      ready: missing === null,
      missing,
      enginePath: cfg.enginePath,
      engineFound: cfg.engineFound,
      modelName: cfg.modelName,
      modelPath: cfg.modelPath,
      modelFound: cfg.modelFound,
      port: cfg.port,
      downloadUrl: cfg.downloadUrl,
      downloadCommand: cfg.downloadCommand,
      modelSource: cfg.modelSource,
      running: this.child !== null,
    };
  }

  /** Sobe o server sem transcrever nada (aquecimento do começo da gravação).
   * Idempotente e barato quando já está no ar. */
  async warmup(): Promise<{ ok: true } | { ok: false; error: string }> {
    const started = await this.ensureServer();
    if (started !== null && !started.ok) return { ok: false, error: started.error };
    return { ok: true };
  }

  async transcribe(base64: string, mimeType: string): Promise<TranscribeResult> {
    const cfg = this.config();
    if (!cfg.engineFound)
      return { ok: false, error: t("voice.error.engineMissing", { path: cfg.enginePath }) };
    if (!cfg.modelFound)
      return { ok: false, error: t("voice.error.modelMissing", { path: cfg.modelPath }) };
    if (base64.length > MAX_AUDIO_BASE64) {
      return {
        ok: false,
        error: t("voice.error.tooLarge", { size: `${Math.round(base64.length / 1024 / 1024)} MB` }),
      };
    }
    if (base64.length === 0) return { ok: false, error: t("voice.error.emptyAudio") };

    const started = await this.ensureServer();
    if (started !== null && !started.ok) return { ok: false, error: started.error };

    try {
      const form = new FormData();
      const bytes = Buffer.from(base64, "base64");
      // O nome do campo é o contrato do `/inference` do whisper.cpp; o
      // `--convert` no argv é quem deixa o server aceitar webm/opus
      // (ffmpeg presente nesta máquina).
      form.append(
        "file",
        new Blob([bytes], { type: mimeType || "audio/webm" }),
        `dictation.${extFromMime(mimeType)}`,
      );
      form.append("response_format", "json");

      const res = await fetch(`http://127.0.0.1:${cfg.port}/inference`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          ok: false,
          error: t("voice.error.requestFailed", { status: String(res.status), body: clip(body) }),
        };
      }
      const payload = (await res.json().catch(() => null)) as { text?: unknown } | null;
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (text === "") return { ok: false, error: t("voice.error.emptyTranscript") };
      return { ok: true, text };
    } catch (err) {
      return {
        ok: false,
        error: t("voice.error.requestFailed", { status: "?", body: clip(String(err)) }),
      };
    } finally {
      // "morre depois": a transcrição termina, o processo (e a VRAM) sai.
      this.stop();
    }
  }

  /** Derruba o server agora. Idempotente; seguro de chamar no quit do app. */
  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (!child || child.exitCode !== null || child.killed) return;
    try {
      child.kill("SIGTERM");
      // CUDA segurando VRAM pode ignorar SIGTERM por um instante — o
      // SIGKILL é a rede de segurança, não o caminho normal.
      const hard = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
      hard.unref?.();
    } catch {
      /* já morreu */
    }
  }

  /** Garante o processo no ar. Devolve `null` quando já estava pronto. */
  private async ensureServer(): Promise<TranscribeResult | null> {
    const cfg = this.config();
    if (this.child !== null) return null;
    if (this.starting !== null) return this.starting;

    this.starting = this.spawnServer(cfg);
    const result = await this.starting;
    this.starting = null;
    if (result !== null && !result.ok) this.stop();
    else this.armIdleKill();
    return result;
  }

  private armIdleKill(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_KILL_MS);
    this.idleTimer.unref?.();
  }

  private async spawnServer(cfg: VoiceConfig): Promise<TranscribeResult | null> {
    try {
      mkdirSync(cfg.tmpDir, { recursive: true });
    } catch {
      /* o server cria o próprio tmp se precisar; não é motivo para falhar aqui */
    }
    this.lastLog = [];
    let child: ChildProcess;
    try {
      child = (this.opts.spawnFn ?? spawn)(cfg.enginePath, [
        "-m",
        cfg.modelPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(cfg.port),
        // `-l auto`: o default do server é `en`, e ditado aqui é pt-BR.
        "-l",
        "auto",
        // aceita webm/opus do MediaRecorder (precisa de ffmpeg, medido: presente)
        "--convert",
        "--tmp-dir",
        cfg.tmpDir,
      ]);
    } catch (err) {
      return { ok: false, error: t("voice.error.startFailed", { error: String(err) }) };
    }
    this.child = child;

    const capture = (chunk: unknown) => {
      const line = String(chunk).trim();
      if (line) this.lastLog.push(line);
      if (this.lastLog.length > 40) this.lastLog.shift();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    let exited: string | null = null;
    child.once("exit", () => {
      if (this.child === child) this.child = null;
      exited = this.lastLog.slice(-3).join(" · ") || "process exited";
    });
    child.once("error", (err) => {
      exited = String(err);
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited !== null)
        return { ok: false, error: t("voice.error.startFailed", { error: clip(exited) }) };
      if (await portOpen(cfg.port)) return null;
      await sleep(150);
    }
    return {
      ok: false,
      error: t("voice.error.startTimeout", { seconds: String(READY_TIMEOUT_MS / 1000) }),
    };
  }
}

async function portOpen(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

function extFromMime(mimeType: string): string {
  const mime = (mimeType || "").toLowerCase();
  if (mime.includes("wav")) return "wav";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "webm";
}

/** Erro de dependência externa pode vir gigante (um JSON de stack inteiro) —
 * o toast tem uma linha, então o motivo é cortado, não despejado. */
function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

/** Default de diretórios para quem chama do main (electron só entra aqui, não
 * na decisão acima). */
export function defaultVoiceConfigInput(
  userDataDir: string,
  env: Record<string, string | undefined>,
): VoiceConfigInput {
  return { env, homeDir: homedir(), userDataDir };
}
