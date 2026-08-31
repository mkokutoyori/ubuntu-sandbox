import type { DHCPServer } from './DHCPServer';
import type { DHCPPoolConfig, DHCPSnoopingConfig } from './types';
import { compactVlanList } from '../devices/shells/cli/vlanList';

export function dhcpSnoopingRunningConfigLines(cfg: DHCPSnoopingConfig): string[] {
  const lines: string[] = [];
  if (cfg.enabled) lines.push('ip dhcp snooping');
  if (cfg.vlans.size > 0) {
    const sorted = [...cfg.vlans].sort((a, b) => a - b);
    lines.push(`ip dhcp snooping vlan ${compactVlanList(sorted)}`);
  }
  if (cfg.informationOption) lines.push('ip dhcp snooping information option');
  if (!cfg.verifyMac) lines.push('no ip dhcp snooping verify mac-address');
  return lines;
}

export function dhcpSnoopingInterfaceLines(
  cfg: DHCPSnoopingConfig, ifName: string,
): string[] {
  const lines: string[] = [];
  if (cfg.trustedPorts.has(ifName)) lines.push(' ip dhcp snooping trust');
  const rate = cfg.rateLimits.get(ifName);
  if (rate !== undefined && rate > 0) lines.push(` ip dhcp snooping limit rate ${rate}`);
  return lines;
}

export function leaseConfigTail(pool: DHCPPoolConfig): string | null {
  if (pool.leaseInfinite) return 'infinite';
  const total = Math.max(0, Math.floor(pool.leaseDuration));
  if (total === 86400) return null;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (minutes > 0) return `${days} ${hours} ${minutes}`;
  if (hours > 0) return `${days} ${hours}`;
  return String(days);
}

function poolConfigLines(pool: DHCPPoolConfig): string[] {
  const lines = [`ip dhcp pool ${pool.name}`];
  if (pool.network && pool.mask) lines.push(` network ${pool.network} ${pool.mask}`);
  if (pool.manual?.host) {
    lines.push(` host ${pool.manual.host}`
      + (pool.manual.hostMask ? ` ${pool.manual.hostMask}` : ''));
  }
  if (pool.manual?.hardwareAddress) lines.push(` hardware-address ${pool.manual.hardwareAddress}`);
  if (pool.manual?.clientIdentifier) lines.push(` client-identifier ${pool.manual.clientIdentifier}`);
  if (pool.manual?.clientName) lines.push(` client-name ${pool.manual.clientName}`);
  const routers = pool.defaultRouters?.length
    ? pool.defaultRouters
    : (pool.defaultRouter ? [pool.defaultRouter] : []);
  if (routers.length > 0) lines.push(` default-router ${routers.join(' ')}`);
  if (pool.dnsServers.length > 0) lines.push(` dns-server ${pool.dnsServers.join(' ')}`);
  if (pool.domainName) lines.push(` domain-name ${pool.domainName}`);
  if (pool.netbiosServers?.length) {
    lines.push(` netbios-name-server ${pool.netbiosServers.join(' ')}`);
  }
  if (pool.netbiosNodeType) lines.push(` netbios-node-type ${pool.netbiosNodeType}`);
  if (pool.nextServer) lines.push(` next-server ${pool.nextServer}`);
  if (pool.bootfile) lines.push(` bootfile ${pool.bootfile}`);
  for (const option of pool.options ?? []) {
    lines.push(` option ${option.code} ${option.kind} ${option.value}`);
  }
  for (const pattern of pool.denyPatterns) {
    lines.push(` client-identifier deny ${pattern}`);
  }
  const lease = leaseConfigTail(pool);
  if (lease !== null) lines.push(` lease ${lease}`);
  if (pool.highUtilizationMark !== 100 || pool.highUtilizationLog) {
    lines.push(` utilization mark high ${pool.highUtilizationMark}`
      + (pool.highUtilizationLog ? ' log' : ''));
  }
  if (pool.lowUtilizationMark !== 0 || pool.lowUtilizationLog) {
    lines.push(` utilization mark low ${pool.lowUtilizationMark}`
      + (pool.lowUtilizationLog ? ' log' : ''));
  }
  return lines;
}

export function dhcpRunningConfigLines(dhcp: DHCPServer): string[] {
  const lines: string[] = [];
  if (!dhcp.isEnabled()) lines.push('no service dhcp');
  /*
   * L'agent de sauvegarde etait accepte des deux cotes, range dans deux
   * magasins differents, et rendu par personne — donc perdu au
   * rechargement d'une topologie, en silence.
   */
  for (const url of dhcp.getDatabaseAgents()) {
    lines.push(`ip dhcp database ${url}`);
  }
  for (const range of dhcp.getExcludedRanges()) {
    lines.push(range.start === range.end
      ? `ip dhcp excluded-address ${range.start}`
      : `ip dhcp excluded-address ${range.start} ${range.end}`);
  }
  for (const [, pool] of dhcp.getAllPools()) {
    lines.push('!');
    lines.push(...poolConfigLines(pool));
  }
  return lines;
}
