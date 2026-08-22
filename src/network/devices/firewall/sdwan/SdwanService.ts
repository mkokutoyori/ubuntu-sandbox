import type { IPv4Packet } from '../../../core/types';
import { SdwanHealthProbe, type ProbeDeps } from './SdwanHealthProbe';
import {
  SdwanTable,
  type SdwanConfiguration, type SdwanHealthTransition, type SdwanMember,
} from './SdwanTable';

export interface SdwanHealthObserver {
  (changes: readonly SdwanHealthTransition[]): void;
}

export class SdwanService {
  private readonly table = new SdwanTable();
  private readonly probe: SdwanHealthProbe;
  private observer: SdwanHealthObserver | undefined;

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

  onHealthChange(observer: SdwanHealthObserver): void {
    this.observer = observer;
  }

  async runHealthChecks(): Promise<void> {
    if (!this.table.isEnabled()) return;
    const changes = await this.probe.run(this.table);
    if (changes.length > 0) this.observer?.(changes);
  }

  observeReply(packet: IPv4Packet): boolean {
    return this.probe.observeReply(packet);
  }

  steer(
    probe: { readonly sourceIP: string; readonly destinationIP: string },
    matchesAddress: (names: readonly string[], candidate: string) => boolean,
  ): { iface: string; gateway: string; ruleId: string } | undefined {
    return this.table.steer(probe, matchesAddress);
  }

  preferredMember(check: string, slaId?: number): SdwanMember | undefined {
    return this.table.preferredMember(check, slaId);
  }

  slaMet(check: string, sequence: number, slaId: number): boolean {
    return this.table.slaMet(check, sequence, slaId);
  }

  getTable(): SdwanTable { return this.table; }
}
