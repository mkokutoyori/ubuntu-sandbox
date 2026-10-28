import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';
import { SUMMER_TIME_YEAR_RANGE } from '../../../network/devices/shells/cisco/clockSummerTime';
import { clockTime, monthOrDay } from '../clock/clockPlaces';
import type { KeyChainRepository } from '../../../network/devices/inspection/config/KeyChainRepository';

export type KeyChainKey = ReturnType<KeyChainRepository['ensureKey']>;

export interface KeyChainHost {
  chains(): KeyChainRepository;
  selectedChain(): string | null;
  selectChain(name: string): void;
  selectedKey(): KeyChainKey | null;
  selectKey(id: number): void;
}

const NAME: ArgumentSpec = { name: 'name', type: 'WORD', description: 'Name of the key chain' };
const OPTIONAL_NAME: ArgumentSpec = { ...NAME, optional: true };

const KEY_ID: ArgumentSpec = {
  name: 'id', type: 'INT', range: [0, 2147483647], description: 'Key identifier',
};

const ALGORITHM: ArgumentSpec = {
  name: 'algorithm', type: 'ENUM', description: 'Algorithm the key is used with',
  values: [
    { keyword: 'md5', description: 'Message Digest 5' },
    { keyword: 'hmac-sha-1', description: 'HMAC-SHA-1' },
    { keyword: 'hmac-sha-256', description: 'HMAC-SHA-256' },
    { keyword: 'hmac-sha-384', description: 'HMAC-SHA-384' },
    { keyword: 'hmac-sha-512', description: 'HMAC-SHA-512' },
  ],
};

const SECRET: ArgumentSpec = {
  name: 'text', type: 'REST', literal: 'LINE',
  description: 'The key itself, optionally preceded by 0, 6 or 7',
};

const DURATION: ArgumentSpec = {
  name: 'seconds', type: 'INT', range: [1, 2147483646], description: 'Duration in seconds',
};

const YEAR: ArgumentSpec = {
  name: 'year', type: 'INT', range: [...SUMMER_TIME_YEAR_RANGE], description: 'Year',
};

function instant(side: 'start' | 'end'): ArgumentSpec[] {
  return [
    clockTime(`${side}-time`,
      side === 'start' ? 'Start time and date (hh:mm:ss)' : 'End time (hh:mm:ss)', true),
    monthOrDay(`${side}-first`, 'Day of the month or month'),
    monthOrDay(`${side}-second`, 'Month or day of the month'),
    { ...YEAR, name: `${side}-year` },
  ];
}

const instantText = (side: string, args: Record<string, string>): string =>
  [`${side}-time`, `${side}-first`, `${side}-second`, `${side}-year`]
    .map((key) => args[key]).join(' ');

function renderChains(repo: KeyChainRepository, name: string | undefined): string {
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
}

export function keyChainFamily(
  host: () => KeyChainHost, enter: (mode: 'config-keychain' | 'config-keychain-key') => void,
): CommandSpec[] {
  const config = { modes: ['config'], minPrivilege: 15 };
  const chain = { modes: ['config-keychain'], minPrivilege: 15 };
  const key = { modes: ['config-keychain-key'], minPrivilege: 15 };
  const withKey = (apply: (k: KeyChainKey) => void): string => {
    const current = host().selectedKey();
    if (current) apply(current);
    return '';
  };

  const lifetime = (
    keyword: 'accept-lifetime' | 'send-lifetime', field: 'acceptLifetime' | 'sendLifetime',
  ): CommandSpec[] => {
    const set = (end: (args: Record<string, string>) => string) =>
      (_session: unknown, args: Record<string, string>): string => withKey((k) => {
        k[field] = { start: instantText('start', args), end: end(args) };
      });
    const id = keyword;
    return [
      {
        ...key, id: `${id}-infinite`, path: [keyword, ...instant('start'), 'infinite'],
        description: `Set ${keyword} with no end`, run: set(() => 'infinite'),
      },
      {
        ...key, id: `${id}-duration`, path: [keyword, ...instant('start'), 'duration', DURATION],
        description: `Set ${keyword} for a duration`,
        run: set((args) => `duration ${args.seconds}`),
      },
      {
        ...key, id: `${id}-end`, path: [keyword, ...instant('start'), ...instant('end')],
        description: `Set ${keyword} to an end time`,
        run: set((args) => instantText('end', args)),
      },
    ];
  };

  const counter = (
    keyword: 'send-id' | 'recv-id', field: 'sendId' | 'recvId', description: string,
  ): CommandSpec => ({
    ...key, id: keyword,
    path: [keyword, { name: 'id', type: 'INT', range: [0, 255], description }],
    description,
    run: (_session, args) => withKey((k) => { k[field] = Number(args.id); }),
  });

  return [
    {
      ...config, id: 'key-chain', path: ['key', 'chain', NAME],
      description: 'Define a key chain', undoDescription: 'Remove a key chain',
      run: (_session, args) => {
        host().chains().ensureChain(args.name);
        host().selectChain(args.name);
        enter('config-keychain');
        return '';
      },
      undo: (_session, args) => { host().chains().removeChain(args.name); return ''; },
    },
    {
      ...chain, id: 'key-chain-key', path: ['key', KEY_ID],
      description: 'Define a key in this chain', undoDescription: 'Remove a key from this chain',
      run: (_session, args) => {
        const name = host().selectedChain();
        if (!name) return '% No key chain selected.';
        host().chains().ensureKey(name, Number(args.id));
        host().selectKey(Number(args.id));
        enter('config-keychain-key');
        return '';
      },
      undo: (_session, args) => {
        const name = host().selectedChain();
        if (name) host().chains().ensureChain(name).keys.delete(Number(args.id));
        return '';
      },
    },
    {
      ...chain, id: 'key-chain-description',
      path: ['description', { name: 'text', type: 'REST', literal: 'LINE', description: 'Description of this key chain' }],
      description: 'Key chain description',
      run: (_session, args) => {
        const name = host().selectedChain();
        if (name) host().chains().ensureChain(name).description = args.text;
        return '';
      },
    },
    {
      ...key, id: 'key-string', path: ['key-string', SECRET], description: 'Set key string',
      run: (_session, args) => withKey((k) => {
        const words = args.text.trim().split(/\s+/);
        const hidden = words[0] === '0' || words[0] === '6' || words[0] === '7'
          ? parseInt(words[0], 10) as 0 | 6 | 7 : undefined;
        k.keyString = words.slice(hidden === undefined ? 0 : 1).join(' ');
        if (hidden !== undefined) k.keyStringHidden = hidden;
      }),
    },
    {
      ...key, id: 'cryptographic-algorithm', path: ['cryptographic-algorithm', ALGORITHM],
      description: 'Set cryptographic algorithm',
      run: (_session, args) => withKey((k) => { k.cryptoAlgorithm = args.algorithm; }),
    },
    ...lifetime('accept-lifetime', 'acceptLifetime'),
    ...lifetime('send-lifetime', 'sendLifetime'),
    counter('send-id', 'sendId', 'Send identifier'),
    counter('recv-id', 'recvId', 'Receive identifier'),
    {
      id: 'show-key-chain', path: ['show', 'key', 'chain', OPTIONAL_NAME],
      description: 'Display key chain', modes: ['user', 'privileged'], minPrivilege: 1,
      run: (_session, args) => renderChains(host().chains(), args.name),
    },
  ];
}
