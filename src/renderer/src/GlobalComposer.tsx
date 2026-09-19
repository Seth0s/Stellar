import { useCallback, useEffect, useRef, useState } from "react";
import type { CardRow } from "../../preload/index";
import type { BusDelivery } from "../../preload/index";
import type { ChatImageBlock } from "../../preload/index";
import { Icon, type IconName } from "./icons";
import { Popover } from "./Popover";
import { PROVIDER_GLYPH } from "./provider-glyph";
import { toast } from "./useToast";
import styles from "./GlobalComposer.module.css";

const ELIGIBLE_KINDS = ["terminal", "browser", "chat"];
const KIND_ICON: Record<string, IconName> = { terminal: "terminal", browser: "browser", chat: "chat" };

// Anexos de imagem — mesmas regras que o composer do ChatCard.tsx usa
// (`ALLOWED_IMAGE_TYPES`/`MAX_ATTACHMENTS_PER_MESSAGE`; lá são privadas do
// módulo, então os valores são repetidos aqui com a mesma intenção).
const ALLOWED_IMAGE_TYPES: ChatImageBlock["mediaType"][] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_ATTACHMENTS_PER_MESSAGE = 4;

type Attachment = {
  id: string;
  /** Caminho real em disco devolvido por `window.clipboardImage.saveBytes`. */
  path: string;
  mediaType: ChatImageBlock["mediaType"];
  /** Data URL local — miniatura instantânea, sem round-trip de IPC. */
  previewUrl: string;
  name: string;
};

// `queued` never reaches the UI as a final state — pollDelivery keeps
// ticking until the FIFO resolves it one way or another (or gives up).
type SendState = "idle" | "sending" | Exclude<BusDelivery, "queued" | "cancelled">;

