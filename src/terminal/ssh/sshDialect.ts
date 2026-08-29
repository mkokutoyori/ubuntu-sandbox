export interface SshDialect {
  unresolved(host: string, port: number): string;
  refused(host: string, port: number): string;
  timedOut(host: string, port: number): string;
  unreachable(host: string, port: number): string;
}

export const OPENSSH_SSH: SshDialect = {
  unresolved: (host) => `ssh: Could not resolve hostname ${host}: Name or service not known`,
  refused: (host, port) => `ssh: connect to host ${host} port ${port}: Connection refused`,
  timedOut: (host, port) => `ssh: connect to host ${host} port ${port}: Connection timed out`,
  unreachable: (host, port) => `ssh: connect to host ${host} port ${port}: Network is unreachable`,
};

export const IOS_SSH: SshDialect = {
  unresolved: () => '% Bad IP address or host name',
  refused: () => '% Connection refused by remote host',
  timedOut: () => '% Connection timed out; remote host not responding',
  unreachable: () => '% Destination unreachable; gateway or host down',
};

export const VRP_SSH: SshDialect = {
  unresolved: () => 'Error: Failed to connect to the remote host.',
  refused: () => 'Error: Failed to connect to the remote host.',
  timedOut: () => 'Error: Failed to connect to the remote host.',
  unreachable: () => 'Error: Failed to connect to the remote host.',
};
