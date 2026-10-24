const POLYNOMIAL = 0x82f63b78;

const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? (value >>> 1) ^ POLYNOMIAL : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32c(bytes: string): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) crc = TABLE[(crc ^ bytes.charCodeAt(index)) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}
