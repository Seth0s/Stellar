import { describe, it, expect, beforeEach } from "vitest";
import {
  admitAttachment,
  attachmentIcon,
  buildDeliveryText,
  classifyAttachment,
  extensionOf,
  formatAttachmentSize,
} from "../../src/renderer/src/attachments";
import { setLocale } from "../../src/shared/i18n";

beforeEach(() => setLocale("pt-BR"));

describe("classifyAttachment", () => {
  it("imagem vem do mediaType; documento vem da extensão", () => {
    expect(classifyAttachment({ name: "print.png", type: "image/png" })).toBe("image");
    expect(classifyAttachment({ name: "relatorio.pdf", type: "application/pdf" })).toBe("document");
    expect(classifyAttachment({ name: "notas.md", type: "" })).toBe("document");
    expect(classifyAttachment({ name: "dados.CSV", type: "" })).toBe("document");
  });

  it("o que não é nem imagem nem documento é recusado (e não engolido)", () => {
    expect(classifyAttachment({ name: "programa.exe", type: "" })).toBeNull();
    expect(classifyAttachment({ name: "sem-extensao", type: "" })).toBeNull();
    expect(classifyAttachment({ name: "video.mkv", type: "video/x-matroska" })).toBeNull();
  });

  it("mediaType de imagem que não está na whitelist não passa por imagem", () => {
    expect(classifyAttachment({ name: "foto.tiff", type: "image/tiff" })).toBeNull();
  });
});

describe("extensionOf", () => {
  it("minúscula, sem ponto; arquivo oculto/sem extensão é vazio", () => {
    expect(extensionOf("A.PDF")).toBe("pdf");
    expect(extensionOf("nota.final.md")).toBe("md");
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("README")).toBe("");
  });
});

describe("attachmentIcon", () => {
  it("usa só ícones que já existem, escolhidos pela extensão", () => {
    expect(attachmentIcon("notas.md")).toBe("fileMarkdown");
    expect(attachmentIcon("app.ts")).toBe("fileCode");
    expect(attachmentIcon("config.yaml")).toBe("fileConfig");
    expect(attachmentIcon("relatorio.pdf")).toBe("fileGeneric");
  });
});

describe("formatAttachmentSize", () => {
  it("tamanho humano no idioma ativo (separador decimal é o que muda)", () => {
    expect(formatAttachmentSize(0)).toBe("0 B");
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(1536)).toBe("1,5 KB");
    expect(formatAttachmentSize(4_500_000)).toBe("4,3 MB");
    setLocale("en");
    expect(formatAttachmentSize(1536)).toBe("1.5 KB");
  });
});

describe("admitAttachment — a matriz de admissão", () => {
  it("terminal de AGENTE aceita (o caminho vai no texto)", () => {
    expect(
      admitAttachment({ kind: "image", targetKind: "terminal", targetProvider: "claude" }),
    ).toEqual({ ok: true });
    expect(
      admitAttachment({ kind: "document", targetKind: "terminal", targetProvider: "cline" }),
    ).toEqual({ ok: true });
  });

  it("bash RECUSA: um caminho no texto seria executado como comando", () => {
    expect(
      admitAttachment({ kind: "document", targetKind: "terminal", targetProvider: "bash" }),
    ).toEqual({
      ok: false,
      reason: "composer.attach.shell",
    });
  });

  it("chat recusa os dois, com motivos diferentes (imagem vai pelo card)", () => {
    expect(admitAttachment({ kind: "image", targetKind: "chat", targetProvider: null })).toEqual({
      ok: false,
      reason: "composer.attach.chatImage",
    });
    expect(admitAttachment({ kind: "document", targetKind: "chat", targetProvider: null })).toEqual(
      {
        ok: false,
        reason: "composer.attach.chatDocument",
      },
    );
  });

  it("navegador e destino ausente recusam com o próprio motivo", () => {
    expect(admitAttachment({ kind: "image", targetKind: "browser", targetProvider: null })).toEqual(
      {
        ok: false,
        reason: "composer.attach.browser",
      },
    );
    expect(admitAttachment({ kind: "image", targetKind: null, targetProvider: null })).toEqual({
      ok: false,
      reason: "composer.attach.noTarget",
    });
    expect(admitAttachment({ kind: "image", targetKind: "sticky", targetProvider: null })).toEqual({
      ok: false,
      reason: "composer.attach.notTerminal",
    });
  });
});

describe("buildDeliveryText", () => {
  it("só texto", () => {
    expect(buildDeliveryText("  olha isso  ", [])).toBe("olha isso");
  });

  it("só anexo — mandar um arquivo sem texto é legítimo", () => {
    expect(buildDeliveryText("", ["/tmp/a.pdf"])).toBe('"/tmp/a.pdf"');
  });

  it("texto + anexos: cada caminho entre aspas (espaço no path não quebra)", () => {
    expect(buildDeliveryText("lê isso", ["/tmp/meu arquivo.pdf", "/tmp/b.md"])).toBe(
      'lê isso "/tmp/meu arquivo.pdf" "/tmp/b.md"',
    );
  });
});
