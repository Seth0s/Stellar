/**
 * Pure style comparison + allowlist for prototype parity.
 * Used by prototype-parity.mjs and unit tests — no Electron dependency.
 */

export const DEFAULT_STYLE_PROPS = [
  "font-size",
  "font-weight",
  "line-height",
  "padding",
  "gap",
  "color",
  "background-color",
  "border",
  "border-radius",
  "width",
  "height",
];

export const DEFAULT_TOLERANCES = {
  lengthPx: 1,
  colorDeltaE: 2.5,
  fontWeight: 0,
};

/** Parse a CSS length to px. Returns null when not a comparable length. */
export function parseCssPx(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (s === "" || s === "auto" || s === "none" || s === "normal") return null;
  if (s.endsWith("px")) {
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  if (s.endsWith("%")) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(s) ? n : null;
}

/** Parse rgb()/rgba()/hex into sRGB 0–255 channels. */
export function parseCssColor(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    }
    const r = Number.parseInt(h.slice(0, 2), 16);
    const g = Number.parseInt(h.slice(2, 4), 16);
    const b = Number.parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  const m = s.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/,
  );
  if (m) {
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] != null ? Number(m[4]) : 1,
    };
  }
  return null;
}

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function rgbToLab(rgb) {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  let x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  let y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  let z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
  x /= 0.95047;
  y /= 1;
  z /= 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 ΔE between two CSS colors. Null when either color cannot be parsed. */
export function colorDeltaE(a, b) {
  const ca = typeof a === "string" ? parseCssColor(a) : a;
  const cb = typeof b === "string" ? parseCssColor(b) : b;
  if (!ca || !cb) return null;
  if (ca.a === 0 && cb.a === 0) return 0;
  const la = rgbToLab(ca);
  const lb = rgbToLab(cb);
  return Math.hypot(la.L - lb.L, la.a - lb.a, la.b - lb.b);
}

function normalizeFontWeight(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "normal" || s === "400") return 400;
  if (s === "bold" || s === "700") return 700;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function splitBox(value) {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return [];
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return parts.slice(0, 4);
}

function lengthsClose(a, b, tol) {
  const pa = parseCssPx(a);
  const pb = parseCssPx(b);
  if (pa == null || pb == null) return String(a).trim() === String(b).trim();
  return Math.abs(pa - pb) <= tol;
}

/**
 * Compare one computed style property. Returns null when equal within tolerance,
 * or a diff object when they diverge.
 */
export function compareStyleProp(prop, protoValue, implValue, tolerances = DEFAULT_TOLERANCES) {
  const tol = { ...DEFAULT_TOLERANCES, ...tolerances };
  const p = protoValue == null ? "" : String(protoValue);
  const i = implValue == null ? "" : String(implValue);
  if (p === i) return null;

  if (prop === "color" || prop === "background-color" || prop.endsWith("-color")) {
    const dE = colorDeltaE(p, i);
    if (dE != null && dE <= tol.colorDeltaE) return null;
    if (dE == null && p.trim() === i.trim()) return null;
    return { prop, proto: p, impl: i, delta: dE, kind: "color" };
  }

  if (prop === "font-weight") {
    const wa = normalizeFontWeight(p);
    const wb = normalizeFontWeight(i);
    if (wa != null && wb != null && Math.abs(wa - wb) <= tol.fontWeight) return null;
    return { prop, proto: p, impl: i, kind: "font-weight" };
  }

  if (
    prop === "font-size" ||
    prop === "width" ||
    prop === "height" ||
    prop === "gap" ||
    prop === "line-height" ||
    prop === "left" ||
    prop === "top"
  ) {
    // line-height may be unitless; compare px when both parse, else string equality.
    if (prop === "line-height") {
      const pa = parseCssPx(p);
      const pb = parseCssPx(i);
      if (pa != null && pb != null) {
        if (Math.abs(pa - pb) <= tol.lengthPx) return null;
        return { prop, proto: p, impl: i, delta: Math.abs(pa - pb), kind: "length" };
      }
      if (p.trim() === i.trim()) return null;
      return { prop, proto: p, impl: i, kind: "string" };
    }
    if (lengthsClose(p, i, tol.lengthPx)) return null;
    const pa = parseCssPx(p);
    const pb = parseCssPx(i);
    return {
      prop,
      proto: p,
      impl: i,
      delta: pa != null && pb != null ? Math.abs(pa - pb) : null,
      kind: "length",
    };
  }

  if (prop === "padding" || prop === "border-radius" || prop === "margin") {
    const a = splitBox(p);
    const b = splitBox(i);
    if (a.length === 4 && b.length === 4) {
      const ok = a.every((side, idx) => lengthsClose(side, b[idx], tol.lengthPx));
      if (ok) return null;
    } else if (lengthsClose(p, i, tol.lengthPx)) {
      return null;
    }
    return { prop, proto: p, impl: i, kind: "box" };
  }

  if (prop === "border" || prop.startsWith("border-")) {
    // Compare width tokens when present; otherwise require exact match after trim.
    const widthA = p.match(/([\d.]+px)/);
    const widthB = i.match(/([\d.]+px)/);
    if (widthA && widthB && lengthsClose(widthA[1], widthB[1], tol.lengthPx)) {
      const colorA = p.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/);
      const colorB = i.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/);
      if (colorA && colorB) {
        const dE = colorDeltaE(colorA[0], colorB[0]);
        if (dE != null && dE <= tol.colorDeltaE) return null;
      }
    }
    if (p.replace(/\s+/g, " ").trim() === i.replace(/\s+/g, " ").trim()) return null;
    return { prop, proto: p, impl: i, kind: "border" };
  }

  if (p.replace(/\s+/g, " ").trim() === i.replace(/\s+/g, " ").trim()) return null;
  return { prop, proto: p, impl: i, kind: "string" };
}

