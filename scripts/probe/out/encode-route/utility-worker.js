
// NAO e require("electron").parentPort -- dentro de um utility process isso
// e undefined (o modulo 'electron' la dentro so expoe net e
// systemPreferences, medido ao vivo escrevendo esta sonda). A porta pro
// processo pai e process.parentPort (electron.d.ts:26736..26738,
// documentado em process, nao no modulo 'electron').
const parentPort = process.parentPort;
let nativeImage = null;
let nativeImageAvailable = false;
let nativeImageError = null;
try {
  nativeImage = require("electron").nativeImage;
  nativeImageAvailable = !!(nativeImage && typeof nativeImage.createFromBitmap === "function");
} catch (e) {
  nativeImageError = String((e && e.message) || e);
}
if (nativeImageAvailable) {
  try {
    const probe = nativeImage.createFromBitmap(Buffer.alloc(4 * 4 * 4, 200), { width: 4, height: 4 });
    probe.toJPEG(90);
  } catch (e) {
    nativeImageAvailable = false;
    nativeImageError = String((e && e.message) || e);
  }
}
parentPort.postMessage({ type: "ready", nativeImageAvailable, nativeImageError });
parentPort.on("message", (e) => {
  const { seq, buf, width, height } = e.data;
  let jpegBytes = null, encodeMs = null, error = null;
  if (nativeImageAvailable) {
    try {
      const t0 = performance.now();
      const img = nativeImage.createFromBitmap(buf, { width, height });
      const jpeg = img.toJPEG(90);
      encodeMs = performance.now() - t0;
      jpegBytes = jpeg.length;
    } catch (e) {
      error = String((e && e.message) || e);
    }
  }
  parentPort.postMessage({ type: "ack", seq, bytesReceived: buf.length, jpegBytes, encodeMs, error });
});
