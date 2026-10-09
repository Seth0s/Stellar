/**
 * Resolve how an agent named a target: CSS selector, snapshot ref, role+name
 * (getByRole), or visible text (getByText). Pure — the page-side finder source
 * is generated here; the registry runs it.
 */

export type LocatorInput = {
  selector?: string | null;
  ref?: string | null;
  role?: string | null;
  name?: string | null;
  text?: string | null;
};

export type LocatorDecision =
  | { kind: "css"; selector: string; describe: string }
  | { kind: "ref"; ref: string; selector: string; describe: string }
  | { kind: "role"; role: string; name: string | null; describe: string }
  | { kind: "text"; text: string; describe: string }
  | { kind: "refuse"; error: string };

/** Precedence: ref → role(+name) → text → selector. */
export function decideLocator(input: LocatorInput): LocatorDecision {
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (ref) {
    const selector = `[data-stellar-ref="${ref.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
    return { kind: "ref", ref, selector, describe: `ref ${JSON.stringify(ref)}` };
  }
  const role = typeof input.role === "string" ? input.role.trim() : "";
  if (role) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    return {
      kind: "role",
      role,
      name: name.length > 0 ? name : null,
      describe: name ? `role=${JSON.stringify(role)} name=${JSON.stringify(name)}` : `role=${JSON.stringify(role)}`,
    };
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text) {
    return { kind: "text", text, describe: `text=${JSON.stringify(text)}` };
  }
  const selector = typeof input.selector === "string" ? input.selector.trim() : "";
  if (selector) {
    return { kind: "css", selector, describe: `selector ${JSON.stringify(selector)}` };
  }
  return {
    kind: "refuse",
    error:
      "need a target: pass `ref` (from browser_snapshot), `selector` (plain CSS), `role` (+ optional `name`), or `text` (visible text). Playwright :has-text()/text= in selector are not CSS — use `text`/`role` instead.",
  };
}

/**
 * Page-side finder. Returns `{ __value: element }` semantics via an IIFE that
 * assigns to a local `el` — callers wrap further. `frameSelector` scopes into
 * an iframe's contentDocument when set.
 */
export function locatorFindSource(locator: Exclude<LocatorDecision, { kind: "refuse" }>, frameSelector: string | null): string {
  const frameJson = frameSelector === null ? "null" : JSON.stringify(frameSelector);
  const body =
    locator.kind === "css" || locator.kind === "ref"
      ? `el = root.querySelector(${JSON.stringify(locator.selector)});`
      : locator.kind === "role"
        ? roleFindBody(locator.role, locator.name)
        : textFindBody(locator.text);
  return `(() => {
    const frameSel = ${frameJson};
    let root = document;
    if (frameSel) {
      const frame = document.querySelector(frameSel);
      if (!frame) return { __noMatch: true, __frameMissing: true };
      const doc = frame.contentDocument;
      if (!doc) return { __noMatch: true, __frameInaccessible: true };
      root = doc;
    }
    let el = null;
    ${body}
    if (!el) return { __noMatch: true };
    return { __value: el };
  })()`;
}

function roleFindBody(role: string, name: string | null): string {
  const roleJson = JSON.stringify(role.toLowerCase());
  // wantName is lowercased here so it matches accName()'s normalized form.
  const nameJson = name === null ? "null" : JSON.stringify(name.toLowerCase());
  return `
    const wantRole = ${roleJson};
    const wantName = ${nameJson};
    function accName(node) {
      const aria = node.getAttribute && node.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim().toLowerCase();
      const labelledBy = node.getAttribute && node.getAttribute("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy.split(/\\s+/).map((id) => root.getElementById(id)).filter(Boolean);
        const joined = parts.map((n) => (n.innerText || n.textContent || "").trim()).join(" ").trim();
        if (joined) return joined.toLowerCase();
      }
      return String(node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
    }
    function implicitRole(node) {
      const explicit = node.getAttribute && node.getAttribute("role");
      if (explicit) return String(explicit).toLowerCase();
      const tag = String(node.tagName || "").toLowerCase();
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "a" && node.hasAttribute("href")) return "link";
      if (tag === "input") {
        const t = String(node.type || "text").toLowerCase();
        if (t === "checkbox" || t === "radio") return t;
        if (t === "submit" || t === "button" || t === "reset") return "button";
        return "textbox";
      }
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "option") return "option";
      return "";
    }
    const all = root.querySelectorAll("*");
    for (const node of all) {
      if (implicitRole(node) !== wantRole) continue;
      if (wantName !== null && accName(node) !== wantName) continue;
      if (node.getClientRects && node.getClientRects().length === 0) continue;
      el = node;
      break;
    }
  `;
}

function textFindBody(text: string): string {
  const textJson = JSON.stringify(text.toLowerCase());
  return `
    const want = ${textJson};
    const candidates = root.querySelectorAll("button,a,[role=button],[role=link],[role=menuitem],[role=option],[role=tab],label,summary");
    for (const node of candidates) {
      const t = String(node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
      if (t === want || t.includes(want)) {
        if (node.getClientRects && node.getClientRects().length === 0) continue;
        el = node;
        break;
      }
    }
  `;
}

/** Stable key for re-resolving a ref after re-render (same role+name+tag). */
export function stableHandleKey(input: { role: string; name: string; tag: string }): string {
  return `${input.role.toLowerCase()}|${input.name.toLowerCase()}|${input.tag.toLowerCase()}`;
}

export type ActionTargetState = {
  value: string | null;
  checked: boolean | null;
  ariaInvalid: string | null;
  ariaExpanded: string | null;
  /** Tabs / toggle buttons — for widgets that do not use aria-expanded. */
  ariaSelected: string | null;
  text: string | null;
};

/** AGENT-FACING — DO NOT TRANSLATE. */
export function describeUnchangedAction(action: "click" | "type", before: ActionTargetState, after: ActionTargetState): string {
  return (
    `[de: stellar] browser_${action}: the target's observed state did not change ` +
    `(value=${JSON.stringify(after.value)}, checked=${JSON.stringify(after.checked)}, ` +
    `aria-invalid=${JSON.stringify(after.ariaInvalid)}, aria-expanded=${JSON.stringify(after.ariaExpanded)}, ` +
    `aria-selected=${JSON.stringify(after.ariaSelected)}). ` +
    `Before: value=${JSON.stringify(before.value)}, checked=${JSON.stringify(before.checked)}, ` +
    `aria-invalid=${JSON.stringify(before.ariaInvalid)}, aria-expanded=${JSON.stringify(before.ariaExpanded)}, ` +
    `aria-selected=${JSON.stringify(before.ariaSelected)}. ` +
    `The ${action} was dispatched — if nothing happened on screen, the widget may ignore synthetic input ` +
    `or the wrong node was targeted; re-check with browser_snapshot / role+name.`
  );
}

