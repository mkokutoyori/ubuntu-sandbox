import type { LoadBalanceMethod } from '@/network/lacp/loadBalance';
import type { Port } from '@/network/hardware/Port';

export const BOND_MODES = [
  'balance-rr', 'active-backup', 'balance-xor', 'broadcast',
  '802.3ad', 'balance-tlb', 'balance-alb',
] as const;
export type BondMode = typeof BOND_MODES[number];

export const XMIT_HASH_POLICIES = [
  'layer2', 'layer3+4', 'layer2+3', 'encap2+3', 'encap3+4', 'vlan+srcmac',
] as const;
export type XmitHashPolicy = typeof XMIT_HASH_POLICIES[number];

export function bondModeIndex(mode: BondMode): number {
  return BOND_MODES.indexOf(mode);
}

export function xmitHashIndex(policy: XmitHashPolicy): number {
  return XMIT_HASH_POLICIES.indexOf(policy);
}

export function xmitHashToLoadBalance(policy: XmitHashPolicy): LoadBalanceMethod {
  switch (policy) {
    case 'layer3+4':
    case 'encap3+4':
      return 'src-dst-port';
    case 'layer2+3':
    case 'encap2+3':
      return 'src-dst-ip';
    default:
      return 'src-dst-mac';
  }
}

export function modeUsesXmitHash(mode: BondMode): boolean {
  return mode === 'balance-xor' || mode === '802.3ad'
    || mode === 'balance-tlb' || mode === 'balance-alb';
}

export interface BondOptions {
  mode: BondMode;
  miimon: number;
  updelay: number;
  downdelay: number;
  peerNotifDelay: number;
  lacpActive: boolean;
  lacpRate: 'slow' | 'fast';
  minLinks: number;
  adSelect: 'stable' | 'bandwidth' | 'count';
  xmitHashPolicy: XmitHashPolicy;
  systemPriority: number;
}

export function defaultBondOptions(): BondOptions {
  return {
    mode: 'balance-rr',
    miimon: 0,
    updelay: 0,
    downdelay: 0,
    peerNotifDelay: 0,
    lacpActive: true,
    lacpRate: 'slow',
    minLinks: 0,
    adSelect: 'stable',
    xmitHashPolicy: 'layer2',
    systemPriority: 65535,
  };
}

export interface BondSlaveView {
  name: string;
  mii: 'up' | 'down';
  speedMbps: number | null;
  duplex: 'full' | 'half' | null;
  linkFailureCount: number;
  permanentHwAddr: string;
  queueId: number;
  aggregatorId: number | null;
  actorChurnState: string;
  partnerChurnState: string;
  actorChurnedCount: number;
  partnerChurnedCount: number;
  actorPortNumber: number;
  actorPortKey: number;
  actorPortPriority: number;
  actorPortState: number;
  partnerSystemPriority: number;
  partnerSystem: string;
  partnerKey: number;
  partnerPortPriority: number;
  partnerPortNumber: number;
  partnerPortState: number;
}

export interface BondAggregatorView {
  aggregatorId: number;
  ports: number;
  actorKey: number;
  partnerKey: number;
  partnerSystem: string;
}

export interface BondView {
  name: string;
  options: BondOptions;
  carrier: boolean;
  systemMac: string;
  aggregator: BondAggregatorView | null;
  slaves: BondSlaveView[];
}

function mac(value: string): string {
  return value.toLowerCase();
}

