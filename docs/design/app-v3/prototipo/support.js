/**
 * Headless-capable runtime for approved `.dc.html` prototypes.
 * Fills {{placeholders}}, evaluates <sc-if>/<sc-for>, loads <dc-import>,
 * and runs <script type="text/x-dc"> without changing the approved markup.
 */
(function () {
  "use strict";

  class DCLogic {
    constructor(props) {
      this.props = props && typeof props === "object" ? props : {};
      this.state = {};
      this._host = null;
      this._template = null;
      this._handlers = new Map();
      this._handlerSeq = 0;
    }

    setState(partial) {
      this.state = Object.assign({}, this.state, partial);
      if (this._host && this._template) this._mount();
    }

    renderVals() {
      return {};
    }

    _bind(host, templateHtml) {
      this._host = host;
      this._template = templateHtml;
      this._mount();
    }

    _mount() {
      const vals = this.renderVals() || {};
      this._handlers.clear();
      this._handlerSeq = 0;
      const frag = expandTemplate(this._template, vals, this);
      this._host.replaceChildren(frag);
      applyHelmet(this._host);
      bindHandlerClicks(this._host, this._handlers);
      const base = document.baseURI || location.href;
      this._importsReady = hydrateImports(this._host, base);
    }
  }

  const root = typeof globalThis !== "undefined" ? globalThis : window;
  root.DCLogic = DCLogic;

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function lookup(path, scope) {
    if (!path) return undefined;
    const parts = String(path).trim().split(".");
    let cur = scope;
    for (const part of parts) {
      if (cur == null) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  function coerceHint(raw) {
    const t = String(raw || "").trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null") return null;
    if (t !== "" && !Number.isNaN(Number(t)) && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t;
  }

  function resolveExpr(expr, scope) {
    const trimmed = String(expr || "").trim();
    if (!trimmed) return "";
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return lookup(trimmed, scope);
  }

  function replaceMustache(text, scope, logic) {
    return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
      const v = resolveExpr(expr, scope);
      if (typeof v === "function") {
        const id = `h${logic._handlerSeq++}`;
        logic._handlers.set(id, v);
        return id;
      }
      if (v == null) return "";
      if (typeof v === "boolean" || typeof v === "number") return String(v);
      return String(v);
    });
  }

  function truthy(v) {
    return !(v === false || v == null || v === "" || v === 0);
  }

  function parseDocument(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function extractDcParts(doc) {
    const xdc = doc.querySelector("x-dc");
    const script = doc.querySelector('script[type="text/x-dc"]');
    return {
      template: xdc ? xdc.innerHTML : doc.body ? doc.body.innerHTML : "",
      scriptText: script ? script.textContent || "" : "",
      propsJson: script ? script.getAttribute("data-props") || "{}" : "{}",
    };
  }

  function instantiateComponent(scriptText, props) {
    const runner = new Function(
      "DCLogic",
      `${scriptText}\n; return typeof Component === "function" ? Component : null;`,
    );
    const Component = runner(DCLogic);
    if (!Component) throw new Error("DC script did not declare class Component");
    return new Component(props || {});
  }

  function expandTemplate(html, scope, logic) {
    const doc = parseDocument(`<div id="dc-root">${html}</div>`);
    const root = doc.getElementById("dc-root");
    processNode(root, scope, logic);
    // Move nodes out of the parsed document, then import once.
    // importNode alone does not detach — a while(firstChild)+importNode loop OOMs.
    const parsedFrag = doc.createDocumentFragment();
    while (root.firstChild) parsedFrag.appendChild(root.firstChild);
    return document.importNode(parsedFrag, true);
  }

  function processNode(node, scope, logic) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue && node.nodeValue.includes("{{")) {
        node.nodeValue = replaceMustache(node.nodeValue, scope, logic);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();

    if (tag === "sc-if") {
      const valueAttr = node.getAttribute("value");
      const hint = node.getAttribute("hint-placeholder-val");
      let show;
      if (valueAttr && /\{\{/.test(valueAttr)) {
        const expr = valueAttr.replace(/^\{\{\s*|\s*\}\}$/g, "");
        const resolved = resolveExpr(expr, scope);
        show = resolved === undefined && hint != null
          ? truthy(coerceHint(String(hint).replace(/^\{\{\s*|\s*\}\}$/g, "")))
          : truthy(resolved);
      } else if (valueAttr != null) {
        show = truthy(coerceHint(valueAttr));
      } else {
        show = true;
      }
      const parent = node.parentNode;
      if (!show) {
        parent.removeChild(node);
        return;
      }
      const kids = Array.from(node.childNodes);
      for (const kid of kids) {
        processNode(kid, scope, logic);
        parent.insertBefore(kid, node);
      }
      parent.removeChild(node);
      return;
    }

    if (tag === "sc-for") {
      const listAttr = node.getAttribute("list") || "";
      const asName = node.getAttribute("as") || "item";
      const expr = listAttr.replace(/^\{\{\s*|\s*\}\}$/g, "");
      const list = resolveExpr(expr, scope);
      const items = Array.isArray(list) ? list : [];
      const parent = node.parentNode;
      const templateKids = Array.from(node.childNodes);
      for (const item of items) {
        const itemScope = Object.assign({}, scope);
        itemScope[asName] = item;
        for (const tmpl of templateKids) {
          const clone = tmpl.cloneNode(true);
          processNode(clone, itemScope, logic);
          parent.insertBefore(clone, node);
        }
      }
      parent.removeChild(node);
      return;
    }

    if (tag === "dc-import") {
      // Resolved asynchronously after first paint; leave a sized placeholder.
      const name = node.getAttribute("name") || "";
      const hint = node.getAttribute("hint-size") || "";
      const [w, h] = hint.split(",").map((s) => s.trim());
      const ph = document.createElement("div");
      ph.setAttribute("data-dc-import", name);
      if (w) ph.style.width = w;
      if (h) ph.style.height = h;
      ph.style.overflow = "hidden";
      for (const attr of Array.from(node.attributes)) {
        if (attr.name === "name" || attr.name === "hint-size") continue;
        ph.setAttribute(`data-prop-${attr.name}`, attr.value);
      }
      node.parentNode.replaceChild(ph, node);
      return;
    }

    // Attributes
    const attrs = Array.from(node.attributes);
    for (const attr of attrs) {
      const name = attr.name;
      const raw = attr.value;
      if (name === "onClick" || name === "onclick") {
        if (/\{\{/.test(raw)) {
          const expr = raw.replace(/^\{\{\s*|\s*\}\}$/g, "");
          const fn = resolveExpr(expr, scope);
          node.removeAttribute(name);
          if (typeof fn === "function") {
            const id = `h${logic._handlerSeq++}`;
            logic._handlers.set(id, fn);
            node.setAttribute("data-dc-click", id);
          }
        }
        continue;
      }
      if (/\{\{/.test(raw)) {
        const only = raw.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
        if (only) {
          const v = resolveExpr(only[1], scope);
          if (typeof v === "function") {
            const id = `h${logic._handlerSeq++}`;
            logic._handlers.set(id, v);
            if (name === "class" || name === "className") node.setAttribute("class", "");
            else node.setAttribute(name, id);
          } else if (v == null) {
            node.setAttribute(name, "");
          } else {
            node.setAttribute(name, String(v));
          }
        } else {
          node.setAttribute(name, replaceMustache(raw, scope, logic));
        }
      }
    }

    const children = Array.from(node.childNodes);
    for (const child of children) processNode(child, scope, logic);
  }

  function applyHelmet(host) {
    const helmets = host.querySelectorAll("helmet");
    for (const helmet of helmets) {
      for (const child of Array.from(helmet.childNodes)) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName.toLowerCase();
        if (tag === "style") {
          const style = document.createElement("style");
          style.setAttribute("data-dc-helmet", "");
          style.textContent = child.textContent || "";
          document.head.appendChild(style);
        } else if (tag === "link") {
          const href = child.getAttribute("href");
          const already = Array.from(document.querySelectorAll("link[href]")).some(
            (el) => el.getAttribute("href") === href,
          );
          if (href && !already) {
            const link = document.createElement("link");
            for (const attr of Array.from(child.attributes)) {
              link.setAttribute(attr.name, attr.value);
            }
            document.head.appendChild(link);
          }
        }
      }
      helmet.remove();
    }
  }

  function bindHandlerClicks(root, handlers) {
    root.querySelectorAll("[data-dc-click]").forEach((el) => {
      const id = el.getAttribute("data-dc-click");
      const fn = handlers.get(id);
      if (typeof fn !== "function") return;
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        fn(ev);
      });
    });
  }

  async function hydrateImports(root, baseUrl) {
    const nodes = Array.from(root.querySelectorAll("[data-dc-import]"));
    await Promise.all(
      nodes.map(async (ph) => {
        const name = ph.getAttribute("data-dc-import");
        if (!name) return;
        const url = new URL(`${name}.dc.html`, baseUrl).href;
        const res = await fetch(url);
        if (!res.ok) {
          ph.textContent = `[dc-import missing: ${name}]`;
          return;
        }
        const html = await res.text();
        const parts = extractDcParts(parseDocument(html));
        const props = {};
        for (const attr of Array.from(ph.attributes)) {
          if (!attr.name.startsWith("data-prop-")) continue;
          props[attr.name.slice("data-prop-".length)] = attr.value;
        }
        try {
          const schema = JSON.parse(parts.propsJson || "{}");
          for (const [key, meta] of Object.entries(schema)) {
            if (key.startsWith("$")) continue;
            if (props[key] == null && meta && meta.default != null) props[key] = meta.default;
          }
        } catch {
          /* ignore malformed data-props */
        }
        const logic = instantiateComponent(parts.scriptText, props);
        const mount = document.createElement("div");
        mount.style.width = "100%";
        mount.style.height = "100%";
        ph.replaceChildren(mount);
        logic._bind(mount, parts.template);
        await hydrateImports(mount, url);
      }),
    );
  }

  function unwrapXdc(host) {
    // Custom element unknown to the browser stays inline; promote children so
    // layout matches the design canvas (no unknown-element box).
    if (host.tagName && host.tagName.toLowerCase() === "x-dc") {
      const parent = host.parentNode;
      if (!parent) return host;
      const wrap = document.createElement("div");
      wrap.setAttribute("data-dc-root", "");
      while (host.firstChild) wrap.appendChild(host.firstChild);
      parent.replaceChild(wrap, host);
      return wrap;
    }
    return host;
  }

  async function boot(doc) {
    const script = doc.querySelector('script[type="text/x-dc"]');
    let host = doc.querySelector("x-dc");
    if (!host) return;
    const template = host.innerHTML;
    let props = {};
    if (script) {
      try {
        const raw = JSON.parse(script.getAttribute("data-props") || "{}");
        for (const [key, meta] of Object.entries(raw)) {
          if (key.startsWith("$")) continue;
          if (meta && typeof meta === "object" && "default" in meta) props[key] = meta.default;
          else props[key] = meta;
        }
      } catch {
        props = {};
      }
    }
    const scriptText = script ? script.textContent || "" : "class Component extends DCLogic { renderVals(){ return {}; } }";
    const logic = instantiateComponent(scriptText, props);
    host = unwrapXdc(host);
    logic._bind(host, template);
    if (logic._importsReady) await logic._importsReady;
    doc.documentElement.setAttribute("data-dc-ready", "1");
    doc.dispatchEvent(new CustomEvent("dc-ready", { detail: { logic } }));
  }

  function start() {
    boot(document).catch((err) => {
      console.error("[dc support]", err);
      document.documentElement.setAttribute("data-dc-error", String(err && err.message ? err.message : err));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
