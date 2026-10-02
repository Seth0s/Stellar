@echo off
rem Stub do bridge MCP no WINDOWS (task 52c895da). O polyglot `sh` de
rem `stellar-mcp` NAO roda no Windows (nao ha /bin/sh nem shebang executavel),
rem entao o `command` registrado pelas CLIs aponta para ESTE .cmd.
rem
rem Ordem: (1) o binario RUST ao lado (relay, ~2 MB) quando existe; (2) sem ele,
rem o shim node — o polyglot roda sob `node` explicito, e o env do card traz
rem AGENT_CANVAS_NODE (o binario do proprio Electron/Node). Nenhuma dependencia
rem do host alem do que a app ja injeta.
rem
rem NAO VERIFICADO num Windows real nesta maquina (Linux): escrito pelo mesmo
rem motivo que `mcpCommandPath` existe — declarado, nao apresentado como provado.
setlocal
set "HERE=%~dp0"

if exist "%HERE%stellar-mcp-relay.exe" (
  "%HERE%stellar-mcp-relay.exe"
  exit /b %ERRORLEVEL%
)

set "NODE=%AGENT_CANVAS_NODE%"
if not defined NODE set "NODE=node"
if "%NODE%"=="${" set "NODE=node"
"%NODE%" "%HERE%stellar-mcp" %*
exit /b %ERRORLEVEL%
