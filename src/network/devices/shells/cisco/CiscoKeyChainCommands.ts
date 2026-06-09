import type { Router } from '../../Router';
import type { CommandTrie } from '../CommandTrie';
import type { KeyChainRepository } from '../../inspection/config/KeyChainRepository';
import type { CiscoShellMode } from './CiscoConfigCommands';

export interface KeyChainShellContext {
  r(): Router;
  setMode(m: CiscoShellMode): void;
  getSelectedKeyChain(): string | null;
  setSelectedKeyChain(n: string | null): void;
  getSelectedKeyChainKey(): number | null;
  setSelectedKeyChainKey(n: number | null): void;
  getKeyChains(): KeyChainRepository;
}

export function registerKeyChainGlobalCommands(
  configTrie: CommandTrie,
  ctx: KeyChainShellContext,
): void {
  configTrie.registerGreedy('key chain', 'Define a key chain', (args) => {
    if (!args[0]) return '% Incomplete command.';
    ctx.getKeyChains().ensureChain(args[0]);
    ctx.setSelectedKeyChain(args[0]);
    ctx.setMode('config-keychain' as CiscoShellMode);
    return '';
  });
  configTrie.registerGreedy('no key chain', 'Remove a key chain', (args) => {
    if (args[0]) ctx.getKeyChains().removeChain(args[0]);
    return '';
  });
}

export function buildKeyChainSubmode(
  trie: CommandTrie,
  ctx: KeyChainShellContext,
): void {
  trie.registerGreedy('key', 'Define a key in this chain', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (isNaN(n)) return '% Incomplete command.';
    const chain = ctx.getSelectedKeyChain();
    if (!chain) return '% No key chain selected.';
    ctx.getKeyChains().ensureKey(chain, n);
    ctx.setSelectedKeyChainKey(n);
    ctx.setMode('config-keychain-key' as CiscoShellMode);
    return '';
  });
  trie.registerGreedy('description', 'Key chain description', (args) => {
    const chain = ctx.getSelectedKeyChain();
    if (!chain) return '';
    ctx.getKeyChains().ensureChain(chain).description = args.join(' ');
    return '';
  });
  trie.registerGreedy('no key', 'Remove a key from this chain', (args) => {
    const chain = ctx.getSelectedKeyChain();
    if (!chain) return '';
    const n = parseInt(args[0] ?? '', 10);
    if (!isNaN(n)) ctx.getKeyChains().ensureChain(chain).keys.delete(n);
    return '';
  });
}

export function buildKeyChainKeySubmode(
  trie: CommandTrie,
  ctx: KeyChainShellContext,
): void {
  const currentKey = () => {
    const chain = ctx.getSelectedKeyChain();
    const id = ctx.getSelectedKeyChainKey();
    if (!chain || id === null) return null;
    return ctx.getKeyChains().ensureKey(chain, id);
  };
  trie.registerGreedy('key-string', 'Set key string', (args) => {
    const k = currentKey(); if (!k) return '';
    let hidden: 0 | 6 | 7 | undefined;
    let i = 0;
    if (args[0] === '0' || args[0] === '6' || args[0] === '7') {
      hidden = parseInt(args[0], 10) as 0 | 6 | 7;
      i = 1;
    }
    k.keyString = args.slice(i).join(' ');
    if (hidden !== undefined) k.keyStringHidden = hidden;
    return '';
  });
  trie.registerGreedy('cryptographic-algorithm', 'Set cryptographic algorithm', (args) => {
    const k = currentKey(); if (!k) return '';
    if (args[0]) k.cryptoAlgorithm = args.join(' ');
    return '';
  });
  trie.registerGreedy('accept-lifetime', 'Accept-lifetime spec', (args) => {
    const k = currentKey(); if (!k) return '';
    const idx = args.findIndex((t) => t.toLowerCase() === 'infinite' || /^\d{2}:\d{2}:\d{2}$/.test(t) && args.indexOf(t) > 2);
    const split = idx > 0 ? idx : Math.ceil(args.length / 2);
    const start = args.slice(0, split).join(' ');
    const end = args.slice(split).join(' ') || 'infinite';
    k.acceptLifetime = { start, end };
    return '';
  });
  trie.registerGreedy('send-lifetime', 'Send-lifetime spec', (args) => {
    const k = currentKey(); if (!k) return '';
    const idx = args.findIndex((t) => t.toLowerCase() === 'infinite' || /^\d{2}:\d{2}:\d{2}$/.test(t) && args.indexOf(t) > 2);
    const split = idx > 0 ? idx : Math.ceil(args.length / 2);
    const start = args.slice(0, split).join(' ');
    const end = args.slice(split).join(' ') || 'infinite';
    k.sendLifetime = { start, end };
    return '';
  });
  trie.registerGreedy('send-id', 'Send identifier', (args) => {
    const k = currentKey(); if (!k) return '';
    const n = parseInt(args[0] ?? '', 10);
    if (!isNaN(n)) k.sendId = n;
    return '';
  });
  trie.registerGreedy('recv-id', 'Receive identifier', (args) => {
    const k = currentKey(); if (!k) return '';
    const n = parseInt(args[0] ?? '', 10);
    if (!isNaN(n)) k.recvId = n;
    return '';
  });
}

export function registerKeyChainShowCommands(
  trie: CommandTrie,
  ctx: { getKeyChains(): KeyChainRepository },
): void {
  trie.registerGreedy('show key chain', 'Display key chain', (args) => {
    const repo = ctx.getKeyChains();
    const name = args[0];
    const list = name ? [repo.getChain(name)].filter(Boolean) : repo.list();
    if (list.length === 0) return name ? '% Key chain not found' : 'No key chains configured.';
    const lines: string[] = [];
    for (const c of list as Array<NonNullable<ReturnType<typeof repo.getChain>>>) {
      lines.push(`Key-chain ${c.name}:`);
      if (c.description) lines.push(`    description: ${c.description}`);
      for (const k of [...c.keys.values()].sort((a, b) => a.id - b.id)) {
        lines.push(`    key ${k.id} -- text "${k.keyString ?? ''}"`);
        if (k.cryptoAlgorithm) lines.push(`        cryptographic-algorithm ${k.cryptoAlgorithm}`);
        if (k.acceptLifetime) lines.push(`        accept lifetime ${k.acceptLifetime.start} - ${k.acceptLifetime.end}`);
        if (k.sendLifetime) lines.push(`        send lifetime ${k.sendLifetime.start} - ${k.sendLifetime.end}`);
      }
    }
    return lines.join('\n');
  });
}
