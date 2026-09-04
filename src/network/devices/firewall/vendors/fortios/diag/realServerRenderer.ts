import type { RealServerView } from '../../../nat/RealServerPool';

export interface VirtualServerView {
  readonly name: string;
  readonly servers: readonly RealServerView[];
}

export interface RealServerContext {
  readonly vdom: string;
}

function statusOf(view: RealServerView): string {
  return `${view.server.enabled ? 1 : 0}/${view.healthy ? 1 : 0}`;
}

export function renderRealServers(
  servers: readonly VirtualServerView[], context: RealServerContext,
): string {
  const lines: string[] = [];
  let index = 0;

  for (const virtual of servers) {
    index++;
    for (const view of virtual.servers) {
      const stats = view.stats;
      lines.push(`vd ${context.vdom}/0 vs ${virtual.name}/${index}`
        + ` addr ${view.server.address}:${view.server.port} status ${statusOf(view)}`);
      lines.push(`conn: max ${view.server.maxConnections} active ${view.active}`
        + ` attempts ${stats.attempts} success ${stats.success}`
        + ` drop ${stats.drop} fail ${stats.fail}`);
    }
  }

  return lines.join('\n');
}
