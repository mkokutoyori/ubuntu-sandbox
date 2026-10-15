import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importTopology } from '@/store/topologySerializer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { IPAddress, SubnetMask } from '@/network/core/types';

export interface LabHost {
  getName(): string;
  executeCommand(command: string, stdin?: string): Promise<string>;
  getPorts(): Array<{ getName(): string; configureIP(ip: IPAddress, mask: SubnetMask): void }>;
  setDefaultGateway?(gateway: IPAddress): void;
  setCurrentUser?(name: string): void;
}

export type Platform = 'linux' | 'windows';

export interface LabEntry {
  readonly host: LabHost;
  readonly platform: Platform;
  readonly ip: string;
}

export const ROSTER: Readonly<Record<string, { platform: Platform; ip: string; gateway: string; site: string }>> = {
  PC1: { platform: 'windows', ip: '192.168.30.3', gateway: '192.168.30.1', site: 'HQ' },
  PC2: { platform: 'linux', ip: '192.168.30.5', gateway: '192.168.30.1', site: 'HQ' },
  PC3: { platform: 'windows', ip: '192.168.30.4', gateway: '192.168.30.1', site: 'HQ' },
  PC4: { platform: 'windows', ip: '192.168.10.5', gateway: '192.168.10.1', site: 'HO' },
  PC5: { platform: 'linux', ip: '192.168.10.4', gateway: '192.168.10.1', site: 'HO' },
  PC6: { platform: 'linux', ip: '192.168.10.3', gateway: '192.168.10.1', site: 'HO' },
  PC8: { platform: 'linux', ip: '192.168.10.2', gateway: '192.168.10.1', site: 'HO' },
  PC9: { platform: 'linux', ip: '192.168.20.2', gateway: '192.168.20.1', site: 'HO' },
  PC10: { platform: 'windows', ip: '192.168.20.4', gateway: '192.168.20.1', site: 'HO' },
  Server1: { platform: 'linux', ip: '192.168.20.3', gateway: '192.168.20.1', site: 'HO' },
  PC11: { platform: 'windows', ip: '192.168.50.2', gateway: '192.168.50.1', site: 'AKWA' },
  Server2: { platform: 'linux', ip: '192.168.40.2', gateway: '192.168.40.1', site: 'AKWA' },
};

export const PASSWORD_OF: Readonly<Record<string, string>> = {
  alice: 'alice',
  bob: 'bob',
  carl: 'carl',
  dave: 'dave',
};

const EXPORT = join(__dirname, '..', 'new_firewall', 'SSH_TP_LAN.topology (7).json');
const ROUTERS = ['MAIN_RT01', 'MAIN_RT02', 'MAIN_RT_HO', 'MAIN_RT_AKWA'];

export const NOCHECK = '-o StrictHostKeyChecking=no';

export class SshTpLan {
  private constructor(private readonly entries: ReadonlyMap<string, LabEntry>) {}

  static async build(): Promise<SshTpLan> {
    EquipmentRegistry.resetInstance();
    installSimulationClock();
    const imported = await importTopology(JSON.parse(readFileSync(EXPORT, 'utf8')));
    const byName = new Map<string, LabHost>(
      [...imported.deviceInstances.values()].map((d) => [d.getName(), d as unknown as LabHost]),
    );

    for (const name of ROUTERS) {
      const router = byName.get(name)!;
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      for (const port of router.getPorts()) {
        await router.executeCommand(`interface ${port.getName()}`);
        await router.executeCommand('no shutdown');
        await router.executeCommand('exit');
      }
      await router.executeCommand('end');
    }

    const entries = new Map<string, LabEntry>();
    for (const [name, spec] of Object.entries(ROSTER)) {
      const host = byName.get(name)!;
      const port = host.getPorts()[0];
      port.configureIP(new IPAddress(spec.ip), new SubnetMask('255.255.255.0'));
      host.setDefaultGateway?.(new IPAddress(spec.gateway));
      entries.set(name, { host, platform: spec.platform, ip: spec.ip });
    }
    const lan = new SshTpLan(entries);
    await lan.provisionProfiles();
    return lan;
  }

  static dispose(): void {
    __resetSimulationClock();
  }

  host(name: string): LabHost {
    return this.entry(name).host;
  }

