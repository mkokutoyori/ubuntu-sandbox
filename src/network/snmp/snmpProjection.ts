import type { SnmpService } from '../devices/router/management/SnmpService';
import type { SnmpAgent } from './SnmpAgent';

export function projectSnmpServiceOntoAgent(service: SnmpService, agent: SnmpAgent): void {
  agent.setContact(service.getContact());
  agent.setLocation(service.getLocation());
  agent.setTrapSourceInterface(service.getTrapSource() || null);

  const config = agent.getConfig();
  const communities = service.getCommunities();
  const names = new Set(communities.map((c) => c.name));
  for (const c of [...config.communities]) {
    if (!names.has(c.community)) agent.removeCommunity(c.community);
  }
  for (const c of communities) agent.addCommunity(c.name, c.access, c.aclName);

  const hosts = service.getHosts();
  const addresses = new Set(hosts.map((h) => h.host));
  for (const h of [...config.trapHosts]) {
    if (!addresses.has(h.ip)) agent.removeTrapHost(h.ip);
  }
  for (const h of hosts) agent.addTrapHost(h.host, h.community, h.udpPort);
}