/**
 * Compare full style maps for one selector pair.
 * @returns {{ pairId: string, diffs: object[] }}
 */
export function comparePairStyles(pairId, protoStyles, implStyles, props = DEFAULT_STYLE_PROPS, tolerances = DEFAULT_TOLERANCES) {
  const diffs = [];
  for (const prop of props) {
    const diff = compareStyleProp(prop, protoStyles?.[prop], implStyles?.[prop], tolerances);
    if (diff) diffs.push({ pairId, ...diff });
  }
  return { pairId, diffs };
}

/**
 * An approved diff must name pairId + prop and carry approvedBy + date (owner sign-off).
 */
export function isApprovedDiff(diff, allowlist = []) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  return allowlist.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (!entry.approvedBy || !entry.date) return false;
    if (entry.pairId !== diff.pairId) return false;
    if (entry.prop !== diff.prop) return false;
    if (entry.proto != null && String(entry.proto) !== String(diff.proto)) return false;
    if (entry.impl != null && String(entry.impl) !== String(diff.impl)) return false;
    return true;
  });
}

/**
 * Split raw diffs into failing vs approved-by-owner.
 */
export function applyAllowlist(diffs, allowlist = []) {
  const failing = [];
  const approved = [];
  for (const diff of diffs) {
    if (isApprovedDiff(diff, allowlist)) approved.push(diff);
    else failing.push(diff);
  }
  return { failing, approved };
}

/** Render a fixed-width markdown table for CLI / report files. */
export function formatDiffTable(diffs) {
  if (!diffs.length) return "_Nenhuma divergência fora da allowlist._\n";
  const header =
    "| pairId | prop | proto | impl | delta |\n|---|---|---|---|---|\n";
  const rows = diffs
    .map((d) => {
      const delta =
        d.delta == null ? "—" : typeof d.delta === "number" ? d.delta.toFixed(2) : String(d.delta);
      return `| ${d.pairId} | ${d.prop} | ${escCell(d.proto)} | ${escCell(d.impl)} | ${delta} |`;
    })
    .join("\n");
  return header + rows + "\n";
}

function escCell(v) {
  return String(v ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

/**
 * Validate machine spec shape. Throws on hard contract errors.
 */
function validatePairs(pairs, label) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error(`${label} pairs must be a non-empty array`);
  }
  for (const pair of pairs) {
    if (!pair.id || !pair.proto || !pair.impl) {
      throw new Error(`pair requires id/proto/impl: ${JSON.stringify(pair)}`);
    }
  }
}

export function validateParitySpec(spec) {
  if (!spec || typeof spec !== "object") throw new Error("parity spec must be an object");
  if (!spec.id) throw new Error("parity spec.id is required");
  if (!spec.viewport || !spec.viewport.width || !spec.viewport.height) {
    throw new Error("parity spec.viewport.{width,height} is required");
  }
  const scenes = Array.isArray(spec.scenes) ? spec.scenes : null;
  if (scenes && scenes.length > 0) {
    for (const scene of scenes) {
      if (!scene.id) throw new Error(`scene requires id: ${JSON.stringify(scene)}`);
      const pairs = scene.pairs || spec.pairs;
      validatePairs(pairs, `scene ${scene.id}`);
    }
  } else {
    validatePairs(spec.pairs, "spec");
  }
  if (spec.approvedDiffs) {
    for (const a of spec.approvedDiffs) {
      if (!a.approvedBy || !a.date || !a.pairId || !a.prop) {
        throw new Error(
          `approvedDiffs entry needs pairId, prop, approvedBy, date: ${JSON.stringify(a)}`,
        );
      }
    }
  }
  return true;
}

/** Expand a SPEC that may declare `scenes[]` into one runnable snapshot each. */
export function expandParityScenes(spec) {
  const scenes = Array.isArray(spec.scenes) ? spec.scenes : null;
  if (!scenes || scenes.length === 0) {
    return [{ ...spec, _sceneId: null }];
  }
  return scenes.map((scene) => ({
    ...spec,
    ...scene,
    id: scene.id ? `${spec.id}-${scene.id}` : spec.id,
    pairs: scene.pairs || spec.pairs,
    root: scene.root || spec.root,
    viewport: scene.viewport || spec.viewport,
    protoQuery: scene.protoQuery || spec.protoQuery,
    fixtureScene: scene.fixtureScene || scene.id || null,
    approvedDiffs: scene.approvedDiffs || spec.approvedDiffs || [],
    _sceneId: scene.id || null,
    _baseId: spec.id,
    _path: spec._path,
  }));
}
