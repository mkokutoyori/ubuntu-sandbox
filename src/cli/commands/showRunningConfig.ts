import type { CommandSpec } from '../CommandTable';

export interface RunningConfigSource {
  getRunningConfig(): string;
}

function isRunningConfigSource(device: unknown): device is RunningConfigSource {
  return typeof (device as RunningConfigSource)?.getRunningConfig === 'function';
}

export const SHOW_RUNNING_CONFIG: CommandSpec = {
  id: 'show-running-config',
  path: ['show', 'running-config'],
  description: 'Current operating configuration',
  modes: ['privileged'],
  minPrivilege: 15,
  run: (session) => {
    if (!isRunningConfigSource(session.device)) return '';

    const body = session.device.getRunningConfig();
    return [
      'Building configuration...',
      '',
      `Current configuration : ${body.length} bytes`,
      body,
    ].join('\n');
  },
};
