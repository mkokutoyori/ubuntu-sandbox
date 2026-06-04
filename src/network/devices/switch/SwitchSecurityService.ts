export interface DhcpSnoopingTrustedInterface {
  ifName: string;
  trusted: boolean;
}

export interface ArpAntiAttackPolicy {
  vlan?: number;
  ifName?: string;
  detectionMode?: 'gateway-duplicate' | 'unknown-flow' | 'fixed-mac' | 'fixed-all';
  validateSource?: boolean;
  rateLimit?: number;
}

export interface IpSourceGuardBinding {
  ifName?: string;
  vlan?: number;
  ipAddress?: string;
  macAddress?: string;
  type: 'static' | 'dhcp-snooping';
}

export interface DhcpSnoopingPool {
  vlanRanges: number[];
  enabled: boolean;
}

export class SwitchSecurityService {
  private dhcpGlobalEnabled = false;
  private dhcpSnoopingGlobalEnabled = false;
  private dhcpSnoopingPerVlan: Set<number> = new Set();
  private dhcpSnoopingTrust: Map<string, DhcpSnoopingTrustedInterface> = new Map();
  private dhcpServerSourceInterface: string = '';
  private arpAntiAttackPolicies: ArpAntiAttackPolicy[] = [];
  private ipSourceGuardBindings: IpSourceGuardBinding[] = [];
  private ipSourceGuardEnabled: Set<string> = new Set();

  setDhcpEnabled(enabled: boolean): void { this.dhcpGlobalEnabled = enabled; }
  isDhcpEnabled(): boolean { return this.dhcpGlobalEnabled; }

  configureDhcpSnooping(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'snooping' && args[1]?.toLowerCase() === 'enable') {
      this.dhcpSnoopingGlobalEnabled = true;
    } else if (head === 'snooping' && args[1]?.toLowerCase() === 'enable' && args[2]?.toLowerCase() === 'vlan') {
      for (let i = 3; i < args.length; i++) {
        const n = parseInt(args[i], 10);
        if (!isNaN(n)) this.dhcpSnoopingPerVlan.add(n);
      }
    } else if (head === 'snooping' && args[1]?.toLowerCase() === 'trust' && args[2]?.toLowerCase() === 'interface' && args[3]) {
      this.dhcpSnoopingTrust.set(args[3], { ifName: args[3], trusted: true });
    } else if (head === 'server' && args[1]?.toLowerCase() === 'source-interface' && args[2]) {
      this.dhcpServerSourceInterface = args[2];
    }
  }

  isDhcpSnoopingEnabled(vlan?: number): boolean {
    if (vlan !== undefined) return this.dhcpSnoopingPerVlan.has(vlan);
    return this.dhcpSnoopingGlobalEnabled;
  }
  getDhcpSnoopingTrust(): readonly DhcpSnoopingTrustedInterface[] {
    return [...this.dhcpSnoopingTrust.values()];
  }
  getDhcpServerSourceInterface(): string { return this.dhcpServerSourceInterface; }
  getDhcpSnoopingVlans(): readonly number[] { return [...this.dhcpSnoopingPerVlan]; }

  configureArpAntiAttack(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    const policy: ArpAntiAttackPolicy = {};
    if (head === 'check' && args[1] === 'user-bind') {
      policy.validateSource = true;
    } else if (head === 'rate-limit' && args[1]) {
      policy.rateLimit = parseInt(args[1], 10);
    } else if (head === 'gateway-duplicate' || head === 'unknown-flow' || head === 'fixed-mac' || head === 'fixed-all') {
      policy.detectionMode = head as ArpAntiAttackPolicy['detectionMode'];
    }
    if (Object.keys(policy).length > 0) this.arpAntiAttackPolicies.push(policy);
  }
  getArpAntiAttackPolicies(): readonly ArpAntiAttackPolicy[] { return [...this.arpAntiAttackPolicies]; }

  configureIpSource(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'check' && args[1] === 'user-bind' && args[2] === 'enable') {
      this.ipSourceGuardEnabled.add('global');
    } else if (head === 'user-bind' && args[1] === 'static') {
      const binding: IpSourceGuardBinding = { type: 'static' };
      for (let i = 2; i < args.length; i++) {
        if (args[i] === 'ip-address' && args[i + 1]) { binding.ipAddress = args[i + 1]; i++; }
        else if (args[i] === 'mac-address' && args[i + 1]) { binding.macAddress = args[i + 1]; i++; }
        else if (args[i] === 'interface' && args[i + 1]) { binding.ifName = args[i + 1]; i++; }
        else if (args[i] === 'vlan' && args[i + 1]) { binding.vlan = parseInt(args[i + 1], 10); i++; }
      }
      this.ipSourceGuardBindings.push(binding);
    }
  }
  isIpSourceGuardEnabled(): boolean { return this.ipSourceGuardEnabled.has('global'); }
  getIpSourceGuardBindings(): readonly IpSourceGuardBinding[] { return [...this.ipSourceGuardBindings]; }
}
