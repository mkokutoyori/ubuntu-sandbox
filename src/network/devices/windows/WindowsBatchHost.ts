import type { BatchHost, CommandOutcome } from '@/cmd/BatchHost';
import type { WindowsFileSystem } from './WindowsFileSystem';
import { clockTimeWithCentiseconds, cmdDate } from './WinSystemCommands';
import { commandExitCode } from './cmdExitCode';

export interface WindowsBatchDevice {
  fileSystem(): WindowsFileSystem;
  currentDirectory(): string;
  changeDirectory(path: string): void;
  environment(): Map<string, string>;
  setVariable(name: string, value: string): void;
  removeVariable(name: string): void;
  runSimple(line: string, stdin?: string): Promise<string>;
  timeZone(): string;
  readInputLine?(prompt: string): Promise<string | null>;
}

const NOT_RECOGNIZED = 'is not recognized as an internal or external command';

export function createWindowsBatchHost(device: WindowsBatchDevice): BatchHost {
  return {
    env: {
      get: name => {
        const value = device.environment().get(name.toUpperCase());
        return value === '' ? undefined : value;
      },
      set: (name, value) => device.setVariable(name, value),
      unset: name => {
        device.removeVariable(name);
        if (device.environment().has(name.toUpperCase())) device.setVariable(name, '');
      },
      names: () => [...device.environment()].filter(([, value]) => value !== '').map(([name]) => name),
    },
    fs: {
      normalize: (path, base) => device.fileSystem().normalizePath(path, base),
      exists: absolute => device.fileSystem().exists(absolute),
      isDirectory: absolute => device.fileSystem().isDirectory(absolute),
      read: absolute => {
        const result = device.fileSystem().readFile(absolute);
        return result.ok ? result.content ?? '' : null;
      },
      write: (absolute, content, append) => {
        const files = device.fileSystem();
        return (append && files.exists(absolute) ? files.appendFile(absolute, content) : files.createFile(absolute, content)).ok;
      },
      list: absolute => device.fileSystem().listDirectory(absolute).map(({ name, entry }) => ({
        name,
        isDirectory: entry.type === 'directory',
        size: entry.size,
        written: entry.mtime,
        attributes: entry.attributes,
      })),
    },
    cwd: () => device.currentDirectory(),
    setCwd: absolute => device.changeDirectory(absolute),
    formattedDate: () => cmdDate([], device.timeZone()),
    formattedTime: () => clockTimeWithCentiseconds(device.timeZone()),
    random: () => Math.floor(Math.random() * 32768),
    async runCommand(line, stdin): Promise<CommandOutcome> {
      const output = await device.runSimple(line, stdin);
      return {
        output,
        exitCode: commandExitCode(output),
        notRecognized: output.includes(NOT_RECOGNIZED),
      };
    },
    readInputLine: device.readInputLine?.bind(device),
  };
}
