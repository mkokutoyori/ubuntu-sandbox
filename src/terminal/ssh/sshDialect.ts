import type { TcpWireOutcome } from '@/network/tcp/types';

export interface SshDialect {
  unresolved(host: string, port: number): string;
  refused(host: string, port: number): string;
  timedOut(host: string, port: number): string;
  unreachable(host: string, port: number): string;
  noRoute(host: string, port: number): string;
}

export const OPENSSH_SSH: SshDialect = {
  unresolved: (host) => `ssh: Could not resolve hostname ${host}: Name or service not known`,
  refused: (host, port) => `ssh: connect to host ${host} port ${port}: Connection refused`,
  timedOut: (host, port) => `ssh: connect to host ${host} port ${port}: Connection timed out`,
  unreachable: (host, port) => `ssh: connect to host ${host} port ${port}: Network is unreachable`,
  noRoute: (host, port) => `ssh: connect to host ${host} port ${port}: No route to host`,
};

export const IOS_SSH: SshDialect = {
  unresolved: () => '% Bad IP address or host name',
  refused: () => '% Connection refused by remote host',
  timedOut: () => '% Connection timed out; remote host not responding',
  unreachable: () => '% Destination unreachable; gateway or host down',
  noRoute: () => '% Destination unreachable; gateway or host down',
};

export const VRP_SSH: SshDialect = {
  unresolved: () => 'Error: Failed to connect to the remote host.',
  refused: () => 'Error: Failed to connect to the remote host.',
  timedOut: () => 'Error: Failed to connect to the remote host.',
  unreachable: () => 'Error: Failed to connect to the remote host.',
  noRoute: () => 'Error: Failed to connect to the remote host.',
};

const SAYS: Readonly<Record<
  Exclude<TcpWireOutcome, 'open'>, keyof SshDialect
>> = {
  refused: 'refused',
  timeout: 'timedOut',
  prohibited: 'noRoute',
  unreachable: 'noRoute',
};

export function sshWireFailureLine(
  dialect: SshDialect, outcome: Exclude<TcpWireOutcome, 'open'>,
  host: string, port: number,
): string {
  return dialect[SAYS[outcome]](host, port);
}
