import type { IPv4Packet } from '../../../core/types';
import { SdwanHealthProbe, type ProbeDeps } from './SdwanHealthProbe';
import {
  SdwanTable, type SdwanConfiguration, type SdwanMember,
} from './SdwanTable';

export class SdwanService {
  private readonly table = new SdwanTable();
  private readonly probe: SdwanHealthProbe;

  constructor(deps: ProbeDeps) {
    this.probe = new SdwanHealthProbe(deps);
  }

  apply(configuration: SdwanConfiguration): string | undefined {
    this.table.setStatus(configuration.enabled);
    for (const zone of configuration.zones) this.table.setZone(zone);

    for (const member of configuration.members) {
      if (member.iface.length === 0) {
        return `member ${member.sequence} needs \`set interface\`.`;
      }
      this.table.setMember(member);
    }

    for (const check of configuration.healthChecks) this.table.setHealthCheck(check);
    for (const service of configuration.services) this.table.setService(service);
    return undefined;
  }

  async runHealthChecks(): Promise<void> {
    if (!this.table.isEnabled()) return;
    await this.probe.run(this.table);
  }

  observeReply(packet: IPv4Packet): boolean {
    return this.probe.observeReply(packet);
  }

  preferredMember(check: string, slaId?: number): SdwanMember | undefined {
    return this.table.preferredMember(check, slaId);
  }

  slaMet(check: string, sequence: number, slaId: number): boolean {
    return this.table.slaMet(check, sequence, slaId);
  }

  getTable(): SdwanTable { return this.table; }
}
