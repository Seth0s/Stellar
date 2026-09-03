// Item 57.9 — pdf.js's worker script (PdfViewer.tsx) needs its own real
// URL, not bundled inline; Vite's `?url` suffix is the standard way to
// import an asset as a resolved URL string instead of its content. Has
// to live in a file with NO top-level import/export of its own — inside
// a module (like env.d.ts, which imports preload types) TS treats
// `declare module "*?url"` as an AUGMENTATION of an existing module
// (requiring it to already resolve) instead of a fresh ambient
// declaration, and fails with "Invalid module name in augmentation".
declare module "*?url" {
  const url: string;
  export default url;
}

// Colocalização de CSS (2026-09-03) — Vite processa `*.module.css`
// nativamente em runtime (escopo de classe por hash), mas o TS precisa
// dessa declaração ambiente pra aceitar `import styles from
// "./X.module.css"` — o shape real (objeto de string->string) é o
// mesmo que `vite/client` documenta.
declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}
