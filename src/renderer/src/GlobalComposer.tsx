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

/**
 * Destinos que esta barra OFERECE = destinos que o `bus.send` ENTREGA.
 *
 * MEDIDO (task 3f701053): o bus entrega UM kind — `listTerminalCards()` em
 * message-bus.ts filtra `kind === "terminal"` no cmd `send`. A barra oferecia
 * TRÊS (`terminal`, `browser`, `chat`); no board de hoje isso são 7 cards de
 * chat oferecidos que NÃO podem receber. E não é "caro entregar em chat":
 * seria um TRANSPORTE NOVO — um card de chat não tem PTY nenhum (o caminho
 * dele é `window.chat.send`, canal do provider com blocos de imagem), então
 * `isCardAlive`/`getCardWriteReadiness`/`writeToCard` não têm onde escrever.
 * Enquanto esse transporte não existir do lado do bus, oferecer chat/browser é
 * oferecer o que se engole — o defeito que esta task fecha pelo lado de cá.
 * (A recusa POR MOTIVO em `attachments.ts` continua sendo a matriz: ela cobre
 * os kinds que o picker já não oferece, para o dia em que algum voltar.)
 */
const ELIGIBLE_KINDS = ["terminal"];
const KIND_ICON: Record<string, IconName> = { terminal: "terminal", browser: "browser", chat: "chat" };

/** Teto de anexos por mensagem. Imagem continua com o mesmo número de antes
 * (4); documento entra no MESMO teto — a barra entrega caminhos, e uma lista
 * longa de caminhos no texto vira ruído no prompt. */
const MAX_ATTACHMENTS_PER_MESSAGE = 4;

/**
 * HISTÓRICO do composer global (2026-09-20) — o input não tinha NENHUM: seta
 * para cima não trazia o prompt anterior. MEDIDO antes de escrever: nem o card
 * de chat (`ChatCard.tsx`'s `onComposerKeyDown`) nem o terminal mantêm
 * histórico de composer — o `Alt+←/→` que o `shortcut-registry.ts` cita é o
 * history do próprio Chromium (content layer), e a seta do terminal vai pro
 * PTY/shell. Não havia, portanto, uma terceira convenção a copiar; a que vale
 * é a do REPL/shell, também a que o enunciado fixa: seta-para-CIMA só recupera
 * com o cursor na PRIMEIRA linha, seta-para-BAIXO só na ÚLTIMA — assim o
 * textarea multi-linha não perde o "mover o cursor" para a seta.
 *
 * O que guarda é o TEXTO que a pessoa escreveu, não o corpo com os caminhos de
 * anexo que o app anexa na entrega: esses são mecanismo, e ressuscitá-los num
 * rascunho traria um caminho possivelmente morto. Mensagem só-de-anexo não tem
 * prompt a recuperar e não entra. PERSISTE entre sessões (`localStorage`,
 * decidido e declarado no relatório) — fechar o app não perde o que se escreveu.
 * O RASCUNHO não-enviado é outra coisa e NÃO mora aqui (ver `draftRef`): é
 * justamente o que a navegação tem de preservar.
 */
const HISTORY_STORAGE_KEY = "stellar.global-composer.history";
const HISTORY_MAX = 50;

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  } catch {
    return []; // JSON corrompido ou storage indisponível: histórico é conveniência.
  }
}

function writeHistory(entries: string[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage cheio/bloqueado não pode quebrar o ENVIO — o histórico é extra.
  }
}

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

/**
 * TTL por estado. A ASSIMETRIA é o ponto (task 3c696ec9): sucesso — e `parked`,
 * que é espera e destrava sozinha — sumem por conta própria; `failed` e
 * `unconfirmed` NÃO TÊM ENTRADA aqui, e a ausência é a política: eles ficam até
 * o usuário reconhecer (clique) ou até a próxima tentativa. `parked` fora da
 * lista é deliberado — permanente ali viraria poluição no caso NORMAL, que é
 * destravar. Uma entrega que FALHOU é a única em que a mensagem não chegou: não
 * pode se apagar sozinha (o defeito que esta task conserta).
 */
const STATUS_TTL_MS: Partial<Record<Exclude<SendState, "idle" | "sending">, number>> = {
  delivered: 1800,
  parked: 3200,
};

