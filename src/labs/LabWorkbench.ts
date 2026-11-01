import { useNetworkStore } from '@/store/networkStore';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { DeviceType, Equipment } from '@/network';

export interface LabStep {
  readonly device: string;
  readonly command: string;
  readonly output: string;
}

const HEREDOC_DELIMITER = 'LAB_EOF';

export class LabWorkbench {
  readonly transcript: LabStep[] = [];
  private readonly powershells = new WeakMap<Equipment, ReturnType<typeof PowerShellSubShell.create>['subShell']>();

  place(type: DeviceType, name: string, x: number, y: number): Equipment {
    const store = useNetworkStore.getState();
    const added = store.addDevice(type, x, y);
    store.updateDevice(added.id, { name, hostname: name });
    return useNetworkStore.getState().deviceInstances.get(added.id)!;
  }

  connect(first: Equipment, firstPort: string, second: Equipment, secondPort: string): void {
    const connection = useNetworkStore.getState().addConnection(first.getId(), firstPort, second.getId(), secondPort);
    if (connection === null) {
      throw new Error(`cannot cable ${first.getName()} ${firstPort} to ${second.getName()} ${secondPort}`);
    }
  }

  async shell(device: Equipment, ...lines: string[]): Promise<string> {
    const outputs: string[] = [];
    for (const line of lines) {
      const output = await device.executeCommand(line);
      this.transcript.push({ device: device.getName(), command: line, output });
      outputs.push(output);
    }
    return outputs.join('\n');
  }

  async powershell(device: Equipment, ...lines: string[]): Promise<string> {
    const outputs: string[] = [];
    for (const line of lines) {
      const output = (await this.subShellOf(device).processLine(line)).output.join('\n');
      this.transcript.push({ device: device.getName(), command: line, output });
      outputs.push(output);
    }
    return outputs.join('\n');
  }

  async writeFile(device: Equipment, path: string, body: string, mode = '644'): Promise<void> {
    await this.shell(device, `sudo tee ${path} >/dev/null <<'${HEREDOC_DELIMITER}'\n${body}\n${HEREDOC_DELIMITER}`);
    await this.shell(device, `sudo chmod ${mode} ${path}`);
  }

  private subShellOf(device: Equipment): ReturnType<typeof PowerShellSubShell.create>['subShell'] {
    let subShell = this.powershells.get(device);
    if (subShell === undefined) {
      subShell = PowerShellSubShell.create(device as never).subShell;
      this.powershells.set(device, subShell);
    }
    return subShell;
  }
}
