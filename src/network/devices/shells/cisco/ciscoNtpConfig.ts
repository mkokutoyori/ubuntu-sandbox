import { getNtpAgent } from '../../../equipment/RouterServiceCapabilities';

export function ntpConfigLines(device: unknown): string[] {
  const agent = getNtpAgent(device as never);
  if (!agent?.getConfig) return [];
  const cfg = agent.getConfig();
  const lines: string[] = [];
  if (cfg.authenticate) lines.push('ntp authenticate');
  for (const id of cfg.trustedKeys ?? []) lines.push(`ntp trusted-key ${id}`);
  if (cfg.sourceInterface) lines.push(`ntp source ${cfg.sourceInterface}`);
  if (cfg.serverMode) lines.push(`ntp master ${cfg.localStratum}`);
  for (const [ip, a] of cfg.associations ?? []) {
    const role = a.mode === 'symmetric-active' ? 'peer' : 'server';
    const famille = a.configuredAs === 'sntp' ? 'sntp' : 'ntp';
    const options = [
      a.keyId !== undefined ? `key ${a.keyId}` : '',
      a.prefer ? 'prefer' : '',
    ].filter(Boolean).join(' ');
    lines.push(`${famille} ${role} ${ip}${options ? ` ${options}` : ''}`);
  }
  return lines;
}
