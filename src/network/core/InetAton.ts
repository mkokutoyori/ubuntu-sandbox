import { IPAddress } from './types';

export function inetAton(text: string): IPAddress | null {
  const parts = text.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) value = parseInt(part, 8);
    else if (/^[1-9]\d*$/.test(part)) value = parseInt(part, 10);
    else return null;
    values.push(value);
  }
  const last = values[values.length - 1];
  const leading = values.slice(0, -1);
  if (leading.some((v) => v > 255)) return null;
  const lastMax = 2 ** (8 * (4 - leading.length)) - 1;
  if (last > lastMax) return null;
  let address = 0;
  leading.forEach((v, i) => { address += v * 2 ** (8 * (3 - i)); });
  address += last;
  return new IPAddress([
    Math.floor(address / 2 ** 24) % 256, Math.floor(address / 2 ** 16) % 256,
    Math.floor(address / 2 ** 8) % 256, address % 256,
  ].join('.'));
}
