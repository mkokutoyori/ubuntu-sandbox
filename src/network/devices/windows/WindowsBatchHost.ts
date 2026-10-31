import type { BatchHost, CommandOutcome } from '@/cmd/BatchHost';
import type { WindowsFileSystem } from './WindowsFileSystem';
import { clockTimeWithCentiseconds, cmdDate } from './WinSystemCommands';
import { commandExitCode } from './cmdExitCode';
import { ERROR_PATH_NOT_FOUND } from './win32ErrorText';

export interface WindowsBatchDevice {
  fileSystem(): WindowsFileSystem;
  currentDirectory(): string;
  enterDirectory(target: string): string | null;
  directoryStack(): string[];
  captureLocation(): () => void;
  prompt(): string;
  environment(): Map<string, string>;
  setVariable(name: string, value: string): void;
  removeVariable(name: string): void;
  runSimple(line: string, stdin?: string, inScript?: boolean): Promise<{ output: string; exitCode: number | null }>;
  timeZone(): string;
  nowMs(): number;
  readInputLine?(prompt: string): Promise<string | null>;
  inputIsInteractive?(): boolean;
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
        const written = append && files.exists(absolute) ? files.appendFile(absolute, content) : files.createFile(absolute, content);
        return written.ok ? null : written.error ?? ERROR_PATH_NOT_FOUND;
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
    enterDirectory: target => device.enterDirectory(target),
    directoryStack: () => device.directoryStack(),
    captureLocation: () => device.captureLocation(),
    prompt: () => device.prompt(),
    formattedDate: () => cmdDate([], device.timeZone(), device.nowMs()),
    formattedTime: () => clockTimeWithCentiseconds(device.timeZone(), device.nowMs()),
    random: () => Math.floor(Math.random() * 32768),
    async runCommand(line, stdin, inScript): Promise<CommandOutcome> {
      const { output, exitCode } = await device.runSimple(line, stdin, inScript);
      return {
        output,
        exitCode: exitCode ?? commandExitCode(output),
        notRecognized: output.includes(NOT_RECOGNIZED),
      };
    },
    readInputLine: device.readInputLine?.bind(device),
    inputIsInteractive: device.inputIsInteractive?.bind(device),
  };
}