const STATUS_LABEL: Record<Exclude<SendState, "idle">, string> = {
  sending: "Enviando…",
  delivered: "Entregue",
  parked: "Na fila do agente",
  unconfirmed: "Sem confirmação",
  failed: "Falhou",
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

/**
 * Barra de input global do board: escolhe um card-alvo e manda texto (ou
 * dita por voz) sem precisar clicar dentro do terminal dele. Fica fora da
 * viewport por padrão — só a alça no rodapé fica visível — e é puxada pra
 * dentro no hover (ou quando tem foco/texto/gravação/entrega pendente, pra
 * nunca sumir no meio de uma digitação só porque o mouse saiu).
 */
export function GlobalComposer({ boardId }: { boardId: string }) {
  const [cards, setCards] = useState<CardRow[]>([]);
  const [targetId, setTargetId] = useState("");
  const [text, setText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [micSupported] = useState(
    () => typeof window !== "undefined" && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sendState, setSendState] = useState<SendState>("idle");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const targetBtnRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
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

  const revealed = hovered || focused || isRecording || pickerOpen || text.length > 0 || sendState !== "idle";

  const target = cards.find((c) => c.id === targetId);

  // Investigação (2026-09-19): o envio desta barra é `window.bus.send`, que
  // é SÓ TEXTO e SÓ TERMINAL (message-bus.ts, cmd "send"); o anexo de imagem
  // do ChatCard vai por `window.chat.send` (fala direto com a sessão do
  // provider, nunca passa pelo bus). Não existe transporte de imagem para
  // terminal/browser — então o botão de anexar só habilita quando o alvo é um
  // card de chat, em vez de aceitar um arquivo que se perderia no envio.
  const canAttach = target?.kind === "chat";

  // Só de olho por uma janela curta (~2.7s, a soma dos delays abaixo) — o
  // suficiente pro caso comum (card livre, confirma quase na hora) sem
  // fingir que "ainda não confirmou" é a mesma coisa que "deu errado".
  // send_to_card NUNCA fica pendurado esperando (ORCHESTRATION.md §8) — a
  // UI segue o mesmo espírito: some de volta pro idle em silêncio se o
  // card só está ocupado (turno em andamento, prompt de permissão etc.),
  // sem acusar nada. Só mostra estado real quando o bus JÁ RESOLVEU pra
  // algo — delivered/parked/failed/unconfirmed vindo do próprio bus, não
  // inventado por ter desistido de perguntar.
  const POLL_DELAYS_MS = [200, 250, 350, 450, 600, 800];

  // NENHUM estado final fica na tela pra sempre — nem os negativos. "Falhou"
  // parado na interface até o próximo envio manual foi o bug relatado ("o
  // dialog fica para sempre"): mesmo uma falha real precisa sumir sozinha,
  // só que com mais tempo de leitura do que uma confirmação positiva.
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

  const pollDelivery = useCallback((id: string, mySeq: number) => {
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
  }, [scheduleDismiss]);

  // Anexos — mesmo caminho do ChatCard (`window.clipboardImage.saveBytes` já
  // resolve o caminho em disco; o data URL local evita um round-trip só pra
  // mostrar a miniatura que a pessoa acabou de colar).
  async function addImageFile(file: File) {
    if (!canAttach) return;
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      toast(`Máximo de ${MAX_ATTACHMENTS_PER_MESSAGE} anexos por mensagem`);
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.type as ChatImageBlock["mediaType"])) {
      toast("Tipo de imagem não suportado (use PNG, JPEG, GIF ou WebP)");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const result = await window.clipboardImage.saveBytes(base64, file.type);
    if (!result.ok) {
      toast(`Não foi possível anexar: ${result.error}`);
      return;
    }
    setAttachments((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        path: result.path,
        mediaType: file.type as ChatImageBlock["mediaType"],
        previewUrl: dataUrl,
        name: file.name,
      },
    ]);
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  }

  // Só intercepta quando há de fato uma imagem — paste/drop de texto segue o
  // comportamento padrão da textarea. Ignorado por completo fora de um alvo
  // de chat (nenhum transporte de imagem existe ali).
  function onComposerPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return;
    const imageItems = Array.from(e.clipboardData.items).filter((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) void addImageFile(file);
    }
  }

  function onComposerDragOver(e: React.DragEvent<HTMLTextAreaElement>) {
    if (!canAttach) return;
    if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  }

  function onComposerDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    if (!canAttach) return;
    const imageFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    e.preventDefault();
    for (const file of imageFiles) void addImageFile(file);
  }

  const handleSend = useCallback(async () => {
    // Honestidade (ver `canAttach` acima): o composer não transporta anexo
    // hoje. Nunca enviar e descartar o arquivo em silêncio — o anexo fica na
    // tela e o motivo é dito.
    if (attachments.length > 0) {
      toast("Anexos ainda não são entregues por esta barra — remova para enviar o texto");
      return;
    }
    const body = text.trim();
    if (!targetId || !body || sendState === "sending") return;
    const mySeq = ++sendSeqRef.current;
    setSendState("sending");
    setText("");
    try {
      const res = await window.bus.send(targetId, body);
      if (sendSeqRef.current !== mySeq) return;
      if (!res.ok) {
        setSendState("failed");
        scheduleDismiss("failed", mySeq);
        return;
      }
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
  }, [targetId, text, sendState, attachments.length, pollDelivery, scheduleDismiss]);

  // Clique na pílula dispensa na hora, sem esperar o TTL.
  const dismissStatus = useCallback(() => {
    window.clearTimeout(dismissTimerRef.current);
    ++sendSeqRef.current;
    setSendState("idle");
  }, []);

  useEffect(() => () => window.clearTimeout(dismissTimerRef.current), []);

  const toggleVoice = useCallback(() => {
    if (isRecording) {
      recognitionRef.current?.stop();
      return;
    }
    if (!micSupported) return;
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const sr = new SpeechRec();
    sr.lang = "pt-BR";
    sr.continuous = false;
    sr.interimResults = true;
    sr.onstart = () => setIsRecording(true);
    sr.onresult = (e: any) => {
      let finalTranscript = "";
      for (let i = e.resultIndex; i < e.results.length; ++i) {
        if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript;
      }
      if (finalTranscript) setText((prev) => (prev ? `${prev} ${finalTranscript}` : finalTranscript).trim());
    };
    sr.onerror = () => setIsRecording(false);
    sr.onend = () => setIsRecording(false);
    recognitionRef.current = sr;
    sr.start();
  }, [isRecording, micSupported]);

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
      <div
        className={styles.bar}
        data-role="global-composer"
        onWheel={(e) => e.stopPropagation()}
      >
        {attachments.length > 0 && (
          <div className={styles.attachStrip}>
            {attachments.map((a) => (
              <div key={a.id} className={styles.attachThumb} title={a.name}>
                <img src={a.previewUrl} alt={a.name} />
                <button
                  type="button"
                  className={styles.attachRemove}
                  title="Remover anexo"
                  onClick={() => removeAttachment(a.id)}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Linha [+][textarea] — o "+" fica à esquerda do input, na referência
            do ChatGPT; a toolbar (destino/status/voz/enviar) segue embaixo. */}
        <div className={styles.inputRow}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              for (const file of Array.from(e.target.files ?? [])) void addImageFile(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => fileInputRef.current?.click()}
            disabled={!canAttach}
            title={
              canAttach
                ? "Anexar imagem"
                : "Anexo só para cards de chat — terminal/browser não têm transporte de imagem"
            }
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
                handleSend();
              }
            }}
            placeholder="Enviar mensagem…"
          />
        </div>

        <div className={styles.toolbar}>
          <button ref={targetBtnRef} type="button" className={styles.targetBtn} onClick={() => setPickerOpen((o) => !o)}>
            {target ? <Icon name={cardIcon(target)} size={13} color={cardColor(target)} /> : <Icon name="findCard" size={13} />}
            <span className={styles.targetLabel}>{target ? target.label || target.id.slice(0, 6) : "Destino"}</span>
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
              {cards.length === 0 && <div className={styles.targetEmpty}>Nenhum card elegível neste board</div>}
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
              title="Dispensar"
            >
              <span className={sendState === "sending" ? styles.spin : undefined}>
                <Icon name={STATUS_ICON[sendState]} size={12} />
              </span>
              {STATUS_LABEL[sendState]}
            </button>
          )}

          <div className={styles.spacer} />

          <button
            type="button"
            className={`${styles.iconBtn} ${isRecording ? styles.recording : ""}`}
            onClick={toggleVoice}
            disabled={!micSupported}
            title={micSupported ? "Ditar por voz" : "Ditado por voz não suportado neste ambiente"}
          >
            <Icon name="mic" size={16} />
          </button>

          <button
            type="button"
            className={`${styles.iconBtn} ${styles.sendBtn}`}
            onClick={handleSend}
            disabled={!targetId || !text.trim() || sendState === "sending"}
            title="Enviar"
          >
            <Icon name="send" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
