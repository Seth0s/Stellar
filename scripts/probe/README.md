# Sonda: `WebContentsView` nativo compõe nesta máquina?

**Como rodar (da raiz do repo, sem subir o Stellar):**

```
node_modules/.bin/electron scripts/probe
```

Roda em Wayland por padrão (mesmo ozone do Stellar em produção); para a variante X11: `PROBE_OZONE=x11 node_modules/.bin/electron scripts/probe`. Usa `--user-data-dir` próprio em `/tmp/stellar-probe-userdata-*` (app separado, não encosta na instância do dono). Resultado em JSON no stdout e evidência (screenshots + `result.json`) em `scripts/probe/out/<ozone>/`. O screenshot é da tela inteira via portal XDG (requer a permissão `screenshot` já concedida no PermissionStore — ver `docs/BROWSER_CARD_NATIVE.md`). Contexto e veredito: `docs/BROWSER_CARD_NATIVE.md`.
