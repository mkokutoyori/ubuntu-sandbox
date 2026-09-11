import { describe, it } from 'vitest';
import { writeFileSync } from 'fs';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
const L: string[] = [];
describe('m', () => {
  it('dump', async () => {
    for (const [nom, d] of [['S', new CiscoSwitch('switch-cisco', 'S1', 8, 0, 0)],
      ['R', new CiscoRouter('R1', 0, 0)]] as const) {
      d.powerOn();
      await d.executeCommand('enable');
      await d.executeCommand('configure terminal');
      await d.executeCommand('archive');
      const sh = (d as unknown as { getShell(): unknown }).getShell() as { mode: string };
      L.push(`${nom}: mode=${sh.mode} invite=${d.getPrompt()}`);
      L.push(`${nom}: "path flash:x" => ${JSON.stringify(await d.executeCommand('path flash:x'))}`);
      L.push(`${nom}: "?" =\n${d.cliHelp('')}`);
    }
    writeFileSync(process.env.SCRATCH + '/m.txt', L.join('\n'));
  }, 120000);
});
