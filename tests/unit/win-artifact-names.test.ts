import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * OS DOIS .EXE DO WINDOWS NÃO PODEM TER O MESMO NOME (task d0fef4e7, item 0).
 *
 * O QUE ACONTECEU, medido: `build.win.target` = ["nsis", "portable"] e os dois
 * usavam o MESMO `artifactName` (`${productName}-${version}-${arch}.${ext}`) —
 * como os dois alvos geram `.exe`, os dois viravam `Stellar-<v>-x64.exe`. O
 * segundo build SOBRESCREVE o arquivo do primeiro, e o `latest.yml` (escrito
 * pelo build do NSIS, com o size/sha512 DAQUELE artefato) acaba apontando para
 * um arquivo que virou OUTRO artefato — o `electron-updater` recusa o download
 * pelo sha512. Foi exatamente o que o dono mediu na v0.8.3: o yml declara
 * 143380923 bytes / sha512 `ASowfOVF…`, e o `.exe` publicado tem 143139115
 * bytes / `MIocOHq/…`.
 *
 * A REGRA de resolução do nome é a da própria lib (lida no fonte instalado,
 * `node_modules/app-builder-lib/out/platformPackager.js:552`):
 *   opções ESPECÍFICAS do alvo  ||  opções da PLATAFORMA  ||  opções globais
 * e é ela que este teste aplica à config REAL do repositório — sem Windows, sem
 * build, sem adivinhação.
 */

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  name: string;
  version: string;
  build: {
    productName?: string;
    artifactName?: string;
    win?: { artifactName?: string };
    portable?: { artifactName?: string };
    nsis?: { artifactName?: string };
  };
};

/**
 * O `${productName}` da lib sai de `config.productName || metadata.productName ||
 * metadata.name` (`node_modules/app-builder-lib/out/appInfo.js:54`) — nesta casa
 * ele está em `build.productName` ("Stellar"), e não na raiz do package.json.
 */
const PRODUCT_NAME = pkg.build.productName ?? pkg.name;

/** A resolução da lib: alvo -> plataforma -> global. */
function resolveName(target: "nsis" | "portable", ext: string, arch: string): string {
  const targetOptions = pkg.build[target] as { artifactName?: string } | undefined;
  const pattern =
    targetOptions?.artifactName ?? pkg.build.win?.artifactName ?? pkg.build.artifactName ?? "";
  return pattern
    .replace(/\$\{productName\}/g, PRODUCT_NAME)
    .replace(/\$\{version\}/g, pkg.version)
    .replace(/\$\{arch\}/g, arch)
    .replace(/\$\{ext\}/g, ext);
}

describe("nomes dos artefatos do Windows (nsis x portable)", () => {
  it("os dois alvos .exe resolvem para nomes DIFERENTES (senão um sobrescreve o outro)", () => {
    const nsis = resolveName("nsis", "exe", "x64");
    const portable = resolveName("portable", "exe", "x64");
    expect(nsis).toMatch(/\.exe$/);
    expect(portable).toMatch(/\.exe$/);
    expect(portable).not.toBe(nsis);
  });

  it("o nome do NSIS continua o de hoje (o `latest.yml` publicado aponta para ele)", () => {
    expect(resolveName("nsis", "exe", "x64")).toBe(`${PRODUCT_NAME}-${pkg.version}-x64.exe`);
  });

  it("e o portable se identifica como portable no próprio nome", () => {
    expect(resolveName("portable", "exe", "x64")).toBe(`${PRODUCT_NAME}-${pkg.version}-x64-portable.exe`);
  });
});
