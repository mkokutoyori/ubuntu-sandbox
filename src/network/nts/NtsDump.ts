import type { NtsClient } from './NtsClient';
import { aeadKeyLength } from './NtsKeRecords';

export const COOKIE_DUMP_IDENTIFIER = 'NNC0';

const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const fromHex = (text: string): Uint8Array | null => (/^([0-9a-fA-F]{2})+$/.test(text)
  ? Uint8Array.from(text.match(/../g)!, (h) => parseInt(h, 16)) : null);

export interface CookieDumpTarget {
  readonly name: string;
  readonly ntpAddress: string;
  readonly ntpPort: number;
}

export function dumpCookies(client: NtsClient, target: CookieDumpTarget, epochMs: number, nowMs: number): string | null {
  const snapshot = client.snapshot();
  if (snapshot === null) return null;
  const contextTime = (epochMs - (nowMs - snapshot.lastKeSuccessMs)) / 1000;
  const lines = [
    COOKIE_DUMP_IDENTIFIER, target.name, contextTime.toFixed(1), `${target.ntpAddress} ${target.ntpPort}`,
    `${snapshot.contextId} ${snapshot.context.aead} ${toHex(snapshot.context.s2c)} ${toHex(snapshot.context.c2s)}`,
    ...snapshot.cookies.map(toHex),
  ];
  return `${lines.join('\n')}\n`;
}

export interface RestoredCookies {
  readonly ntpAddress: string;
  readonly ntpPort: number;
}

export function restoreCookies(client: NtsClient, name: string, text: string, epochMs: number, nowMs: number): RestoredCookies | null {
  const lines = text.split('\n');
  if (lines[0] !== COOKIE_DUMP_IDENTIFIER || lines[1] !== name || !/^-?\d+(\.\d+)?$/.test(lines[2] ?? '')) return null;
  const address = (lines[3] ?? '').split(/\s+/);
  const head = (lines[4] ?? '').split(/\s+/);
  if (address.length !== 2 || head.length !== 4) return null;
  const aead = Number(head[1]);
  const s2c = fromHex(head[2]);
  const c2s = fromHex(head[3]);
  if (s2c === null || c2s === null || s2c.length !== aeadKeyLength(aead) || c2s.length !== s2c.length) return null;
  const cookies: Uint8Array[] = [];
  for (let i = 5; i < lines.length && cookies.length < 8; i++) {
    if (lines[i] === '') continue;
    const cookie = fromHex(lines[i]);
    if (cookie === null) return null;
    cookies.push(cookie);
  }
  const contextMs = Math.min(Number(lines[2]) * 1000, epochMs);
  client.restore({ aead, c2s, s2c }, Number(head[0]), cookies, nowMs - (epochMs - contextMs));
  return { ntpAddress: address[0], ntpPort: Number(address[1]) };
}