  platform(name: string): Platform {
    return this.entry(name).platform;
  }

  ip(name: string): string {
    return this.entry(name).ip;
  }

  names(platform?: Platform): string[] {
    return [...this.entries].filter(([, e]) => !platform || e.platform === platform).map(([n]) => n);
  }

  run(name: string, command: string, stdin?: string): Promise<string> {
    return this.host(name).executeCommand(command, stdin);
  }

  withPassword(client: string, command: string, user: string): Promise<string> {
    const password = PASSWORD_OF[user];
    if (this.platform(client) === 'linux') return this.run(client, `sshpass -p ${password} ${command}`);
    return this.run(client, command, `${password}\n`);
  }

  quote(client: string, remoteCommand: string): string {
    return this.platform(client) === 'linux' ? `'${remoteCommand}'` : `"${remoteCommand}"`;
  }

  async asWindowsAdministrator(name: string, commands: string[]): Promise<string> {
    const host = this.host(name);
    host.setCurrentUser?.('Administrator');
    const outputs: string[] = [];
    for (const command of commands) outputs.push(await host.executeCommand(command));
    host.setCurrentUser?.('User');
    return outputs.join('\n');
  }

  async editLinuxSshd(name: string, text: string, apply: 'reload' | 'restart' | 'none' = 'reload', drop: string[] = []): Promise<() => Promise<void>> {
    await this.run(name, 'sudo cp /etc/ssh/sshd_config /tmp/sshd_config.lab', 'user\n');
    for (const keyword of drop) await this.run(name, `sudo sed -i '/^[[:space:]]*${keyword}/d' /etc/ssh/sshd_config`, 'user\n');
    if (text.length > 0) {
      await this.run(name, `sudo sh -c "printf '%s\\n' '${text.split('\n').join("' '")}' >> /etc/ssh/sshd_config"`, 'user\n');
    }
    if (apply !== 'none') await this.run(name, `sudo systemctl ${apply} ssh`, 'user\n');
    return async () => {
      await this.run(name, 'sudo cp /tmp/sshd_config.lab /etc/ssh/sshd_config', 'user\n');
      await this.run(name, 'sudo systemctl restart ssh', 'user\n');
    };
  }

  async editWindowsSshd(name: string, text: string, apply = true, drop: string[] = []): Promise<() => Promise<void>> {
    const config = 'C:\\ProgramData\\ssh\\sshd_config';
    const files = (this.host(name) as unknown as {
      fs: { readFile(path: string): { ok: boolean; content?: string }; createFile(path: string, content: string): unknown };
    }).fs;
    const original = files.readFile(config).content ?? '';
    const kept = original.split('\n').filter((line) => !drop.some((keyword) => line.startsWith(keyword)));
    const firstMatch = kept.findIndex((line) => /^\s*Match\s/i.test(line));
    const insertion = text.length === 0 ? [] : text.split('\n');
    const edited = firstMatch < 0 ? [...kept, ...insertion] : [...kept.slice(0, firstMatch), ...insertion, ...kept.slice(firstMatch)];
    files.createFile(config, edited.join('\n'));
    if (apply) await this.asWindowsAdministrator(name, ['net stop sshd', 'net start sshd']);
    return async () => {
      files.createFile(config, original);
      await this.asWindowsAdministrator(name, ['net stop sshd', 'net start sshd']);
    };
  }

  private entry(name: string): LabEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`unknown lab host ${name}`);
    return entry;
  }

  private async provisionProfiles(): Promise<void> {
    for (const name of this.names('linux')) {
      await this.run(name, 'sudo gpasswd -d bob sudo', 'user\n');
      await this.run(name, 'sudo gpasswd -d carl sudo', 'user\n');
      await this.run(name, 'sudo gpasswd -d dave sudo', 'user\n');
      await this.run(name, 'sudo usermod -s /usr/sbin/nologin carl', 'user\n');
      await this.run(name, 'sudo chmod 700 /home/dave', 'user\n');
      await this.run(name, 'sudo systemctl disable --now fail2ban', 'user\n');
    }
    for (const name of this.names('windows')) {
      await this.asWindowsAdministrator(name, [
        'net localgroup Administrators alice /add',
        'net localgroup Users bob /add',
        'net localgroup Users dave /add',
        'net user carl /active:no',
      ]);
    }
  }
}
