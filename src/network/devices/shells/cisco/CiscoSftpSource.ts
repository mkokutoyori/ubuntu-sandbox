import type { RouterSftpSource } from '../../../protocols/ssh/sftp/RouterSftpFileSystem';
import type { CiscoFileSystem } from './CiscoFileSystem';

export interface CiscoSftpHost {
  scpServerEnabled(): boolean;
  flash(): CiscoFileSystem;
  runningConfig(): string;
}

const CONFIG_NAMES = /^(running-config|startup-config|system:running-config|nvram:startup-config)$/i;

export function ciscoSftpSource(host: CiscoSftpHost): RouterSftpSource | null {
  if (!host.scpServerEnabled()) return null;
  const flashName = (path: string): string | null => {
    const bare = path.replace(/^\/+/, '');
    if (CONFIG_NAMES.test(bare)) return null;
    const name = bare.replace(/^flash:\/*/i, '');
    return name === '' ? null : name;
  };
  return {
    read: (path) => {
      const bare = path.replace(/^\/+/, '');
      if (CONFIG_NAMES.test(bare)) return host.runningConfig();
      const name = flashName(path);
      return name === null ? null : host.flash().read(name);
    },
    write: (path, content) => {
      const name = flashName(path);
      if (name === null) return false;
      host.flash().write(name, content);
      return true;
    },
    list: () => ['running-config', 'startup-config', ...host.flash().list().filter((f) => !f.directory).map((f) => f.name)],
  };
}
