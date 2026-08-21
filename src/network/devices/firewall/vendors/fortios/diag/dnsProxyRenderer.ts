import type { Firewall } from '../../../Firewall';

export function renderDnsProxy(fw: Firewall, vdom: string): string {
  const settings = fw.getDnsClient().getSettings();
  const servers = [settings.primary, settings.secondary]
    .filter(server => server.length > 0 && server !== '0.0.0.0');

  const lines = [
    'worker idx: 0',
    `vfid=0 name=${vdom}, dns_log=1, tls=0`,
    'dns_server:',
  ];
  for (const server of servers) {
    lines.push(`  vfid=0, ip=${server}, port=53, prob=0, cur_req=0,`
      + ' req=0, to=0, res=0, rt=0, ready=1, timer=0, probe_timer=0');
  }
  if (servers.length === 0) lines.push('  no DNS server configured');

  lines.push('dns_server_zone:');
  for (const zone of fw.getDnsServer().listZones()) {
    lines.push(`  vfid=0, name=${zone.name}, domain=${zone.domain},`
      + ` entries=${zone.entries.length}`);
  }
  return lines.join('\n');
}
