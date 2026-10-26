import type { Router } from '@/network/devices/Router';
import type { NATEngine } from '@/network/devices/router/NATEngine';

export interface NatPortView {
  readonly address: string | undefined;
  readonly up: boolean;
}

export interface NatHost {
  router(): Router;
  engine(): NATEngine;
  selectedInterface(): string | null;
  resolveInterface(name: string): string | null;
  resolveHostName(name: string): string;
  portOf(name: string): NatPortView | undefined;
  vrfExists(name: string): boolean;
  vrfInterfaces(name: string): ReadonlySet<string> | undefined;
}

export const words = (value: string | undefined): string[] =>
  (value ?? '').split(/\s+/).filter(Boolean);

export const unquoted = (token: string): string => token.replace(/^["']|["']$/g, '');

export function hasUnmatchedQuote(tokens: readonly string[]): boolean {
  const joined = tokens.join(' ');
  const doubles = (joined.match(/"/g) ?? []).length;
  const singles = (joined.match(/'/g) ?? []).length;
  return doubles % 2 !== 0 || singles % 2 !== 0;
}

export function vrfNamed(tokens: readonly string[]): string | undefined {
  const at = tokens.findIndex(token => token.toLowerCase() === 'vrf');
  return at >= 0 && at + 1 < tokens.length ? tokens[at + 1] : undefined;
}
