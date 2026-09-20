import { useCallback, useEffect, useRef, useState } from "react";
import type { CardRow } from "../../preload/index";
import type { BusDelivery } from "../../preload/index";
import type { VoiceStatus } from "../../main/voice-transcription";
import { Icon, type IconName } from "./icons";
import { Popover } from "./Popover";
import { PROVIDER_GLYPH } from "./provider-glyph";
import { toast } from "./useToast";
import { t, type MessageKey } from "../../shared/i18n";
import {
  ATTACHMENT_ACCEPT,
  admitAttachment,
  attachmentIcon,
  buildDeliveryText,
  classifyAttachment,
  extensionOf,
  formatAttachmentSize,
  type AttachmentKind,
} from "./attachments";
import styles from "./GlobalComposer.module.css";

const ELIGIBLE_KINDS = ["terminal", "browser", "chat"];
const KIND_ICON: Record<string, IconName> = { terminal: "terminal", browser: "browser", chat: "chat" };

/** Teto de anexos por mensagem. Imagem continua com o mesmo número de antes
 * (4); documento entra no MESMO teto — a barra entrega caminhos, e uma lista
 * longa de caminhos no texto vira ruído no prompt. */
const MAX_ATTACHMENTS_PER_MESSAGE = 4;

/**
 * Um anexo do composer. `path` é o que de fato viaja: o caminho REAL do
 * arquivo no disco (ver `attachments.ts` e `main/clipboard-image.ts`).
 * `previewUrl` só existe para imagem (miniatura instantânea, sem round-trip).
 */
type Attachment = {
  id: string;
  kind: AttachmentKind;
  name: string;
  ext: string;
  size: number;
  path: string;
  previewUrl?: string;
};

// `queued` never reaches the UI as a final state — pollDelivery keeps
// ticking until the FIFO resolves it one way or another (or gives up).
type SendState = "idle" | "sending" | Exclude<BusDelivery, "queued" | "cancelled">;

const STATUS_LABEL_KEYS: Record<Exclude<SendState, "idle">, MessageKey> = {
  sending: "composer.status.sending",
  delivered: "composer.status.delivered",
  parked: "composer.status.parked",
  unconfirmed: "composer.status.unconfirmed",
  failed: "composer.status.failed",
};

const STATUS_ICON: Record<Exclude<SendState, "idle">, IconName> = {
  sending: "spinner",
  delivered: "check",
  parked: "clock",
  unconfirmed: "warning",
  failed: "warning",
};

function cardIcon(card: CardRow): IconName {
  if (card.kind === "terminal" && card.provider && card.provider in PROVIDER_GLYPH) return "terminal";
  return KIND_ICON[card.kind] ?? "terminal";
}

function cardColor(card: CardRow): string | undefined {
  if (card.kind !== "terminal" || !card.provider) return undefined;
  return PROVIDER_GLYPH[card.provider]?.mid;
}

/** Base64 sem `FileReader`: o áudio de um ditado pode passar de alguns MB e o
 * `String.fromCharCode(...bytes)` de uma vez estoura a pilha — daí o pedaço. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function clipError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/**
 * Barra de input global do board: escolhe um card-alvo e manda texto (ou
 * dita por voz) sem precisar clicar dentro do terminal dele. Fica fora da
 * viewport por padrão — só a alça no rodapé fica visível — e é puxada pra
 * dentro no hover (ou quando tem foco/texto/gravação/entrega pendente, pra
 * nunca sumir no meio de uma digitação só porque o mouse saiu).
 *
 * ANEXO (2026-09-20, "infraestrutura de anexo pra ser funcional de verdade"):
 * o anexo vira ARQUIVO REAL EM DISCO e o caminho entra no TEXTO entregue ao
 * PTY — a única coisa que o app pode garantir. A matriz de admissão
 * (`attachments.ts`) recusa com motivo quem não recebe (shell `bash`, chat
 * com documento, navegador), em vez de aceitar e não entregar.
 *
 * VOZ: whisper.cpp LOCAL (`main/voice-transcription.ts`, decidido pelo dono).
 * O server sobe quando a gravação COMEÇA (o load do modelo acontece por trás
 * da fala) e morre no fim da transcrição. "Modelo ausente" é estado de
 * primeira classe: o botão diz o que falta e o comando exato de download, em
 * vez de não responder.
 */