export function renderProcNetBonding(view: BondView, kernelRelease: string): string {
  const o = view.options;
  const lines: string[] = [];
  lines.push(`Ethernet Channel Bonding Driver: v${kernelRelease}`);
  lines.push('');
  lines.push(`Bonding Mode: ${bondModeDescription(o.mode)}`);
  if (modeUsesXmitHash(o.mode)) {
    lines.push(`Transmit Hash Policy: ${o.xmitHashPolicy} (${xmitHashIndex(o.xmitHashPolicy)})`);
  }
  if (o.mode === 'active-backup' || o.mode === 'balance-tlb' || o.mode === 'balance-alb') {
    const actif = view.slaves.find(s => s.mii === 'up');
    lines.push('Primary Slave: None');
    lines.push(`Currently Active Slave: ${actif ? actif.name : 'None'}`);
  }
  lines.push(`MII Status: ${view.carrier ? 'up' : 'down'}`);
  lines.push(`MII Polling Interval (ms): ${o.miimon}`);
  lines.push(`Up Delay (ms): ${o.updelay * o.miimon}`);
  lines.push(`Down Delay (ms): ${o.downdelay * o.miimon}`);
  lines.push(`Peer Notification Delay (ms): ${o.peerNotifDelay * o.miimon}`);

  if (o.mode === '802.3ad') {
    lines.push('');
    lines.push('802.3ad info');
    lines.push(`LACP active: ${o.lacpActive ? 'on' : 'off'}`);
    lines.push(`LACP rate: ${o.lacpRate}`);
    lines.push(`Min links: ${o.minLinks}`);
    lines.push(`Aggregator selection policy (ad_select): ${o.adSelect}`);
    lines.push(`System priority: ${o.systemPriority}`);
    lines.push(`System MAC address: ${mac(view.systemMac)}`);
    if (!view.aggregator) {
      lines.push(`bond ${view.name} has no active aggregator`);
    } else {
      lines.push('Active Aggregator Info:');
      lines.push(`\tAggregator ID: ${view.aggregator.aggregatorId}`);
      lines.push(`\tNumber of ports: ${view.aggregator.ports}`);
      lines.push(`\tActor Key: ${view.aggregator.actorKey}`);
      lines.push(`\tPartner Key: ${view.aggregator.partnerKey}`);
      lines.push(`\tPartner Mac Address: ${mac(view.aggregator.partnerSystem)}`);
    }
  }

  for (const s of view.slaves) {
    lines.push('');
    lines.push(`Slave Interface: ${s.name}`);
    lines.push(`MII Status: ${s.mii}`);
    lines.push(s.speedMbps === null ? 'Speed: Unknown' : `Speed: ${s.speedMbps} Mbps`);
    lines.push(s.duplex === null ? 'Duplex: Unknown' : `Duplex: ${s.duplex}`);
    lines.push(`Link Failure Count: ${s.linkFailureCount}`);
    lines.push(`Permanent HW addr: ${mac(s.permanentHwAddr)}`);
    lines.push(`Slave queue ID: ${s.queueId}`);
    if (o.mode === '802.3ad') {
      if (s.aggregatorId === null) {
        lines.push('Aggregator ID: N/A');
      } else {
        lines.push(`Aggregator ID: ${s.aggregatorId}`);
        lines.push(`Actor Churn State: ${s.actorChurnState}`);
        lines.push(`Partner Churn State: ${s.partnerChurnState}`);
        lines.push(`Actor Churned Count: ${s.actorChurnedCount}`);
        lines.push(`Partner Churned Count: ${s.partnerChurnedCount}`);
        lines.push('details actor lacp pdu:');
        lines.push(`    system priority: ${o.systemPriority}`);
        lines.push(`    system mac address: ${mac(view.systemMac)}`);
        lines.push(`    port key: ${s.actorPortKey}`);
        lines.push(`    port priority: ${s.actorPortPriority}`);
        lines.push(`    port number: ${s.actorPortNumber}`);
        lines.push(`    port state: ${s.actorPortState}`);
        lines.push('details partner lacp pdu:');
        lines.push(`    system priority: ${s.partnerSystemPriority}`);
        lines.push(`    system mac address: ${mac(s.partnerSystem)}`);
        lines.push(`    oper key: ${s.partnerKey}`);
        lines.push(`    port priority: ${s.partnerPortPriority}`);
        lines.push(`    port number: ${s.partnerPortNumber}`);
        lines.push(`    port state: ${s.partnerPortState}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

export function bondModeDescription(mode: BondMode): string {
  switch (mode) {
    case 'balance-rr': return 'load balancing (round-robin)';
    case 'active-backup': return 'fault-tolerance (active-backup)';
    case 'balance-xor': return 'load balancing (xor)';
    case 'broadcast': return 'fault-tolerance (broadcast)';
    case '802.3ad': return 'IEEE 802.3ad Dynamic link aggregation';
    case 'balance-tlb': return 'transmit load balancing';
    case 'balance-alb': return 'adaptive load balancing';
  }
}

export class LinuxBond {
  readonly slaves: string[] = [];
  readonly savedMacs = new Map<string, string>();
  readonly options: BondOptions = defaultBondOptions();

  constructor(readonly name: string) {}

  addSlave(iface: string): boolean {
    if (this.slaves.includes(iface)) return false;
    this.slaves.push(iface);
    return true;
  }

  removeSlave(iface: string): boolean {
    const i = this.slaves.indexOf(iface);
    if (i < 0) return false;
    this.slaves.splice(i, 1);
    return true;
  }

  setOption(key: string, value: string): boolean {
    switch (key) {
      case 'mode': {
        const parNom = BOND_MODES.find(m => m === value);
        const parIndex = /^[0-6]$/.test(value) ? BOND_MODES[Number(value)] : undefined;
        const m = parNom ?? parIndex;
        if (!m) return false;
        this.options.mode = m;
        return true;
      }
      case 'miimon': case 'updelay': case 'downdelay':
      case 'peer_notif_delay': case 'min_links': case 'ad_actor_sys_prio': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) return false;
        if (key === 'miimon') this.options.miimon = n;
        else if (key === 'updelay') this.options.updelay = n;
        else if (key === 'downdelay') this.options.downdelay = n;
        else if (key === 'peer_notif_delay') this.options.peerNotifDelay = n;
        else if (key === 'min_links') this.options.minLinks = n;
        else this.options.systemPriority = n;
        return true;
      }
      case 'lacp_rate':
        if (value === 'fast' || value === '1') { this.options.lacpRate = 'fast'; return true; }
        if (value === 'slow' || value === '0') { this.options.lacpRate = 'slow'; return true; }
        return false;
      case 'lacp_active':
        if (value === 'on' || value === '1') { this.options.lacpActive = true; return true; }
        if (value === 'off' || value === '0') { this.options.lacpActive = false; return true; }
        return false;
      case 'xmit_hash_policy': {
        const p = XMIT_HASH_POLICIES.find(x => x === value)
          ?? (/^[0-5]$/.test(value) ? XMIT_HASH_POLICIES[Number(value)] : undefined);
        if (!p) return false;
        this.options.xmitHashPolicy = p;
        return true;
      }
      case 'ad_select':
        if (value === 'stable' || value === 'bandwidth' || value === 'count') {
          this.options.adSelect = value;
          return true;
        }
        return false;
      default:
        return false;
    }
  }
}

export function slaveViewFrom(
  port: Port, permanentHwAddr: string,
): Pick<BondSlaveView, 'name' | 'mii' | 'speedMbps' | 'duplex' | 'permanentHwAddr' | 'queueId' | 'linkFailureCount'> {
  return {
    name: port.getName(),
    mii: port.isOperationallyUp() ? 'up' : 'down',
    speedMbps: port.getNegotiatedSpeed?.() ?? null,
    duplex: port.getNegotiatedDuplex?.() === 'half' ? 'half' : 'full',
    permanentHwAddr: port.getMAC().toString(),
    queueId: 0,
    linkFailureCount: 0,
  };
}
