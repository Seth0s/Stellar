/**
 * DESIGN-BACKLOG.md item 57.8 — "Exportação do Canvas com Seleção de
 * Área", formato PDF. Um raster (o recorte capturado via
 * `webContents.capturePage`) dentro de UMA página PDF é um caso simples o
 * bastante pra não justificar puxar uma lib inteira (jsPDF/pdf-lib) só
 * pra isso — PDF aceita JPEG embutido DIRETO como um XObject
 * `/Filter /DCTDecode`, sem re-comprimir nada. O arquivo inteiro é só:
 * catálogo → páginas → página (MediaBox = dimensão real do recorte) →
 * XObject de imagem → stream de conteúdo desenhando a imagem esticada
 * pro tamanho da página inteira.
 *
 * Verificado de verdade (não só "parece certo"): `pdftoppm`/`pdfinfo`
 * (poppler-utils, já instalado nesta máquina) conseguem abrir e
 * rasterizar de volta um PDF gerado por esta função — ver
 * scripts/verify/smoke-canvas-export.mjs.
 */
export function wrapJpegAsPdf(jpeg: Buffer, width: number, height: number): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let pos = 0;

  function push(buf: Buffer) {
    offsets.push(pos);
    parts.push(buf);
    pos += buf.length;
  }

  const header = Buffer.from("%PDF-1.4\n");
  parts.push(header);
  pos += header.length;

  push(Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
  push(Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"));
  push(
    Buffer.from(
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
    ),
  );

  const imgHeader = Buffer.from(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  const imgFooter = Buffer.from("\nendstream\nendobj\n");
  push(Buffer.concat([imgHeader, jpeg, imgFooter]));

  const content = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`);
  push(
    Buffer.concat([
      Buffer.from(`5 0 obj\n<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
  );

  const xrefStart = pos;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  parts.push(Buffer.from(xref + trailer));

  return Buffer.concat(parts);
}