export function GlobalComposer({ boardId }: { boardId: string }) {
  const [cards, setCards] = useState<CardRow[]>([]);
  const [targetId, setTargetId] = useState("");
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sendState, setSendState] = useState<SendState>("idle");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceHint, setVoiceHint] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const targetBtnRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // Um envio novo invalida o poll do anterior — sem isso, mandar uma
  // segunda mensagem enquanto a primeira ainda está sendo confirmada
  // deixaria os dois polls escrevendo na MESMA pílula de status.
  const sendSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const fetchCards = async () => {
      try {
        const list = await window.store.list(boardId);
        if (cancelled) return;
        setCards(list.filter((c) => ELIGIBLE_KINDS.includes(c.kind)));
      } catch (e) {
        console.error(e);
      }
    };
    fetchCards();
    const iv = window.setInterval(fetchCards, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [boardId]);

  // Autogrow até um teto — mesmo espírito de um composer tipo Claude/
  // ChatGPT, sem crescer pra sempre e engolir o board.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  /** Devolve o status lido — quem chama `await` precisa do valor NOVO, não do
   * `voiceStatus` capturado no closure do render (que ainda pode ser `null`). */
  const refreshVoiceStatus = useCallback(async (): Promise<VoiceStatus | null> => {
    try {
      const next = await window.voice.status();
      setVoiceStatus(next);
      return next;
    } catch (e) {
      console.error(e);
      setVoiceStatus(null);
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshVoiceStatus();
  }, [refreshVoiceStatus]);

  // Solta o microfone se a barra desmontar gravando — sem isso o device (e o
  // indicador do SO) ficariam presos depois de trocar de board.
  useEffect(
    () => () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    },
    [],
  );

  const revealed = hovered || focused || voiceState !== "idle" || pickerOpen || text.length > 0 || sendState !== "idle";

  const target = cards.find((c) => c.id === targetId);

  // Investigação (2026-09-19): o envio desta barra é `window.bus.send`, que é
  // SÓ TEXTO e SÓ TERMINAL (message-bus.ts, cmd "send"). É por isso que anexo
  // aqui é CAMINHO NO TEXTO: qualquer outra forma de "payload" morreria no PTY
  // do mesmo jeito. O que sobra é recusar com motivo — ver `admitAttachment`.
  const targetKind = target?.kind ?? null;
  const targetProvider = target?.provider ?? null;

  const STATUS_TTL_MS: Record<Exclude<SendState, "idle" | "sending">, number> = {
    delivered: 1800,
    parked: 3200,
    unconfirmed: 3200,
    failed: 4000,
  };

  const dismissTimerRef = useRef<number | undefined>(undefined);
  const scheduleDismiss = useCallback((state: Exclude<SendState, "idle" | "sending">, mySeq: number) => {
    window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = window.setTimeout(() => {
      if (sendSeqRef.current === mySeq) setSendState("idle");
    }, STATUS_TTL_MS[state]);
  }, []);

  // Só de olho por uma janela curta (~2.7s, a soma dos delays abaixo) — o
  // suficiente pro caso comum (card livre, confirma quase na hora) sem fingir
  // que "ainda não confirmou" é a mesma coisa que "deu errado".
  const POLL_DELAYS_MS = [200, 250, 350, 450, 600, 800];

  // NENHUM estado final fica na tela pra sempre — nem os negativos. "Falhou"
  // parado na interface até o próximo envio manual foi o bug relatado ("o
  // dialog fica para sempre"): mesmo uma falha real precisa sumir sozinha, só
  // que com mais tempo de leitura do que uma confirmação positiva.
  const pollDelivery = useCallback(
    (id: string, mySeq: number) => {
      let attempt = 0;
      const tick = async () => {
        let res;
        try {
          res = await window.bus.getDelivery(id);
        } catch (e) {
          console.error(e);
          return; // rede/IPC falhou em CONSULTAR, não em entregar — não é o mesmo fato.
        }
        if (sendSeqRef.current !== mySeq) return; // outro envio já assumiu a pílula.
        if (!res.ok) return;
        if (res.delivery !== "queued") {
          if (res.delivery === "cancelled") {
            setSendState("idle");
          } else {
            setSendState(res.delivery);
            scheduleDismiss(res.delivery, mySeq);
          }
          return;
        }
        if (attempt >= POLL_DELAYS_MS.length) {
          setSendState("idle"); // ainda na fila do card, sem notícia — silêncio, não alarme.
          return;
        }
        const delay = POLL_DELAYS_MS[attempt];
        attempt += 1;
        window.setTimeout(tick, delay);
      };
      tick();
    },
    [scheduleDismiss],
  );

  /**
   * Anexa arquivos — imagem ou documento. O caminho vem do ARQUIVO REAL do SO
   * quando existe (`getPathForFile`): assim um PDF grande NÃO é copiado, e o
   * agente lê o arquivo onde ele está. Quando não existe (paste do clipboard,
   * `File` sintético), os bytes vão para o diretório efêmero do app e o
   * caminho é o de lá.
   */
  async function addFiles(files: File[]) {
    for (const file of files) {
      const kind = classifyAttachment(file);
      if (!kind) {
        toast(t("composer.attach.unsupportedType", { name: file.name || file.type || "?" }));
        continue;
      }
      const admission = admitAttachment({ kind, targetKind, targetProvider });
      if (!admission.ok) {
        toast(t(admission.reason));
        continue;
      }
      if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        toast(t("composer.attach.tooMany", { max: String(MAX_ATTACHMENTS_PER_MESSAGE) }));
        return;
      }

      const realPath = window.boardAssets.getPathForFile(file);
      let path = realPath;
      if (path === "") {
        const base64 = await blobToBase64(file);
        const saved = await window.clipboardImage.saveAttachment(base64, file.name, file.type);
        if (!saved.ok) {
          toast(t("composer.attach.saveFailed", { error: saved.error }));
          continue;
        }
        path = saved.path;
      }

      const previewUrl = kind === "image" ? await fileToDataUrl(file).catch(() => undefined) : undefined;
      const attachment: Attachment = {
        id: `${Date.now()}-${Math.random()}`,
        kind,
        name: file.name || path.split("/").pop() || path,
        ext: extensionOf(file.name),
        size: file.size,
        path,
        previewUrl,
      };
      setAttachments((prev) => [...prev, attachment]);
    }
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  }

  // Só intercepta quando há de fato um arquivo anexável — paste/drop de texto
  // segue o comportamento padrão da textarea.
  function onComposerPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null && classifyAttachment(f) !== null);
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }

  function onComposerDragOver(e: React.DragEvent<HTMLTextAreaElement>) {
    if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  }

  function onComposerDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }

  const handleSend = useCallback(async () => {
    const body = buildDeliveryText(text, attachments.map((a) => a.path));
    if (!targetId || body === "" || sendState === "sending") return;

    // O destino pode ter mudado DEPOIS de anexar (o popover lista cards vivos)
    // — re-checa a admissão antes de mandar, e nunca entrega um anexo que o
    // destino não recebe.
    const refused = attachments
      .map((a) => admitAttachment({ kind: a.kind, targetKind, targetProvider }))
      .find((admission) => !admission.ok);
    if (refused && !refused.ok) {
      toast(t(refused.reason));
      return;
    }

    const mySeq = ++sendSeqRef.current;
    setSendState("sending");
    try {
      const res = await window.bus.send(targetId, body);
      if (sendSeqRef.current !== mySeq) return;
      if (!res.ok) {
        // NUNCA limpar antes da entrega confirmada (bug relatado): o texto e
        // os anexos continuam na barra, e o motivo vem pela pílula.
        setSendState("failed");
        scheduleDismiss("failed", mySeq);
        return;
      }
      // O bus ACEITOU: agora sim o textarea pode esvaziar. Um veredito
      // posterior da FIFO (parked/unconfirmed/failed) é reportado pela
      // pílula sem comer a mensagem de novo — a entrega já foi entregue ao
      // card.
      setText("");
      setAttachments([]);
      if (res.delivery === "queued") {
        pollDelivery(res.id, mySeq);
      } else if (res.delivery === "cancelled") {
        setSendState("idle");
      } else {
        setSendState(res.delivery);
        scheduleDismiss(res.delivery, mySeq);
      }
    } catch (e) {
      console.error(e);
      if (sendSeqRef.current === mySeq) {
        setSendState("failed");
        scheduleDismiss("failed", mySeq);
      }
    }
  }, [targetId, text, sendState, attachments, targetKind, targetProvider, pollDelivery, scheduleDismiss]);

  // Clique na pílula dispensa na hora, sem esperar o TTL.
  const dismissStatus = useCallback(() => {
    window.clearTimeout(dismissTimerRef.current);
    ++sendSeqRef.current;
    setSendState("idle");
  }, []);

  useEffect(() => () => window.clearTimeout(dismissTimerRef.current), []);

  /** O que falta para poder ditar — a mensagem inteira, com o caminho e (no
   * caso do modelo) o comando exato. É o que o botão DIZ em vez de não
   * responder. */
  function voiceMissingMessage(status: VoiceStatus): string {
    if (status.missing === "engine") return t("composer.voice.engineMissing", { path: status.enginePath });
    if (status.missing === "model")
      return t("composer.voice.modelMissing", { path: status.modelPath, command: status.downloadCommand });
    return t("composer.voice.unknown");
  }

  async function copyVoiceCommand() {
    const command = voiceStatus?.downloadCommand ?? "";
    if (command === "") return;
    try {
      await navigator.clipboard.writeText(command);
      toast(t("composer.voice.commandCopied"));
    } catch (e) {
      toast(t("composer.voice.commandCopyFailed", { error: clipError(e) }));
    }
  }

  /**
   * Ditado real: permissão → gravação → (o server sobe enquanto a pessoa
   * fala) → transcrição local → o texto entra no textarea.
   *
   * Nenhuma chamada de rede: o áudio vai por IPC para o `whisper-server` em
   * 127.0.0.1 e o resultado volta como texto.
   */
  const toggleVoice = useCallback(async () => {
    if (voiceState === "recording") {
      recorderRef.current?.stop();
      return;
    }
    if (voiceState !== "idle") return;

    // Estado de primeira classe: sem engine ou sem modelo, o clique DIZ o que
    // falta (com o comando) em vez de um botão que não responde.
    const status = voiceStatus ?? (await refreshVoiceStatus());
    if (status && !status.ready) {
      setVoiceHint(voiceMissingMessage(status));
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // A permissão de microfone passa por confirmação humana de propósito
      // (main/index.ts's PROMPT_PERMISSIONS) — negada, o motivo é dito.
      toast(t("composer.voice.micDenied", { error: clipError(e) }));
      return;
    }
    streamRef.current = stream;
    audioChunksRef.current = [];

    // Aquece AGORA: o load do modelo (CUDA) acontece por trás da fala, não
    // depois do clique de parar. `warmup` é idempotente e o server morre no
    // fim da transcrição.
    void window.voice.warmup();

    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunksRef.current.push(event.data);
    };
    recorder.onerror = (event) => {
      console.error(event);
      recorderRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setVoiceState("idle");
      toast(t("composer.voice.recordFailed"));
    };
    recorder.onstop = async () => {
      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
      audioChunksRef.current = [];
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      if (blob.size === 0) {
        setVoiceState("idle");
        return;
      }
      setVoiceState("transcribing");
      try {
        const base64 = await blobToBase64(blob);
        const result = await window.voice.transcribe(base64, blob.type);
        if (!result.ok) {
          toast(result.error);
          return;
        }
        setText((prev) => (prev ? `${prev} ${result.text}` : result.text));
        textareaRef.current?.focus();
      } catch (e) {
        toast(t("composer.voice.transcribeFailed", { error: clipError(e) }));
      } finally {
        setVoiceState("idle");
        void refreshVoiceStatus();
      }
    };

    recorder.start();
    setVoiceHint(null);
    setVoiceState("recording");
  }, [voiceState, voiceStatus, refreshVoiceStatus]);

  const voiceTitle =
    voiceState === "recording"
      ? t("composer.voice.stop")
      : voiceState === "transcribing"
        ? t("composer.voice.transcribing")
        : voiceStatus && !voiceStatus.ready
          ? t("composer.voice.notReady")
          : t("composer.voice.dictate");

  return (
    <div
      ref={wrapRef}
      className={`${styles.wrap} ${revealed ? styles.revealed : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={styles.handle} aria-hidden>
        <Icon name="chevronUp" size={13} />
      </div>
      {/* Coluna: textarea cresce livre em cima, barra de ferramentas fixa
          embaixo — o botão de destino nunca se move com a altura do texto,
          então o popover dele (side="top", ancorado NELE) também não é mais
          "engolido" por um textarea alto. */}
      <div className={styles.bar} data-role="global-composer" onWheel={(e) => e.stopPropagation()}>
        {attachments.length > 0 && (
          <div className={styles.attachStrip} data-role="composer-attachments">
            {attachments.map((a) =>
              a.kind === "image" && a.previewUrl ? (
                <div key={a.id} className={styles.attachThumb} title={a.name}>
                  <img src={a.previewUrl} alt={a.name} />
                  <button
                    type="button"
                    className={styles.attachRemove}
                    title={t("composer.attach.remove")}
                    onClick={() => removeAttachment(a.id)}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </div>
              ) : (
                // Documento: chip do composer do ChatGPT (ícone + nome +
                // metadados), classes PRÓPRIAS deste module — as globais
                // `chat-attachment-*` são calibradas pro rodapé do card de
                // chat (ver o comentário do `.attachStrip` no .module.css).
                <div key={a.id} className={styles.attachDoc} title={a.path} data-role="composer-attachment-doc">
                  <span className={styles.attachDocIcon}>
                    <Icon name={attachmentIcon(a.name)} size={16} />
                  </span>
                  <span className={styles.attachDocText}>
                    <span className={styles.attachDocName}>{a.name}</span>
                    <span className={styles.attachDocMeta}>
                      {(a.ext || "?").toUpperCase()} · {formatAttachmentSize(a.size)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={styles.attachDocRemove}
                    title={t("composer.attach.remove")}
                    onClick={() => removeAttachment(a.id)}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </div>
              ),
            )}
          </div>
        )}

        {voiceHint !== null && (
          <div className={styles.voiceHint} data-role="composer-voice-hint">
            <span className={styles.voiceHintText}>{voiceHint}</span>
            <button type="button" className={styles.voiceHintCopy} onClick={() => void copyVoiceCommand()}>
              {t("composer.voice.copyCommand")}
            </button>
            <button
              type="button"
              className={styles.voiceHintClose}
              title={t("common.close")}
              onClick={() => setVoiceHint(null)}
            >
              <Icon name="close" size={10} />
            </button>
          </div>
        )}

        {/* Linha [+][textarea] — o "+" fica à esquerda do input, na referência
            do ChatGPT; a toolbar (destino/status/voz/enviar) segue embaixo. */}
        <div className={styles.inputRow}>
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className={styles.iconBtn}
            data-role="composer-attach"
            onClick={() => {
              // Não desabilitado por destino: o motivo da recusa é o que o
              // usuário precisa ouvir, e um botão morto não diz nada.
              const admission = admitAttachment({ kind: "document", targetKind, targetProvider });
              if (!admission.ok) {
                toast(t(admission.reason));
                return;
              }
              fileInputRef.current?.click();
            }}
            title={t("composer.attach.add")}
          >
            <Icon name="plus" size={16} />
          </button>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPaste={onComposerPaste}
            onDragOver={onComposerDragOver}
            onDrop={onComposerDrop}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={t("composer.placeholder")}
          />
        </div>

        <div className={styles.toolbar}>
          <button ref={targetBtnRef} type="button" className={styles.targetBtn} onClick={() => setPickerOpen((o) => !o)}>
            {target ? <Icon name={cardIcon(target)} size={13} color={cardColor(target)} /> : <Icon name="findCard" size={13} />}
            <span className={styles.targetLabel}>{target ? target.label || target.id.slice(0, 6) : t("composer.target")}</span>
            <Icon name="chevronDown" size={11} />
          </button>

          <Popover
            anchorRef={targetBtnRef}
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            side="top"
            gap={8}
            className="popover--composer"
          >
            <div className={styles.targetList}>
              {cards.length === 0 && <div className={styles.targetEmpty}>{t("composer.targetEmpty")}</div>}
              {cards.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`${styles.targetRow} ${c.id === targetId ? styles.active : ""}`}
                  onClick={() => {
                    setTargetId(c.id);
                    setPickerOpen(false);
                  }}
                >
                  <Icon name={cardIcon(c)} size={14} color={cardColor(c)} />
                  {c.label || c.id.slice(0, 6)}
                </button>
              ))}
            </div>
          </Popover>

          {sendState !== "idle" && (
            <button
              type="button"
              className={`${styles.status} ${styles[sendState]}`}
              data-role="composer-status"
              onClick={dismissStatus}
              title={t("composer.status.dismiss")}
            >
              <span className={sendState === "sending" ? styles.spin : undefined}>
                <Icon name={STATUS_ICON[sendState]} size={12} />
              </span>
              {t(STATUS_LABEL_KEYS[sendState])}
            </button>
          )}

          <div className={styles.spacer} />

          <button
            type="button"
            className={`${styles.iconBtn} ${voiceState === "recording" ? styles.recording : ""}`}
            data-role="composer-voice"
            data-voice-state={voiceState}
            onClick={() => void toggleVoice()}
            title={voiceTitle}
          >
            {voiceState === "transcribing" ? (
              <span className={styles.spin}>
                <Icon name="spinner" size={16} />
              </span>
            ) : (
              <Icon name="mic" size={16} />
            )}
          </button>

          <button
            type="button"
            className={`${styles.iconBtn} ${styles.sendBtn}`}
            data-role="composer-send"
            onClick={() => void handleSend()}
            disabled={!targetId || (text.trim() === "" && attachments.length === 0) || sendState === "sending"}
            title={t("composer.send")}
          >
            <Icon name="send" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
