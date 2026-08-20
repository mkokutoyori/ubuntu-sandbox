import type { Firewall } from '../../../Firewall';

export function renderNtpStatus(fw: Firewall): string {
  const agent = fw.getNtpAgent();
  const settings = fw.getNtp().getSettings();
  const config = agent.getConfig();

  const head = `synchronized: ${agent.isSynced() ? 'yes' : 'no'},`
    + ` ntpsync: ${settings.enabled ? 'enabled' : 'disabled'},`
    + ` server-mode: ${config.serverMode ? 'enabled' : 'disabled'}`;

  const lines: string[] = [head, ''];
  for (const server of settings.servers) {
    const association = agent.getAssociation(server);
    const reach = association?.reach ?? 0;
    const state = reach === 0
      ? '-- Unreachable'
      : `-- reachable(0x${reach.toString(16).padStart(2, '0')})`;
    lines.push(`ipv4 server(${server}) ${state}`);
    lines.push(`server-version=4, stratum=${association?.stratum ?? 16}`);
    if (association && reach !== 0) {
      lines.push(`clock offset is ${(association.offsetMs / 1000).toFixed(6)} sec,`
        + ` root delay is ${(association.delayMs / 1000).toFixed(6)} sec`);
    }
    lines.push('');
  }
  if (settings.servers.length === 0) lines.push('no NTP server configured');
  return lines.join('\n').trimEnd();
}
