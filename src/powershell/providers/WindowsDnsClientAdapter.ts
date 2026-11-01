import type { WindowsPC } from '@/network/devices/WindowsPC';
import type {
  DnsClientGlobalSettings, DohServerAddress, NrptGlobalSettings, NrptRule, NrptRuleDraft,
} from '@/network/devices/windows/dnsClientSettings';
import { uuidFromSeed } from '@/network/devices/host/hardware/HardwareIdentity';
import type { DnsClientInterfaceChanges, DnsClientInterfaceRow, IDnsClientProvider } from './PSProviders';

function newRuleName(machine: string, taken: ReadonlySet<string>): string {
  for (let attempt = taken.size + 1; ; attempt++) {
    const name = `{${uuidFromSeed(`nrpt:${machine}:${attempt}`).toUpperCase()}}`;
    if (!taken.has(name)) return name;
  }
}

export class WindowsDnsClientAdapter implements IDnsClientProvider {
  constructor(private readonly pc: WindowsPC) {}

  interfaces(): DnsClientInterfaceRow[] {
    return this.pc.getPorts().map((port) => {
      const portName = port.getName();
      const identity = this.pc.adapterIdentityOf(portName);
      const settings = this.pc.dnsClientSettings.interfaceSettings(identity.guid);
      return {
        interfaceAlias: this.pc.adapterAlias(portName),
        interfaceIndex: identity.ifIndex,
        interfaceGuid: identity.guid,
        connectionSpecificSuffix: this.pc.getConnectionDnsSuffix(portName),
        registerThisConnectionsAddress: settings.registerThisConnectionsAddress,
        useSuffixWhenRegistering: settings.useSuffixWhenRegistering,
      };
    });
  }

  changeInterface(interfaceGuid: string, changes: DnsClientInterfaceChanges): void {
    this.pc.dnsClientSettings.setInterfaceSettings(interfaceGuid, changes);
  }

  registerNames(): void {
    void this.pc.registerHostInDomainDns();
  }

  globalSettings(): DnsClientGlobalSettings {
    return this.pc.dnsClientSettings.globalSettings();
  }

  changeGlobalSettings(changes: { suffixSearchList?: readonly string[]; useDevolution?: boolean; devolutionLevel?: number }): void {
    this.pc.dnsClientSettings.setGlobalSettings(changes);
  }

  nrptRules(): NrptRule[] {
    return this.pc.dnsClientSettings.nrptRules();
  }

  addNrptRule(draft: NrptRuleDraft): NrptRule {
    const taken = new Set(this.pc.dnsClientSettings.nrptRules().map(rule => rule.name));
    return this.pc.dnsClientSettings.addNrptRule(newRuleName(this.pc.getName(), taken), draft);
  }

  changeNrptRule(name: string, changes: Partial<NrptRuleDraft>): NrptRule | null {
    return this.pc.dnsClientSettings.updateNrptRule(name, changes);
  }

  removeNrptRule(name: string): boolean {
    return this.pc.dnsClientSettings.removeNrptRule(name);
  }

  nrptGlobal(): NrptGlobalSettings {
    return this.pc.dnsClientSettings.nrptGlobal();
  }

  changeNrptGlobal(changes: Partial<NrptGlobalSettings>): void {
    this.pc.dnsClientSettings.setNrptGlobal(changes);
  }

  dohServers(): DohServerAddress[] {
    return this.pc.dnsClientSettings.dohServers();
  }

  saveDohServer(entry: DohServerAddress): void {
    this.pc.dnsClientSettings.setDohServer(entry);
  }

  removeDohServer(serverAddress: string): boolean {
    return this.pc.dnsClientSettings.removeDohServer(serverAddress);
  }
}
