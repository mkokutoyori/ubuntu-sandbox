import { confBoolean, type ConfSection } from './FreeradiusConf';

export interface RadiusdSecurityConfig {
  statusServer: boolean;
}

export function readRadiusdSecurityConfig(root: ConfSection): RadiusdSecurityConfig | { error: string } {
  const config: RadiusdSecurityConfig = { statusServer: true };
  const section = root.sections.find((candidate) => candidate.name1 === 'security');
  for (const pair of section?.pairs ?? []) {
    if (pair.name !== 'status_server') continue;
    const value = confBoolean(pair);
    if (typeof value === 'object') return value;
    config.statusServer = value;
  }
  return config;
}
