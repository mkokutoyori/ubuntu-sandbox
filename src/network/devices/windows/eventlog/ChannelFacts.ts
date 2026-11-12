const SYSTEM_ISOLATED = new Map([['system', 'System'], ['security', 'Custom']]);

const CHANNEL_TYPES: ReadonlyMap<string, string> = new Map([
  ['operational', 'Operational'], ['analytic', 'Analytic'], ['analytical', 'Analytic'], ['debug', 'Debug'],
]);

export function channelType(logName: string): string {
  return CHANNEL_TYPES.get(logName.slice(logName.lastIndexOf('/') + 1).toLowerCase()) ?? 'Admin';
}

export function isolationOf(logName: string, configured: string): string {
  if (configured !== 'Application') return configured[0].toUpperCase() + configured.slice(1).toLowerCase();
  return SYSTEM_ISOLATED.get(logName.toLowerCase()) ?? 'Application';
}
