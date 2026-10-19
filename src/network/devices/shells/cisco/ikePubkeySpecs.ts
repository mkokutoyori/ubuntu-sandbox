import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import type { IkeKeyUsage, IkePeerKey, IkePubkeyChain } from '../../router/security/IkePubkeyChain';
import { decodeRsaPublicKey, groupedHex } from '../../../ipsec/RsaPublicKeyDer';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export type IkePubkeyMode = 'config-pubkey-chain' | 'config-pubkey-key' | 'config-pubkey-data';

export interface IkePubkeyHost {
  chain(): IkePubkeyChain;
  selected(): IkePeerKey | null;
  select(key: IkePeerKey): void;
  enter(mode: IkePubkeyMode): void;
  beginKeyString(): void;
}

const USAGE: ArgumentSpec = {
  name: 'usage', type: 'ENUM', optional: true,
  values: [
    { keyword: 'encryption', description: 'Key used for encryption' },
    { keyword: 'signature', description: 'Key used for signatures' },
  ],
};

const NAME: ArgumentSpec = { name: 'name', type: 'WORD', description: 'Name of the peer key (its FQDN)' };
const ADDRESS: ArgumentSpec = { name: 'address', type: 'IP_ADDR', description: 'IP address of the peer' };
const INDEX: ArgumentSpec = { name: 'index', type: 'INT', optional: true, range: [1, 1000], description: 'Index of the key to remove' };

const KEY_MODES = ['config-pubkey-chain', 'config-pubkey-key'] as const;
const EXEC = ['user', 'privileged'] as const;

function usageOf(text: string | undefined): IkeKeyUsage {
  return text === 'encryption' || text === 'signature' ? text : 'general';
}

function usageLabel(usage: IkeKeyUsage): string {
  return usage === 'encryption' ? 'Encryption' : usage === 'signature' ? 'Signature' : 'General';
}

export function renderPubkeyChain(chain: IkePubkeyChain, filter: { address?: string; name?: string }): string {
  const keys = chain.list().filter((key) => key.spki !== null).filter((key) => {
    if (filter.address !== undefined) return key.kind === 'addressed' ? key.name === filter.address : key.address === filter.address;
    if (filter.name !== undefined) return key.kind === 'named' && key.name === filter.name;
    return true;
  });
  if (filter.address === undefined && filter.name === undefined) {
    if (keys.length === 0) return '';
    return [
      'Codes: M - Manually Configured, C - Extracted from certificate',
      '',
      `${padToWidth('Code', 5)}${padToWidth('Usage', 11)}${padToWidth('IP-address', 16)}${padToWidth('Keyring', 8)}Name`,
      ...keys.map((key) => `${padToWidth('M', 5)}${padToWidth(usageLabel(key.usage), 11)}${padToWidth(key.kind === 'addressed' ? key.name : key.address ?? '', 16)}${padToWidth('default', 8)}${key.kind === 'named' ? key.name : ''}`.trimEnd()),
    ].join('\n');
  }
  return keys.map((key) => [
    `Key name: ${key.kind === 'named' ? key.name : ''}`,
    `Key address: ${key.kind === 'addressed' ? key.name : key.address ?? ''}`,
    `Usage: ${usageLabel(key.usage)} ${key.usage === 'general' ? 'Purpose ' : ''}Key`,
    'Source: Manual',
    'Data:',
    ...groupedHex(key.spki!),
  ].join('\n')).join('\n\n');
}

export function ikePubkeySpecs(host: () => IkePubkeyHost): CommandSpec[] {
  const declare = (id: string, keyword: 'named-key' | 'addressed-key', first: ArgumentSpec): CommandSpec => ({
    id,
    path: [keyword, first, USAGE],
    description: keyword === 'named-key' ? 'Specify the name of the remote peer key' : 'Specify the address of the remote peer key',
    undoDescription: 'Remove the peer key',
    modes: KEY_MODES, minPrivilege: 15,
    run: (_session, args) => {
      const key = host().chain().ensure(keyword === 'named-key' ? 'named' : 'addressed', first.name === 'address' ? args.address : args.name, usageOf(args.usage));
      host().select(key);
      host().enter('config-pubkey-key');
      return '';
    },
    undo: (_session, args) => {
      host().chain().remove(keyword === 'named-key' ? 'named' : 'addressed', first.name === 'address' ? args.address : args.name, args.usage === undefined ? undefined : usageOf(args.usage));
      return '';
    },
  });
  return [
    {
      id: 'crypto-key-pubkey-chain-rsa',
      path: ['crypto', 'key', 'pubkey-chain', 'rsa'],
      description: 'Enter the public keys of the IKE peers',
      undoDescription: 'Remove every configured peer public key',
      modes: ['config'], minPrivilege: 15,
      run: () => { host().enter('config-pubkey-chain'); return ''; },
      undo: () => { host().chain().clear(); return ''; },
    },
    declare('pubkey-chain-named-key', 'named-key', NAME),
    declare('pubkey-chain-addressed-key', 'addressed-key', ADDRESS),
    {
      id: 'pubkey-key-address',
      path: ['address', ADDRESS],
      description: 'Address of the peer owning the named key',
      modes: ['config-pubkey-key'], minPrivilege: 15,
      run: (_session, args) => {
        const key = host().selected();
        if (!key || key.kind !== 'named') throw new CliInvalidInput({ token: 'address' });
        key.address = args.address;
        return '';
      },
    },
    {
      id: 'pubkey-key-key-string',
      path: ['key-string'],
      description: 'Enter the public key as hexadecimal text, ended by quit',
      modes: ['config-pubkey-key'], minPrivilege: 15,
      run: () => { host().beginKeyString(); return ''; },
    },
    {
      id: 'crypto-key-zeroize-pubkey-chain',
      path: ['crypto', 'key', 'zeroize', 'pubkey-chain', INDEX],
      description: 'Delete the peer public keys',
      modes: ['config'], minPrivilege: 15,
      run: (_session, args) => {
        if (args.index === undefined) { host().chain().clear(); return ''; }
        if (!host().chain().removeAt(Number(args.index))) throw new CliInvalidInput({ token: args.index });
        return '';
      },
    },
    {
      id: 'show-crypto-key-pubkey-chain-rsa',
      path: ['show', 'crypto', 'key', 'pubkey-chain', 'rsa'],
      description: 'Show the public keys of the IKE peers',
      modes: EXEC, minPrivilege: 1,
      options: [
        { keyword: 'address', description: 'Address of a specific key to view', argument: { name: 'address', type: 'IP_ADDR', description: 'Key address' } },
        { keyword: 'name', description: 'Name of a specific key to view', argument: { name: 'name', type: 'WORD', description: 'Key name' } },
      ],
      run: (_session, args) => renderPubkeyChain(host().chain(), { address: args.address, name: args.name }),
    },
  ];
}

export function storeKeyString(key: IkePeerKey, lines: readonly string[]): boolean {
  const hex = lines.join('').replace(/\s+/g, '');
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return false;
  const bytes = Uint8Array.from(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
  if (decodeRsaPublicKey(bytes) === null) return false;
  key.spki = bytes;
  return true;
}
