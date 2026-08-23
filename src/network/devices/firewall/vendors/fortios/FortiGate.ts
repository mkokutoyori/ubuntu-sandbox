import type { DeviceType } from '../../../../core/types';
import { Firewall, type FirewallOptions } from '../../Firewall';
import { FORTIOS_PROFILE } from './FortiProfile';
import { FortiShell } from './FortiShell';
import { daemonMemoryKib } from './diag/sysTopRenderer';

const FACTORY_ADMIN = 'admin';

export class FortiGate extends Firewall {
  private shellInstance?: FortiShell;

  constructor(
    deviceType: DeviceType = 'firewall-fortinet', name = 'FortiGate', x = 0, y = 0,
    options: Omit<FirewallOptions, 'profile'> = {},
  ) {
    super(deviceType, name, x, y, { ...options, profile: FORTIOS_PROFILE });
    this.factoryHostname = name;
    this.getSystemLoad().addWorkload(() => ({
      usedBytes: daemonMemoryKib(this) * 1024, freeableBytes: 0,
    }));
    this.applyFactoryIdentity();
  }

  private readonly factoryHostname: string;

  applyFactoryIdentity(): void {
    this.setName(this.factoryHostname);
    for (const existing of this.adminNames()) {
      if (existing !== FACTORY_ADMIN) this.getAccessMatrix().removeAdmin(existing);
    }
    this.applyAdminAccount({
      name: FACTORY_ADMIN, password: '', profile: 'super_admin',
      vdoms: ['root'], trustHosts: [],
    });
  }

  getShell(): FortiShell {
    if (!this.shellInstance) this.shellInstance = new FortiShell(this);
    return this.shellInstance;
  }

  protected override createManagementCli(user: string): FortiShell {
    const shell = new FortiShell(this);
    shell.setAdminIdentity(user.length > 0 ? user : null);
    return shell;
  }

  protected override managementRunningConfig(): string {
    return this.getShell().execute('show');
  }

  executeCommand(command: string): Promise<string> {
    const shell = this.getShell();
    const output = shell.execute(command);
    return shell.takePendingAsync() ?? Promise.resolve(output);
  }

  getPrompt(): string {
    return this.getShell().getPrompt();
  }

  getBootSequence(): string {
    return [
      'FortiGate booting...',
      '',
      `FortiOS ${FORTIOS_PROFILE.defaultVersion}`,
      '',
      'System is starting...',
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

  getOSType(): string {
    return 'fortios';
  }
}
