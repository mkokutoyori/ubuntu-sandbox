import type { DeviceType } from '../../../../core/types';
import { Firewall, type FirewallOptions } from '../../Firewall';
import { ASA_PROFILE } from './AsaProfile';
import { AsaShell } from './AsaShell';

export class AsaFirewall extends Firewall {
  private readonly accessGroups = new Map<string, string>();
  private shellInstance?: AsaShell;

  constructor(
    deviceType: DeviceType = 'firewall-cisco', name = 'ASA', x = 0, y = 0,
    options: Omit<FirewallOptions, 'profile'> = {},
  ) {
    super(deviceType, name, x, y, { ...options, profile: ASA_PROFILE });
  }

  getShell(): AsaShell {
    if (!this.shellInstance) this.shellInstance = new AsaShell(this);
    return this.shellInstance;
  }

  executeCommand(command: string): Promise<string> {
    return Promise.resolve(this.getShell().execute(command));
  }

  getPrompt(): string {
    return this.getShell().getPrompt();
  }

  getBootSequence(): string {
    return [
      'Booting system, please wait...',
      '',
      `Cisco Adaptive Security Appliance Software Version ${ASA_PROFILE.defaultVersion}`,
      '',
      'Type help or \'?\' for a list of available commands.',
    ].join('\n');
  }

  getBanner(_type: string): string {
    return '';
  }

  cliHelp(inputBeforeQuestion: string): string {
    return this.getShell().help(inputBeforeQuestion).join('\n');
  }

  cliTabCandidates(input: string): string[] {
    return [...this.getShell().completions(input)];
  }

  cliTabComplete(input: string): string | null {
    const candidates = this.cliTabCandidates(input);
    return candidates.length === 1 ? candidates[0] : null;
  }

  nameif(iface: string, zoneName: string, securityLevel: number): void {
    const zones = this.getZoneTable();
    const previous = zones.zoneOf(iface);
    if (previous !== undefined) zones.removeInterface(iface);

    if (!zones.has(zoneName)) zones.createZone(zoneName, { securityLevel });
    zones.assignInterface(zoneName, iface);
  }

  setSecurityLevel(iface: string, level: number): boolean {
    const zone = this.getZoneTable().zoneOf(iface);
    if (zone === undefined) return false;
    return this.getZoneTable().setSecurityLevel(zone, level).ok;
  }

  securityLevelOf(iface: string): number | undefined {
    const zone = this.getZoneTable().zoneOf(iface);
    return zone === undefined ? undefined : this.getZoneTable().getZone(zone)?.securityLevel;
  }

  accessGroup(aclName: string, iface: string): void {
    this.accessGroups.set(iface, aclName);
    this.bindPolicyToInterface(iface);
  }

  removeAccessGroup(iface: string): void {
    this.accessGroups.delete(iface);
    this.unbindPolicyFromInterface(iface);
  }

  accessGroupOn(iface: string): string | undefined {
    return this.accessGroups.get(iface);
  }

  getOSType(): string {
    return 'asa';
  }
}
