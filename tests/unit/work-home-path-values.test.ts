/**
 * work-home-path-values.ts — reescrita de caminhos DENTRO do conteúdo (adendo
 * A3b). Puro.
 */
import { describe, expect, it } from "vitest";
import {
  expandPathValue,
  expandPathValuesInText,
  projectRefsInText,
  templatePathValue,
  templatePathValuesInText,
  type PathValueContext,
} from "../../src/main/work-home-path-values";
import type { ProjectClone } from "../../src/main/work-home-remap";

const clone: ProjectClone = {
  root: "/home/u/mono",
  remote: "git@github.com:o/mono.git",
  normalizedRemote: "github.com/o/mono",
};
const ctx: PathValueContext = { homeDir: "/home/u", projectClones: [clone] };

describe("templatePathValue", () => {
  it("caminho sob a home vira {home}/rel", () => {
    expect(templatePathValue("/home/u/docs/x.md", ctx)).toBe("{home}/docs/x.md");
    expect(templatePathValue("/home/u", ctx)).toBe("{home}");
  });

  it("raiz do clone vira {project:<remote>} e caminho dentro leva a subpasta", () => {
    expect(templatePathValue("/home/u/mono", ctx)).toBe("{project:github.com/o/mono}");
    expect(templatePathValue("/home/u/mono/packages/app", ctx)).toBe("{project:github.com/o/mono/packages/app}");
  });

  it("não-caminho e caminho de fora ficam iguais", () => {
    expect(templatePathValue("opus", ctx)).toBe("opus");
    expect(templatePathValue("/etc/hosts", ctx)).toBe("/etc/hosts");
  });
});

describe("expandPathValue", () => {
  it("volta {home} e {project} para o caminho local", () => {
    expect(expandPathValue("{home}/docs/x.md", ctx)).toEqual({ ok: true, value: "/home/u/docs/x.md" });
    expect(expandPathValue("{project:github.com/o/mono/packages/app}", ctx)).toEqual({
      ok: true,
      value: "/home/u/mono/packages/app",
    });
  });

  it("projeto sem clone → não resolvido (pendente)", () => {
    expect(expandPathValue("{project:github.com/o/absent}/x", ctx)).toEqual({
      ok: false,
      projectId: "github.com/o/absent",
    });
  });
});

describe("templatePathValuesInText — JSON/TOML, só entre aspas", () => {
  it("reescreve o header [projects.\"...\"] do config.toml", () => {
    const toml = `[projects."/home/u/mono"]\ntrust_level = "trusted"\n[projects."/home/u/outro"]\nx = 1\nprosa = "veja /home/u/mono no editor"\n`;
    const out = templatePathValuesInText(toml, ctx);
    expect(out).toContain('[projects."{project:github.com/o/mono}"]');
    expect(out).toContain('[projects."{home}/outro"]');
    // prosa SEM aspas de caminho não é tocada (o texto entre aspas é, veja o
    // comentário do módulo: é valor de string). Aqui a prosa está entre aspas,
    // então É tratada como valor — o que importa é que a chave muda, não prosa.
  });

  it("JSON: string de valor reescrita", () => {
    expect(templatePathValuesInText('{"cwd": "/home/u/mono/packages/app"}', ctx)).toBe(
      '{"cwd": "{project:github.com/o/mono/packages/app}"}',
    );
  });
});

describe("expandPathValuesInText", () => {
  it("round-trip e detecção de pendente", () => {
    const templated = '{"cwd": "{home}/x", "proj": "{project:github.com/o/mono/packages/app}"}';
    const res = expandPathValuesInText(templated, ctx);
    expect(res.unresolved).toEqual([]);
    expect(JSON.parse(res.text)).toEqual({ cwd: "/home/u/x", proj: "/home/u/mono/packages/app" });

    const missing = expandPathValuesInText('{"p": "{project:github.com/o/absent}/y"}', ctx);
    expect(missing.unresolved).toEqual(["github.com/o/absent"]);
    expect(missing.text).toContain("{project:github.com/o/absent}");
  });
});

describe("projectRefsInText", () => {
  it("lista ids únicos", () => {
    expect(projectRefsInText('a {project:x/y} b {project:x/y} c {project:z}')).toEqual(["x/y", "z"]);
    expect(projectRefsInText("nada")).toEqual([]);
  });
});
