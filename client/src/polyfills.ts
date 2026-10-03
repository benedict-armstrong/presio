const MapProto = Map.prototype as Map<unknown, unknown> & {
  getOrInsertComputed?: (key: unknown, cb: (key: unknown) => unknown) => unknown;
};
if (!MapProto.getOrInsertComputed) {
  MapProto.getOrInsertComputed = function (this: Map<unknown, unknown>, key, cb) {
    if (this.has(key)) return this.get(key);
    const value = cb(key);
    this.set(key, value);
    return value;
  };
}

// pdf.js 6 calls Uint8Array.prototype.toHex() to fingerprint documents; older
// Android WebViews/Chromium lack it. Also loaded by the pdf.js worker.
const U8Proto = Uint8Array.prototype as Uint8Array & { toHex?: () => string };
if (typeof U8Proto.toHex !== "function") {
  U8Proto.toHex = function (this: Uint8Array) {
    return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
  };
}
