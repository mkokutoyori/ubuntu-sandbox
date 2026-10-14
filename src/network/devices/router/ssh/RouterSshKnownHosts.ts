import type { Equipment } from '@/network/equipment/Equipment';
import { SshKnownHostsFile } from '@/network/protocols/ssh/SshKnownHostsFile';
import { knownHostsPathFor, ROUTER_SSH_LOCAL_USER, sshLocalFsFor } from '@/network/protocols/ssh/localFs/sshLocalFsFor';

export interface RouterSshKnownHostEntry {
  readonly host: string;
  readonly keyType: string;
  readonly publicKey: string;
}

export class RouterSshKnownHosts {
  constructor(private readonly device: Equipment) {}

  list(): readonly RouterSshKnownHostEntry[] {
    const content = sshLocalFsFor(this.device).readFile(knownHostsPathFor(this.device, ROUTER_SSH_LOCAL_USER)) ?? '';
    return SshKnownHostsFile.parse(content).entries.flatMap((entry) =>
      entry.hostnames.map((host) => ({ host, keyType: entry.keyType, publicKey: entry.publicKey })));
  }

  renderCisco(): string {
    const header = 'Address          Key fingerprint                                   Type';
    const rows = this.list().map((e) =>
      `${e.host.padEnd(17)}${e.publicKey.slice(0, 50).padEnd(51)}${e.keyType}`);
    return [header, ...rows].join('\n');
  }
}
