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
