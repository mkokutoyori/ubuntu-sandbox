import type { DeviceType } from '../../../../core/types';
import type { SshKeyAlgorithm } from '../../../../protocols/ssh/SshHostKey';
import { Firewall, type FirewallOptions } from '../../Firewall';
import { ASA_PROFILE } from './AsaProfile';
import { AsaShell } from './AsaShell';
import { AsaRunningState, ASA_KEY_EXCHANGE_GROUPS } from './AsaRunningState';
import { ciscoSshIdentification } from '../../../../protocols/ssh/serverIdentification';

const ASA_HOST_KEY_ALGORITHMS = ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'];

export class AsaFirewall extends Firewall {
  private readonly accessGroups = new Map<string, string>();
  private shellInstance?: AsaShell;
  private readonly state = new AsaRunningState();

  constructor(
    deviceType: DeviceType = 'firewall-cisco', name = 'ASA', x = 0, y = 0,
    options: Omit<FirewallOptions, 'profile'> = {},
  ) {
    super(deviceType, name, x, y, { ...options, profile: ASA_PROFILE });
    this.getLoggingConfig().enabled = false;
    this.applySshAlgorithms();
  }

  runningState(): AsaRunningState { return this.state; }

  applySshAlgorithms(): void {
    const kex = this.state.sshKeyExchangeGroup === null ? null : ASA_KEY_EXCHANGE_GROUPS[this.state.sshKeyExchangeGroup];
    this.setSshAlgorithms({
      hostKey: ASA_HOST_KEY_ALGORITHMS,
      ...(kex === null ? {} : { kex: [kex] }),
      ...(this.state.sshEncryptionCustom.length > 0 ? { ciphers: this.state.sshEncryptionCustom } : {}),
      ...(this.state.sshIntegrityCustom.length > 0 ? { macs: this.state.sshIntegrityCustom } : {}),
    });
  }

  protected override managementSshHostKeyAlgorithm(): SshKeyAlgorithm { return 'ssh-rsa'; }

  protected override managementSshIdentification(): string {
    const version = this.state.sshVersion;
    if (version === 1) return 'SSH-1.5-Cisco-1.25';
    return ciscoSshIdentification(version ?? 0);
  }


  getShell(): AsaShell {
    if (!this.shellInstance) this.shellInstance = new AsaShell(this);
    return this.shellInstance;
  }

  protected override createManagementCli(user: string, origin: string): AsaShell {
    void origin;
    const shell = new AsaShell(this);
    if (this.getAdminAccount(user)?.profile === 'super_admin') shell.openAtPrivilegedExec();
    return shell;
  }

  protected override managementRunningConfig(): string {
    const shell = new AsaShell(this);
    shell.openAtPrivilegedExec();
    return shell.execute('show running-config');
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
    return this.getShell().tabComplete(input);
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