/**
 * A linha que diz QUAL card, QUAL motivo e O QUE tentar — o que "Falhou" sozinho
 * não diz. O motivo vem do lugar que o mediu: `res.error` quando o bus RECUSOU
 * na hora, ou o veredito do laço de confirmação quando a FIFO não confirmou;
 * sem motivo, a linha fica só com o card em vez de inventar uma causa.
 */
function describeDeliveryProblem(card: string, reason?: string | null): string {
  const why = (reason ?? "").trim();
  return `${why ? `${card}: ${why}` : card} — ${t("common.retry")}`;
}

/**
 * O laço de confirmação devolve `confirm.result` dentro do `get_delivery` (o
 * main o repassa verbatim), mas o tipo do preload não o declara — a MESMA
 * classe de "a anotação subvende o runtime" que o comentário de `bus.send` já
 * registra (`delivery`/`id`/`reason` eram "só no runtime" e estavam lá). Lido
 * por um cast estreito em vez de mexer no preload (fora do território): é o
 * motivo REAL da falha, não um texto genérico.
 */
function deliveryConfirmResult(res: unknown): string | null {
  if (res === null || typeof res !== "object") return null;
  const confirm = (res as { confirm?: unknown }).confirm;
  if (confirm === null || typeof confirm !== "object") return null;
  const result = (confirm as { result?: unknown }).result;
  return typeof result === "string" ? result : null;
}

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
  // Linha de detalhe dos estados PERSISTENTES (`failed`/`unconfirmed`): qual
  // card, o motivo real e o que tentar. `null` nos efêmeros — a pílula curta
  // continua curta onde não há o que explicar.
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
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
  // Nome do card-alvo no INSTANTE do envio: o poll da FIFO resolve depois, e o
  // `target` do render pode já ter mudado (ou o card sumido) — a pílula da
  // falha tem de citar o card para onde o texto FOI, não o selecionado agora.
  const statusCardRef = useRef("");

  // Histórico (carregado UMA vez do localStorage) + navegação. `navIdxRef` é
  // quantos passos atrás do mais novo estamos e `null` significa "fora da
  // navegação, mostrando a caixa viva"; `draftRef` é o rascunho que estava na
  // caixa quando a navegação começou, para devolvê-lo ao voltar (passar do
  // mais novo com a seta para baixo). Sem isso, o rascunho some — o defeito
  // clássico desta feature.
  const historyRef = useRef<string[] | null>(null);
  if (historyRef.current === null) historyRef.current = readHistory();
  const navIdxRef = useRef<number | null>(null);
  const draftRef = useRef("");

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
  // Nome curto do alvo para a linha de falha — primitivo (estável) de propósito,
  // para o `useCallback` do envio não depender do objeto `target`, que nasce de
  // novo a cada render.
  const targetLabel = target ? target.label || target.id.slice(0, 6) : "";

  // Investigação (2026-09-19): o envio desta barra é `window.bus.send`, que é
  // SÓ TEXTO e SÓ TERMINAL (message-bus.ts, cmd "send"). É por isso que anexo
  // aqui é CAMINHO NO TEXTO: qualquer outra forma de "payload" morreria no PTY
  // do mesmo jeito. O que sobra é recusar com motivo — ver `admitAttachment`.
  const targetKind = target?.kind ?? null;
  const targetProvider = target?.provider ?? null;

  const dismissTimerRef = useRef<number | undefined>(undefined);
  const scheduleDismiss = useCallback((state: Exclude<SendState, "idle" | "sending">, mySeq: number) => {
    window.clearTimeout(dismissTimerRef.current);
    // Sem TTL = PERSISTENTE (ver `STATUS_TTL_MS`): nada é agendado. O que tira
    // a pílula da tela é o clique (reconhecer) ou o próximo envio — não o tempo.
    const ttl = STATUS_TTL_MS[state];
    if (ttl === undefined) return;
    dismissTimerRef.current = window.setTimeout(() => {
      if (sendSeqRef.current === mySeq) setSendState("idle");
    }, ttl);
  }, []);

  // Só de olho por uma janela curta (~2.7s, a soma dos delays abaixo) — o
  // suficiente pro caso comum (card livre, confirma quase na hora) sem fingir
  // que "ainda não confirmou" é a mesma coisa que "deu errado".
  const POLL_DELAYS_MS = [200, 250, 350, 450, 600, 800];

  // ATENÇÃO — este comentário dizia o OPOSTO até a task 3c696ec9 ("nenhum
  // estado final fica na tela pra sempre, nem os negativos / mesmo uma falha
  // real precisa sumir sozinha"). Aquilo tratava falha como sucesso. O que vale
  // agora (ver `STATUS_TTL_MS`): o POSITIVO some sozinho; `failed`/`unconfirmed`
  // ficam. A lição anterior que CONTINUA valendo é a do CSS — a pílula segue
  // inline na toolbar, nunca flutuando solta na tela (ver o comentário em
  // `GlobalComposer.module.css`); o que mudou foi QUANDO ela some, não onde ela
  // mora.
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
            setStatusDetail(null);
          } else {
            setSendState(res.delivery);
            // O motivo real só existe no ponto em que o laço fechou o veredito —
            // para os estados persistentes ele é dito; os efêmeros não carregam linha.
            setStatusDetail(
              res.delivery === "failed" || res.delivery === "unconfirmed"
                ? describeDeliveryProblem(statusCardRef.current, deliveryConfirmResult(res))
                : null,
            );
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
    // O teto é POR MENSAGEM, não por lote. Ler `attachments.length` dentro do
    // laço devolvia o comprimento de ANTES do lote (o state só atualiza depois
    // dos `await`s), então cinco arquivos num único paste/drop passavam todos.
    // `room` é semeado do que JÁ está anexado — é isso que faz a SEGUNDA leva
    // (anexar 3, anexar mais 3) respeitar o mesmo teto; um contador que
    // reiniciasse a cada chamada quebraria exatamente esse caso.
    let room = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
    let excess = 0;
    for (const file of files) {
      // Sem vaga, o arquivo não entra — mas NÃO some em silêncio: conta e o
      // aviso sai uma vez no fim, com o número e o motivo. Descartar calado
      // era o mesmo defeito silencioso que a ccab0c58 acabou de consertar.
      if (room <= 0) {
        excess += 1;
        continue;
      }
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

      // `getPathForFile` LANÇA para um `File` sintético (paste do clipboard,
      // só em memória) — mesmo motivo e mesmo try/catch de `App.tsx`'s
      // `getRealPath`. Medido: sem o guard, o throw abortava `addFiles`
      // inteiro, então o anexo colado sumia SEM chip, SEM toast e SEM envio
      // — o "mando imagem e não envia" relatado. O throw vira "sem path de
      // SO", que é o que faz os bytes irem pro diretório efêmero logo abaixo.
      let realPath: string;
      try {
        realPath = window.boardAssets.getPathForFile(file);
      } catch {
        realPath = "";
      }
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
      // Consome a vaga só quando o anexo de fato entra — um arquivo recusado
      // (tipo/admissão) não pode "gastar" um slot do teto.
      room -= 1;
      setAttachments((prev) => [...prev, attachment]);
    }
    if (excess > 0) {
      toast(
        t("composer.attach.excess", {
          count: String(excess),
          max: String(MAX_ATTACHMENTS_PER_MESSAGE),
        }),
      );
    }
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  }

  /** Coloca o texto e leva o caret para o FIM — depois do render, como o
   * `ChatCard.tsx` faz ao inserir quebra. Sem isto, a próxima seta partiria do
   * meio do texto recuperado e a navegação travaria na primeira linha. */
  function setTextWithCaretAtEnd(next: string) {
    setText(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
  }

  /** Navega o histórico. `up` = mais antigo, `down` = mais novo. Devolve `true`
   * quando CONSUMIU a tecla (o chamador faz `preventDefault`) e `false` para
   * deixar a textarea mover o cursor — é o que preserva o multi-linha. */
  function navigateHistory(dir: "up" | "down"): boolean {
    const history = historyRef.current ?? [];
    const el = textareaRef.current;
    if (!el || history.length === 0) return false;
    if (el.selectionStart !== el.selectionEnd) return false; // há seleção: deixa o nativo
    const onFirstLine = !el.value.slice(0, el.selectionStart).includes("\n");
    const onLastLine = !el.value.slice(el.selectionEnd).includes("\n");
    if (dir === "up" ? !onFirstLine : !onLastLine) return false;

    const current = navIdxRef.current;
    if (dir === "down" && current === null) return false; // baixo fora da navegação = cursor normal
    if (current === null) draftRef.current = el.value; // começa a navegar: guarda o rascunho

    const next = dir === "up" ? (current ?? -1) + 1 : (current ?? 0) - 1;
    if (next < 0) {
      // Passou do mais novo de volta pra caixa: devolve o rascunho guardado.
      navIdxRef.current = null;
      setTextWithCaretAtEnd(draftRef.current);
      return true;
    }
    const bounded = Math.min(next, history.length - 1);
    navIdxRef.current = bounded;
    setTextWithCaretAtEnd(history[history.length - 1 - bounded]);
    return true;
  }

  /** Grava no histórico o TEXTO que a pessoa escreveu (não o corpo com os
   * caminhos de anexo — ver o comentário do módulo). Sem repetição colada e
   * com teto. Só é chamado quando o bus ACEITOU: uma entrega que falhou deixa
   * o texto na caixa, e gravá-lo agora duplicaria. */
  function recordHistory(entry: string) {
    if (entry.trim() === "") return;
    const history = historyRef.current ?? [];
    if (history[history.length - 1] === entry) return;
    const next = [...history, entry].slice(-HISTORY_MAX);
    historyRef.current = next;
    writeHistory(next);
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
    // Congela o card-alvo para a linha de falha (o poll resolve depois) e limpa
    // o detalhe anterior: uma tentativa NOVA substitui a falha antiga, não
    // acumula — a barra tem uma caixa só, e uma lista de falhas seria justamente
    // a poluição que a lição do CSS recusa.
    statusCardRef.current = targetLabel || targetId.slice(0, 6);
    setStatusDetail(null);
    setSendState("sending");
    try {
      const res = await window.bus.send(targetId, body);
      if (sendSeqRef.current !== mySeq) return;
      if (!res.ok) {
        // NUNCA limpar antes da entrega confirmada (bug relatado): o texto e
        // os anexos continuam na barra, e o motivo vem pela pílula. O motivo
        // AQUI é o `res.error` real do bus — antes ele era descartado.
        setSendState("failed");
        setStatusDetail(describeDeliveryProblem(statusCardRef.current, res.error));
        scheduleDismiss("failed", mySeq);
        return;
      }
      // O bus ACEITOU: agora sim o textarea pode esvaziar. Um veredito
      // posterior da FIFO (parked/unconfirmed/failed) é reportado pela
      // pílula sem comer a mensagem de novo — a entrega já foi entregue ao
      // card.
      setText("");
      setAttachments([]);
      // O envio virou histórico e a caixa está em branco: qualquer navegação
      // em curso acabou (senão a próxima seta subiria do índice antigo).
      recordHistory(text);
      navIdxRef.current = null;
      draftRef.current = "";
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
        setStatusDetail(describeDeliveryProblem(statusCardRef.current, clipError(e)));
        scheduleDismiss("failed", mySeq);
      }
    }
  }, [targetId, targetLabel, text, sendState, attachments, targetKind, targetProvider, pollDelivery, scheduleDismiss]);

  // Clique na pílula dispensa na hora — é o RECONHECIMENTO do usuário, o único
  // caminho (além da próxima tentativa) que tira da tela uma falha persistente.
  const dismissStatus = useCallback(() => {
    window.clearTimeout(dismissTimerRef.current);
    ++sendSeqRef.current;
    setStatusDetail(null);
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
            onChange={(e) => {
              setText(e.target.value);
              // O humano assumiu a caixa: sai da navegação (o setText do
              // histórico é programático e NÃO dispara onChange, então isto
              // só roda em digitação de verdade).
              navIdxRef.current = null;
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPaste={onComposerPaste}
            onDragOver={onComposerDragOver}
            onDrop={onComposerDrop}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                // Só consome quando de fato navega (cursor na 1ª/última linha,
                // sem seleção); caso contrário devolve a seta pra textarea.
                if (navigateHistory(e.key === "ArrowUp" ? "up" : "down")) e.preventDefault();
                return;
              }
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
              {statusDetail !== null && <span className={styles.statusDetail}>· {statusDetail}</span>}
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
