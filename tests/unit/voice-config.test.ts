import { describe, it, expect } from "vitest";
import {
  WHISPER_DEFAULT_MODEL_NAME,
  WHISPER_DEFAULT_PORT,
  resolveVoiceConfig,
} from "../../src/main/voice-transcription";

/**
 * O motor de voz é LOCAL (whisper.cpp, decisão do dono) e esta é a parte
 * pura: a resolução de CAMINHO, PORTE e COMANDO de download. O que está
 * fixado aqui é o que o usuário precisa saber para fazer o motor funcionar —
 * "modelo ausente" é estado de primeira classe, então o caminho e o comando
 * têm que estar certos e ser os mesmos que a UI mostra.
 */
const HOME = "/home/test";
const USER_DATA = "/home/test/.config/stellar";

function config(env: Record<string, string | undefined> = {}, existing: string[] = []) {
  return resolveVoiceConfig({
    env,
    homeDir: HOME,
    userDataDir: USER_DATA,
    exists: (path) => existing.includes(path),
  });
}

describe("resolveVoiceConfig", () => {
  it("aponta para o whisper-server que já está nesta máquina, e para um modelo no userData", () => {
    const cfg = config();

    expect(cfg.enginePath).toBe("/home/test/.unsloth/whisper.cpp/build/bin/whisper-server");
    expect(cfg.engineFound).toBe(false);
    expect(cfg.modelName).toBe(WHISPER_DEFAULT_MODEL_NAME);
    expect(cfg.modelPath).toBe("/home/test/.config/stellar/whisper/models/ggml-small.bin");
    expect(cfg.modelFound).toBe(false);
    expect(cfg.modelSource).toBe("userData");
  });

  it("a porta default NÃO é a 8080 (ocupada pelo llama-swap do dono)", () => {
    expect(WHISPER_DEFAULT_PORT).toBe(8199);
    expect(config().port).not.toBe(8080);
  });

  it("lê o disco só pelo `exists` injetado: engine e modelo podem estar presentes", () => {
    const engine = "/home/test/.unsloth/whisper.cpp/build/bin/whisper-server";
    const model = "/home/test/.config/stellar/whisper/models/ggml-small.bin";
    const cfg = config({}, [engine, model]);

    expect(cfg.engineFound).toBe(true);
    expect(cfg.modelFound).toBe(true);
  });

  it("entrega o comando EXATO de download (e a URL canônica do whisper.cpp)", () => {
    const cfg = config();

    expect(cfg.downloadUrl).toBe(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    );
    expect(cfg.downloadCommand).toBe(
      'mkdir -p "/home/test/.config/stellar/whisper/models" && curl -fL --create-dirs -o "/home/test/.config/stellar/whisper/models/ggml-small.bin" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"',
    );
  });

  it("env sobrescreve engine, modelo, nome do modelo e porta", () => {
    const cfg = resolveVoiceConfig({
      env: {
        STELLAR_WHISPER_SERVER: "/opt/whisper/whisper-server",
        STELLAR_WHISPER_MODEL: "/mnt/models/ggml-medium.bin",
        STELLAR_WHISPER_PORT: "9000",
      },
      homeDir: HOME,
      userDataDir: USER_DATA,
      exists: () => false,
    });

    expect(cfg.enginePath).toBe("/opt/whisper/whisper-server");
    expect(cfg.modelPath).toBe("/mnt/models/ggml-medium.bin");
    expect(cfg.modelSource).toBe("env");
    expect(cfg.port).toBe(9000);
    // O comando acompanha o caminho resolvido, não o default.
    expect(cfg.downloadUrl).toContain("/ggml-medium.bin");
    expect(cfg.downloadCommand).toContain("/mnt/models/ggml-medium.bin");
  });

  it("troca o TAMANHO do modelo por env, mantendo o diretório do userData", () => {
    const cfg = config({ STELLAR_WHISPER_MODEL_NAME: "medium" });

    expect(cfg.modelPath).toBe("/home/test/.config/stellar/whisper/models/ggml-medium.bin");
  });

  it("nome de modelo inválido cai no default — nome vira PATH, então não pode escapar", () => {
    for (const bad of ["../../etc/passwd", "Grande", "ggml small", ""]) {
      const cfg = config({ STELLAR_WHISPER_MODEL_NAME: bad });
      expect(cfg.modelPath).toBe("/home/test/.config/stellar/whisper/models/ggml-small.bin");
    }
  });

  it("porta inválida (privilegiada, fora de faixa, não-numérica) cai no default", () => {
    for (const bad of ["80", "0", "70000", "abc", "-1"]) {
      expect(config({ STELLAR_WHISPER_PORT: bad }).port).toBe(WHISPER_DEFAULT_PORT);
    }
  });

  it("tmpDir fica no userData — o `--convert` do server precisa de um diretório nosso", () => {
    expect(config().tmpDir).toBe("/home/test/.config/stellar/whisper/tmp");
  });
});
