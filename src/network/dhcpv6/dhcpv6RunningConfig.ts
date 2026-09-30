import { DHCPV6_IRT_DEFAULT, DHCPV6_IRT_INFINITY } from './DHCPv6Packet';
import type { DHCPv6Server } from './DHCPv6Server';

const DEFAULT_PREFERRED = 27000;
const DEFAULT_VALID = 43200;

export function dhcpv6RunningConfigLines(server: DHCPv6Server): string[] {
  const lines: string[] = [];
  for (const [name, local] of server.getLocalPools()) {
    lines.push(`ipv6 local pool ${name} ${local.prefix}/${local.prefixLength} ${local.assignedLength}`);
  }
  for (const [name, pool] of server.getAllPools()) {
    lines.push(`ipv6 dhcp pool ${name}`);
    if (pool.prefix && pool.prefixLength) {
      const lifetime = pool.validLifetime !== DEFAULT_VALID || pool.preferredLifetime !== DEFAULT_PREFERRED
        ? ` lifetime ${pool.validLifetime} ${pool.preferredLifetime}` : '';
      lines.push(` address prefix ${pool.prefix}/${pool.prefixLength}${lifetime}`);
    }
    if (pool.delegationFromLocalPool) lines.push(` prefix-delegation pool ${pool.delegationFromLocalPool}`);
    for (const fixed of pool.staticDelegations) {
      const iaid = fixed.iaid === null ? '' : ` iaid ${fixed.iaid}`;
      lines.push(` prefix-delegation ${fixed.prefix}/${fixed.prefixLength} ${fixed.clientDuid.replace(/:/g, '').toUpperCase()}${iaid}`);
    }
    if (pool.informationRefreshTime === DHCPV6_IRT_INFINITY) lines.push(' information refresh infinity');
    else if (pool.informationRefreshTime !== DHCPV6_IRT_DEFAULT) {
      const days = Math.floor(pool.informationRefreshTime / 86400);
      const hours = Math.floor((pool.informationRefreshTime % 86400) / 3600);
      const minutes = Math.floor((pool.informationRefreshTime % 3600) / 60);
      lines.push(` information refresh ${days} ${hours} ${minutes}`);
    }
    for (const dns of pool.dnsServers) lines.push(` dns-server ${dns}`);
    if (pool.domainName) lines.push(` domain-name ${pool.domainName}`);
    lines.push('!');
  }
  return lines;
}

export function dhcpv6InterfaceServerLine(server: DHCPv6Server, poolName: string): string {
  const pool = server.getPool(poolName);
  const rapid = pool?.rapidCommit ? ' rapid-commit' : '';
  const preference = pool && pool.preference > 0 ? ` preference ${pool.preference}` : '';
  return ` ipv6 dhcp server ${poolName}${rapid}${preference}`;
}
