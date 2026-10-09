//! stellar-mcp-relay — stub stdio do bridge MCP, em RUST (task f7a2ac84).
//!
//! This relay connects the stdio client to the app's Unix socket. The app
//! authenticates the peer process instead of accepting an identity in a line.
//! It reads `AGENT_CANVAS_MCP_URL`, derives the bridge socket path, and pumps
//! stdio to that Unix socket. It does not send a caller identity; the main
//! authenticates the kernel-reported peer PID and its PTY ancestry.
//!
//! POR QUE RUST (decisao do dono): seguranca de memoria; UM fonte em vez de
//! reescrever Winsock2 a mao; e um lugar para acumular otimizacoes futuras de
//! processo/RAM sem virar uma segunda linguagem no repo.
//!
//! PLANO DE BUILD POR ALVO (`cargo build --release --target <triple>`, o
//! binario vai para `resources/bin/`, que ja e `extraResources`):
//!
//!   linux   : x86_64-unknown-linux-gnu   — PROVADO AQUI (compila, roda, mede).
//!   windows : x86_64-pc-windows-gnu (mingw) ou -msvc — NAO PROVADO AQUI: exige
//!             toolchain mingw-w64/MSVC no runner. O fonte ja tem o caminho
//!             (`cfg(windows)` + crate `uds_windows`, AF_UNIX do Win10 1803+),
//!             mas "um fonte" NAO e "um toolchain".
//!   darwin  : x86_64-apple-darwin / aarch64-apple-darwin — NAO PROVADO AQUI:
//!             exige SDK do macOS (osxcross num runner Linux, ou um runner mac).
//!
//! ATENCAO (declarado, nao escondido): o `resources/bin/stellar-mcp` escolhe o
//! binario pela METADE `sh` do polyglot — que NAO existe no Windows. La o
//! `command` da CLI tem que apontar para o binario (ou um wrapper .cmd) direto;
//! este fonte e agnostico, a Fiacao do shim para Windows ainda nao esta feita.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::path::PathBuf;
use std::process::ExitCode;

#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(windows)]
use uds_windows::UnixStream;

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Aplica `AGENT_CANVAS_PROC_NAME` ao `comm` deste processo (task 817daa3e).
///
/// Linux: `prctl(PR_SET_NAME)` — muda o `comm` (o kernel trunca em
/// `TASK_COMM_LEN` - 1 = 15 chars) e NAO o `cmdline`; e o `comm` que o monitor
/// de processos mostra (o `cmdline` continua sendo o caminho deste binario,
/// que ja e NOSSO). A regra do nome vem PRONTA do app
/// (`process-name-decision.ts`, injetada por `pty-registry.ts`) e aqui so e
/// APLICADA — uma regra, nao duas. Sem a variavel, NAO renomeia.
///
/// `extern "C"` direto (sem o crate `libc`) mantem o "zero crate no caminho
/// unix" que o Cargo.toml declara: `prctl` e da libc que o binario ja linka.
#[cfg(target_os = "linux")]
fn apply_process_name() {
    const PR_SET_NAME: i32 = 15;
    extern "C" {
        fn prctl(option: i32, arg2: usize, arg3: usize, arg4: usize, arg5: usize) -> i32;
    }
    if let Some(name) = env_nonempty("AGENT_CANVAS_PROC_NAME") {
        if let Ok(cname) = std::ffi::CString::new(name) {
            unsafe {
                prctl(PR_SET_NAME, cname.as_ptr() as usize, 0, 0, 0);
            }
        }
    }
}

/// macOS/Windows: o `comm` E o proprio nome do executavel e nao ha API
/// portavel para sobrescreve-lo (no macOS `pthread_setname_np` mexe so na
/// thread; no Windows o nome do processo vem do image file). Degradacao
/// honesta: o processo continua identificavel pelo binario `stellar-mcp-relay`.
#[cfg(not(target_os = "linux"))]
fn apply_process_name() {}

/// Deriva `<tmpdir>/stellar-mcp-relay-<porta>.sock` de
/// `http://127.0.0.1:<porta>/...`. Mesma regra do `relaySocketPath` (TS) e do
/// ramo `sh` do shim: so a rota local, porta obrigatoria. `None` = nada a
/// rotear (agente fora de um card).
fn relay_socket_path() -> Option<PathBuf> {
    let url = env_nonempty("AGENT_CANVAS_MCP_URL")?;
    let tmp = env_nonempty("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let rest = url
        .strip_prefix("http://127.0.0.1:")
        .or_else(|| url.strip_prefix("http://localhost:"))?;
    let port = rest.split('/').next().unwrap_or("");
    if port.is_empty() || port.len() >= 16 {
        return None;
    }
    Some(tmp.join(format!("stellar-mcp-relay-{port}.sock")))
}

fn main() -> ExitCode {
    // Antes de qualquer I/O: o nome e barato e vale para a vida inteira do
    // processo, inclusive se ele morrer no handshake.
    apply_process_name();

    let path = match relay_socket_path() {
        Some(p) => p,
        None => {
            eprintln!("stellar-mcp-relay: AGENT_CANVAS_MCP_URL ausente/invalida");
            return ExitCode::from(2);
        }
    };

    let mut stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("stellar-mcp-relay: connect {}: {e}", path.display());
            return ExitCode::from(5);
        }
    };

    let mut reader = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("stellar-mcp-relay: clone: {e}");
            return ExitCode::from(7);
        }
    };

    // socket -> stdout (numa thread); stdin -> socket (na main). Ao EOF do
    // stdin, `shutdown(Write)` faz o par fechar e a thread terminar.
    let pump = std::thread::spawn(move || {
        let mut stdout = io::stdout();
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if stdout.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    let _ = stdout.flush();
                }
                Err(_) => break,
            }
        }
    });

    let mut stdin = io::stdin();
    let mut buf = [0u8; 65536];
    loop {
        match stdin.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = stream.shutdown(Shutdown::Write);
    let _ = pump.join();
    ExitCode::SUCCESS
}
