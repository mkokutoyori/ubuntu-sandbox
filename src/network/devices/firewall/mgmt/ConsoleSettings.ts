export type ConsoleOutputMode = 'standard' | 'more';
export type ConsoleMode = 'batch' | 'line';

export interface ConsoleSettingsPatch {
  readonly output?: ConsoleOutputMode;
  readonly mode?: ConsoleMode;
  readonly baudrate?: number;
  readonly login?: boolean;
}

export const CONSOLE_BAUD_RATES: readonly number[] =
  Object.freeze([9600, 19200, 38400, 57600, 115200]);

export class ConsoleSettings {
  private output: ConsoleOutputMode = 'more';
  private mode: ConsoleMode = 'line';
  private baudrate = 9600;
  private login = true;

  apply(patch: ConsoleSettingsPatch): void {
    if (patch.output !== undefined) this.output = patch.output;
    if (patch.mode !== undefined) this.mode = patch.mode;
    if (patch.baudrate !== undefined) this.baudrate = patch.baudrate;
    if (patch.login !== undefined) this.login = patch.login;
  }

  pagesOutput(): boolean { return this.output === 'more'; }

  requiresLogin(): boolean { return this.login; }

  current(): Required<ConsoleSettingsPatch> {
    return {
      output: this.output, mode: this.mode,
      baudrate: this.baudrate, login: this.login,
    };
  }
}
