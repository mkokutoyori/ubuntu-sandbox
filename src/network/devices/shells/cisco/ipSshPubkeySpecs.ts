import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { parseKeyHash, type SshPubkeyChain } from '../../router/security/SshPubkeyChain';

export type PubkeyChainMode =
  | 'config-ssh-pubkey' | 'config-ssh-pubkey-user' | 'config-ssh-pubkey-server' | 'config-ssh-pubkey-data';

export type PubkeyOwnerKind = 'user' | 'server';

export interface PubkeyChainHost {
  chain(): SshPubkeyChain;
  target(): { kind: PubkeyOwnerKind; name: string } | null;
  select(kind: PubkeyOwnerKind, name: string): void;
  enter(mode: PubkeyChainMode): void;
  beginKeyString(): void;
}

const USER: ArgumentSpec = { name: 'user', type: 'WORD', description: 'Username' };
const SERVER: ArgumentSpec = { name: 'server', type: 'WORD', description: 'Name or address of the SSH server' };
const KEY_TYPE: ArgumentSpec = {
  name: 'type', type: 'ENUM', description: 'Key type',
  values: [{ keyword: 'ssh-rsa', description: 'RSA public key' }],
};
const HASH: ArgumentSpec = { name: 'hash', type: 'WORD', description: 'MD5 hash of the public key' };
const COMMENT: ArgumentSpec = { name: 'comment', type: 'REST', description: 'Key comment', optional: true };

export function ipSshPubkeySpecs(host: () => PubkeyChainHost): CommandSpec[] {
  return [
    {
      id: 'config-ip-ssh-pubkey-chain',
      path: ['ip', 'ssh', 'pubkey-chain'],
      description: 'Configure SSH public keys of the users allowed to log in',
      undoDescription: 'Remove every configured SSH public key',
      modes: ['config'], minPrivilege: 15,
      run: () => { host().enter('config-ssh-pubkey'); return ''; },
      undo: () => { host().chain().clear(); return ''; },
    },
    {
      id: 'config-ssh-pubkey-username',
      path: ['username', USER],
      description: 'Username that owns the public keys',
      undoDescription: 'Remove the user and its public keys',
      modes: ['config-ssh-pubkey', 'config-ssh-pubkey-user'], minPrivilege: 15,
      run: (_session, args) => {
        host().chain().ensureUser(args.user);
        host().select('user', args.user);
        host().enter('config-ssh-pubkey-user');
        return '';
      },
      undo: (_session, args) => { host().chain().removeUser(args.user); return ''; },
    },
    {
      id: 'config-ssh-pubkey-key-string',
      path: ['key-string'],
      description: 'Enter the public key text, ended by exit',
      modes: ['config-ssh-pubkey-user', 'config-ssh-pubkey-server'], minPrivilege: 15,
      run: () => { host().beginKeyString(); return ''; },
    },
    {
      id: 'config-ssh-pubkey-server',
      path: ['server', SERVER],
      description: 'Name or address of an SSH server whose host key is trusted',
      undoDescription: 'Remove the server and its public keys',
      modes: ['config-ssh-pubkey', 'config-ssh-pubkey-user', 'config-ssh-pubkey-server'], minPrivilege: 15,
      run: (_session, args) => {
        host().chain().ensureServer(args.server);
        host().select('server', args.server);
        host().enter('config-ssh-pubkey-server');
        return '';
      },
      undo: (_session, args) => { host().chain().removeServer(args.server); return ''; },
    },
    {
      id: 'config-ssh-pubkey-key-hash',
      path: ['key-hash', KEY_TYPE, HASH, COMMENT],
      description: 'Specify the hash of the public key',
      undoDescription: 'Remove the public key with this hash',
      modes: ['config-ssh-pubkey-user', 'config-ssh-pubkey-server'], minPrivilege: 15,
      run: (_session, args) => {
        const target = host().target();
        const entry = parseKeyHash([args.type, args.hash, ...(args.comment ? [args.comment] : [])]);
        if (target === null || entry === null) return '% Invalid key hash';
        if (target.kind === 'user') host().chain().add(target.name, entry);
        else host().chain().addServerKey(target.name, entry);
        return '';
      },
      undo: (_session, args) => {
        const target = host().target();
        if (target === null) return '';
        if (target.kind === 'user') host().chain().removeHash(target.name, args.hash);
        else host().chain().removeServerHash(target.name, args.hash);
        return '';
      },
    },
  ];
}
