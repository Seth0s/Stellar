// SPIKE MEDIDO do wry/tao (task 3ec0ed3b) — binário de teste ISOLADO, fora do
// app. Não é dependência do Stellar e não entra no build do Electron.
//
// O que ele responde com número:
//   · quantos processos a WebView nativa cria por view e o RSS de cada um
//     (medido de fora, pelo driver Node, somando a ÁRVORE de /proc);
//   · cobertura de `eval` (innerText / querySelector+rect / setar input /
//     clicar) com o tempo de cada chamada;
//   · VmRSS do processo UI em cada estágio (boot → created → after-eval).
//
// API: wry 0.57 / tao 0.37 — `WebViewBuilder::new().with_url(u).build(&win)`, e
// o resultado do eval chega por CALLBACK (`evaluate_script` é fire-and-forget).
//
// Uso: wry-spike --views N --url <http://…> --hold-ms M
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::{WebView, WebViewBuilder};

fn arg_str(args: &[String], key: &str, def: &str) -> String {
    let i = args.iter().position(|a| a == key);
    match i {
        Some(i) => args.get(i + 1).cloned().unwrap_or_else(|| def.to_string()),
        None => def.to_string(),
    }
}

fn arg_num<T: std::str::FromStr>(args: &[String], key: &str, def: T) -> T {
    arg_str(args, key, "").parse::<T>().ok().unwrap_or(def)
}

/// VmRSS do processo UI (kB), lido do próprio /proc.
fn vm_rss_kb() -> u64 {
    if let Ok(text) = std::fs::read_to_string("/proc/self/status") {
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("VmRSS:") {
                if let Some(kb) = rest.split_whitespace().next() {
                    return kb.parse().unwrap_or(0);
                }
            }
        }
    }
    0
}

/// `evaluate_script_with_callback` sincronizado no mpsc — devolve (resultado, µs).
fn eval(wv: &WebView, js: &str, timeout: Duration) -> (String, u128) {
    let (tx, rx) = mpsc::channel::<String>();
    let t = Instant::now();
    let sent = wv.evaluate_script_with_callback(js, move |s| {
        let _ = tx.send(s);
    });
    let out = if sent.is_ok() { rx.recv_timeout(timeout).unwrap_or_default() } else { String::new() };
    (out, t.elapsed().as_micros())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let views: usize = arg_num(&args, "--views", 1);
    let hold_ms: u64 = arg_num(&args, "--hold-ms", 6000);
    let url: String = arg_str(&args, "--url", "about:blank");
    let html_mode = args.iter().any(|a| a == "--html");

    println!("{{\"stage\":\"boot\",\"vmRssKb\":{}}}", vm_rss_kb());

    let t_start = Instant::now();
    let event_loop = EventLoopBuilder::new().build();
    let mut handles: Vec<(tao::window::Window, WebView)> = Vec::new();
    for i in 0..views {
        let win = WindowBuilder::new()
            .with_title(format!("wry-spike-{i}"))
            .with_inner_size(LogicalSize::new(720.0, 420.0))
            .build(&event_loop)
            .expect("window");
        // `--html`: fixture INLINE (sem rede), para isolar "o engine carrega?"
        // de "o load HTTP funciona?".
        let builder = if html_mode {
            WebViewBuilder::new().with_html(
                "<!doctype html><html><head><title>spike</title></head><body>SPIKE-MARKER inline \
                 <div id=\"box\" style=\"width:200px;height:80px\"></div>\
                 <input id=\"inp\"><button id=\"btn\" onclick=\"document.title='SPIKE-CLICKED'\">S</button></body></html>",
            )
        } else {
            WebViewBuilder::new().with_url(&url)
        };
        let wv = builder.build(&win).expect("webview");
        handles.push((win, wv));
    }
    println!(
        "{{\"stage\":\"created\",\"views\":{},\"vmRssKb\":{},\"ms\":{}}}",
        views,
        vm_rss_kb(),
        t_start.elapsed().as_millis()
    );

    // ESPERA O CARREGAMENTO de verdade (poll no innerText) em vez de um sleep
    // fixo — medido: com 2,5s o `eval` voltava vazio (a página ainda não tinha
    // carregado). Reporta quanto levou e quantas tentativas.
    if views > 0 {
        let mut tries = 0;
        let mut loaded = false;
        while tries < 40 && !loaded {
            tries += 1;
            let (txt, _) = eval(&handles[0].1, "document.body ? document.body.innerText : ''", Duration::from_secs(3));
            loaded = txt.len() > 2;
            if !loaded {
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        println!(
            "{{\"stage\":\"load\",\"loaded\":{},\"tries\":{},\"ms\":{}}}",
            loaded,
            tries,
            t_start.elapsed().as_millis()
        );
    }

    // COBERTURA DE EVAL — o que `browser_eval`/`get_page_text`/`query`/`type`
    // precisam. Cada chamada cronometrada.
    if views == 0 {
        println!("{{\"stage\":\"eval\",\"skipped\":\"views=0\"}}");
        std::thread::sleep(Duration::from_millis(hold_ms));
        return;
    }
    let to = Duration::from_secs(4);
    let (text, us_text) = eval(&handles[0].1, "document.body.innerText", to);
    let (rect, us_rect) = eval(
        &handles[0].1,
        "(()=>{const e=document.getElementById('box');if(!e)return '';const r=e.getBoundingClientRect();return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height)});})()",
        to,
    );
    let (typed, us_type) = eval(
        &handles[0].1,
        "(()=>{const i=document.getElementById('inp');if(!i)return 'NO-INPUT';i.value='abc';return i.value;})()",
        to,
    );
    let (clicked, us_click) = eval(
        &handles[0].1,
        "(()=>{const b=document.getElementById('btn');if(!b)return 'NO-BTN';b.click();return document.title;})()",
        to,
    );

    let marker = if text.contains("SPIKE-MARKER") { "yes" } else { "no" };
    // JSON VÁLIDO: os campos de texto vão entre aspas (a 1ª versão emitia
    // `"rect":,` com string vazia sem aspas e o `JSON.parse` do driver falhava
    // — review R8). E, porque o callback do `evaluate_script_with_callback`
    // volta VAZIO em TODA chamada, o eval é reportado como PROBE QUEBRADO
    // quando as quatro respostas vêm vazias: um probe quebrado não distingue
    // "a página não renderizou" de "o eval não entrega" (review R8).
    let mut probe = "ok";
    if text.is_empty() && rect.is_empty() && typed.is_empty() && clicked.is_empty() {
        probe = "broken";
    }
    println!(
        "{{\"stage\":\"eval\",\"probe\":\"{}\",\"innerTextBytes\":{},\"hasMarker\":\"{}\",\"rect\":\"{}\",\"typed\":\"{}\",\"title\":\"{}\",\"usText\":{},\"usRect\":{},\"usType\":{},\"usClick\":{}}}",
        probe, text.len(), marker, rect, typed, clicked, us_text, us_rect, us_type, us_click
    );
    println!("{{\"stage\":\"after-eval\",\"vmRssKb\":{}}}", vm_rss_kb());

    // Segura as janelas abertas para o driver medir a árvore de processos.
    let start = Instant::now();
    event_loop.run(move |event, _, control_flow| {
        if start.elapsed().as_millis() as u64 >= hold_ms {
            *control_flow = ControlFlow::Exit;
            return;
        }
        if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
            *control_flow = ControlFlow::Exit;
            return;
        }
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(100));
        // mantém as views vivas (não deixa o Vec ser dropado antes do fim)
        let _ = handles.len();
    });
}
