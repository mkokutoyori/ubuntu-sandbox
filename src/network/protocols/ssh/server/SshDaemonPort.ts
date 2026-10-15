import type { SshdDaemonRequest } from './SshdCommand';

export interface SshDaemonPort {
  portTaken(address: string, port: number): boolean;
  start(request: SshdDaemonRequest): number;
  logDaemon(level: 'error' | 'fatal', message: string): void;
}
