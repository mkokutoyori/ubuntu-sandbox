import type { Equipment } from '@/network';
import { ReactiveRmanSubShell } from '../subshells/rman/ReactiveRmanSubShell';
import { getOracleDatabase } from '@/terminal/commands/database';
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
  session.setRecoveryRunner({
    recover(rmanStatement: string): string[] {
      const { subShell } = ReactiveRmanSubShell.create(device, ['target', '/']);
      const result = subShell.processLine(rmanStatement);
      subShell.dispose();
      const text = result.output.join('\n');
      if (/media recovery complete|Finished recover/i.test(text)) {
        if (/\bUNTIL\b/i.test(rmanStatement)) getOracleDatabase(device.getId())?.instance.markIncompleteRecovery();
        return ['Media recovery complete.'];
      }
      const oracleErrors = result.output.filter((line) => /^ORA-\d{5}/.test(line.trim()));
      return oracleErrors.length > 0 ? oracleErrors : ['ORA-00283: recovery session canceled due to errors', ...result.output.filter((line) => /RMAN-\d{5}/.test(line)).slice(-1)];
    },
  });
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
