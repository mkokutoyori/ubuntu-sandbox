import { commandNotFoundMessage } from '@/powershell/commandNotFound';

export class NativeCommandNeedsAsync extends Error {
  readonly commandLine: string;

  constructor(command: string, args: readonly string[]) {
    super(commandNotFoundMessage(command));
    this.name = 'NativeCommandNeedsAsync';
    this.commandLine = [command, ...args].join(' ').trim();
  }
}
