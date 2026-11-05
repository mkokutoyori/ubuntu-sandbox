import type { Equipment } from '@/network';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

export interface LabCheck {
  readonly id: string;
  readonly device: string;
  readonly shell: 'bash' | 'powershell';
  readonly command: string;
  readonly expects: readonly RegExp[];
  readonly lesson: string;
}

export interface LabCheckResult {
  readonly check: LabCheck;
  readonly output: string;
  readonly missing: readonly RegExp[];
}

export async function runChecks(
  checks: readonly LabCheck[],
  devices: ReadonlyMap<string, Equipment>,
): Promise<LabCheckResult[]> {
  const shells = new Map<string, (line: string) => Promise<string>>();
  const powershellOf = (name: string): ((line: string) => Promise<string>) => {
    let run = shells.get(name);
    if (run === undefined) {
      const shell = PowerShellSubShell.create(devices.get(name) as never).subShell;
      run = async (line) => (await shell.processLine(line)).output.join('\n');
      shells.set(name, run);
    }
    return run;
  };
  const results: LabCheckResult[] = [];
  for (const check of checks) {
    const device = devices.get(check.device);
    const output = device === undefined
      ? `missing device ${check.device}`
      : check.shell === 'bash' ? await device.executeCommand(check.command) : await powershellOf(check.device)(check.command);
    results.push({ check, output, missing: check.expects.filter((expected) => !expected.test(output)) });
  }
  return results;
}
