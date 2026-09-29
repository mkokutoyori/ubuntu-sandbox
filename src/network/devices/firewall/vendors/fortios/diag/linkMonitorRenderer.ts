import type { LinkMonitorStatus } from '../../../health/LinkMonitor';

export function renderLinkMonitorStatus(
  monitors: readonly LinkMonitorStatus[], only?: string,
): string {
  const shown = monitors.filter(monitor => only === undefined || monitor.name === only);
  if (shown.length === 0) return '';

  return shown.map(monitor => {
    const lines = [
      `Link Monitor: ${monitor.name}, Status: ${monitor.alive ? 'alive' : 'die'}, `
        + `Server num(${monitor.servers.length})`,
      `\tSource interface: ${monitor.srcintf || 'n/a'}`,
    ];
    for (const server of monitor.servers) {
      lines.push(`\tPeer: ${server.server}`);
      if (monitor.sourceIp !== '0.0.0.0') lines.push(`\t\tSource IP(${monitor.sourceIp})`);
      lines.push(`\t\tprotocol: ${monitor.protocol}, state: ${server.alive ? 'alive' : 'dead'}`);
      lines.push('\t\tLatency(min/max/avg): 0.000/0.000/0.000');
      lines.push('\t\tPacket lost: '
        + `${server.sent === 0 ? '0.000' : (((server.sent - server.received) / server.sent) * 100).toFixed(3)}%`);
      lines.push(`\t\tPacket sent: ${server.sent}, received: ${server.received}`);
    }
    return lines.join('\n');
  }).join('\n');
}
