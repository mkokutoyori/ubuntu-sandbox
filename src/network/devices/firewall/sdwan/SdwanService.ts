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
    for (const member of configuration.members) {
      if (member.iface.length === 0) {
        return `member ${member.sequence} needs \`set interface\`.`;
      }
    }

    this.table.setStatus(configuration.enabled);
    this.table.setLoadBalanceMode(configuration.loadBalanceMode);

    const zones = new Set(configuration.zones);
    for (const zone of this.table.zoneNames()) {
      if (!zones.has(zone)) this.table.removeZone(zone);
    }
    for (const zone of zones) this.table.setZone(zone);

    const sequences = new Set(configuration.members.map(member => member.sequence));
    for (const member of this.table.allMembers()) {
      if (!sequences.has(member.sequence)) this.table.removeMember(member.sequence);
    }
    for (const member of configuration.members) this.table.setMember(member);

    const checks = new Set(configuration.healthChecks.map(check => check.name));
    for (const check of this.table.allHealthChecks()) {
      if (!checks.has(check.name)) this.table.removeHealthCheck(check.name);
    }
    for (const check of configuration.healthChecks) this.table.setHealthCheck(check);

    const services = new Set(configuration.services.map(service => service.id));
    for (const service of this.table.allServices()) {
      if (!services.has(service.id)) this.table.removeService(service.id);
    }
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