export function actionStatesEqual(a: ActionTargetState, b: ActionTargetState): boolean {
  return (
    a.value === b.value &&
    a.checked === b.checked &&
    a.ariaInvalid === b.ariaInvalid &&
    a.ariaExpanded === b.ariaExpanded &&
    a.ariaSelected === b.ariaSelected &&
    a.text === b.text
  );
}

/** Page-side probe of the target's post-action (or pre-action) state. */
export function actionTargetStateSource(selector: string, frameSelector: string | null): string {
  const frameJson = frameSelector === null ? "null" : JSON.stringify(frameSelector);
  return `(() => {
    const frameSel = ${frameJson};
    let root = document;
    if (frameSel) {
      const frame = document.querySelector(frameSel);
      if (!frame || !frame.contentDocument) return { __noMatch: true };
      root = frame.contentDocument;
    }
    let el = null;
    try {
      el = root.querySelector(${JSON.stringify(selector)});
    } catch (err) {
      return { __selectorError: String((err && err.message) || err) };
    }
    if (!el) return { __noMatch: true };
    return {
      __value: {
        value: "value" in el ? String(el.value) : null,
        checked: "checked" in el ? Boolean(el.checked) : null,
        ariaInvalid: el.getAttribute ? el.getAttribute("aria-invalid") : null,
        ariaExpanded: el.getAttribute ? el.getAttribute("aria-expanded") : null,
        ariaSelected: el.getAttribute ? el.getAttribute("aria-selected") : null,
        text: String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120) || null,
      },
    };
  })()`;
}

/**
 * Materialize a role/text/ref-fallback find into a temporary CSS stamp so the
 * existing click settle/verify path keeps using querySelector.
 */
export function stampLocatorSource(
  locator: Extract<LocatorDecision, { kind: "ref" | "role" | "text" }>,
  frameSelector: string | null,
  stamp: string,
): string {
  const find = locatorFindSource(locator, frameSelector);
  return `(() => {
    const found = ${find};
    if (found.__noMatch) return found;
    const el = found.__value;
    if (!el) return { __noMatch: true };
    el.setAttribute("data-stellar-tgt", ${JSON.stringify(stamp)});
    return {
      __value: {
        selector: ${JSON.stringify(`[data-stellar-tgt="${stamp}"]`)},
        role: (el.getAttribute && el.getAttribute("role")) || null,
        name: String(el.getAttribute && el.getAttribute("aria-label") || el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
        tag: String(el.tagName || "").toLowerCase(),
      },
    };
  })()`;
}

/** Re-bind a dead snapshot ref by the last known role+name+tag handle. */
export function resolveStableHandleSource(
  handle: { role: string; name: string; tag: string },
  frameSelector: string | null,
  stamp: string,
): string {
  return stampLocatorSource(
    { kind: "role", role: handle.role, name: handle.name || null, describe: "stable-handle" },
    frameSelector,
    stamp,
  );
}
