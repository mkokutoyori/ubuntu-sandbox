import type { Equipment } from '@/network';
import type { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import type { HostCommandRunner } from '@/database/oracle/commands/HostCommandRunner';

export interface SyncShellHost {
  executeShellCommandSync(command: string): string;
}

export function syncShellHostOf(device: Equipment): SyncShellHost | null {
  const candidate = device as unknown as Partial<SyncShellHost>;
  return typeof candidate.executeShellCommandSync === 'function' ? (candidate as SyncShellHost) : null;
}

export function wireSqlPlusSession(device: Equipment, session: SQLPlusSession): void {
  const host = syncShellHostOf(device);
  if (host) {
    const runner: HostCommandRunner = {
      execute(command: string): string[] {
        const output = host.executeShellCommandSync(command);
        return output === '' ? [] : output.split('\n');
      },
    };
    session.setHostCommandRunner(runner);
  }
  const fsDevice = device as unknown as {
    writeFileFromEditor?: (path: string, content: string) => boolean;
    readFileForEditor?: (path: string) => string | null;
  };
  session.setFileIO({
    resolve: (path: string): string => {
      if (path.startsWith('/')) return path;
      const pwd = host?.executeShellCommandSync('pwd').trim();
      const baseDir = pwd && pwd.startsWith('/') ? pwd : '/root';
      return `${baseDir}/${path}`.replace(/\/{2,}/g, '/');
    },
    read: (path: string): string | null => fsDevice.readFileForEditor?.(path) ?? null,
    write: (path: string, content: string): boolean => fsDevice.writeFileFromEditor?.(path, content) ?? false,
  });
}
