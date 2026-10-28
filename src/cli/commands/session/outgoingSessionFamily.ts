import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';

export interface OutgoingSessionHost {
  list(): string;
  disconnect(words: readonly string[]): string;
  resume(words: readonly string[]): string;
  ssh(words: readonly string[]): string;
  telnet(words: readonly string[]): string;
}

const CONNECTION: ArgumentSpec = {
  name: 'connection', type: 'REST', optional: true,
  description: 'Connection number or name',
  alternatives: [
    { keyword: '<1-16>', description: 'Connection number' },
    { keyword: 'WORD', description: 'Connection name' },
  ],
};

const REMOTE_HOST: ArgumentSpec = {
  name: 'host', type: 'REST', literal: 'WORD',
  description: 'IP address or hostname of a remote system',
};

const words = (value: string | undefined): string[] =>
  (value ?? '').trim().split(/\s+/).filter(Boolean);

export function outgoingSessionFamily(host: () => OutgoingSessionHost): CommandSpec[] {
  const base = { modes: ['user', 'privileged'], minPrivilege: 1 };
  return [
    {
      ...base, id: 'where', path: ['where'],
      description: 'List open outgoing connections', run: () => host().list(),
    },
    {
      ...base, id: 'disconnect', path: ['disconnect', CONNECTION],
      description: 'Close an outgoing connection',
      run: (_session, args) => host().disconnect(words(args.connection)),
    },
    {
      ...base, id: 'resume', path: ['resume', CONNECTION],
      description: 'Resume an outgoing connection',
      run: (_session, args) => host().resume(words(args.connection)),
    },
    {
      ...base, id: 'ssh', path: ['ssh', REMOTE_HOST],
      description: 'Open an SSH connection to a remote host',
      run: (_session, args) => host().ssh(words(args.host)),
    },
    {
      ...base, id: 'telnet', path: ['telnet', REMOTE_HOST],
      description: 'Open a Telnet session',
      run: (_session, args) => host().telnet(words(args.host)),
    },
  ];
}
