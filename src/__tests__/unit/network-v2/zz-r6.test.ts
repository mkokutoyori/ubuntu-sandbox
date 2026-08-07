import { describe, it } from 'vitest';
import { writeFileSync } from 'fs';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

const out: string[] = [];
async function run(r: CiscoRouter, c: string[]) { for (const x of c) await r.executeCommand(x); }

describe('probe R6c', () => {
  it('ipv6 dans la running-config, et la section', async () => {
    const a = new CiscoRouter('TA');
    await run(a, ['enable', 'configure terminal', 'interface GigabitEthernet0/1',
      'ipv6 address fe80::1 link-local', 'ipv6 address 2001:db8::1/64', 'ipv6 enable',
      'ip address 10.9.9.1 255.255.255.0', 'no shutdown', 'end']);
    out.push('##### show running-config (complet)');
    out.push(await a.executeCommand('show running-config'));
    out.push('\n##### show running-config interface GigabitEthernet0/1');
    out.push(await a.executeCommand('show running-config interface GigabitEthernet0/1'));
    out.push('\n##### show ipv6 interface GigabitEthernet0/1');
    out.push(await a.executeCommand('show ipv6 interface GigabitEthernet0/1'));
    writeFileSync('/tmp/claude-0/-home-user-ubuntu-sandbox/82e89d25-072f-5d61-b068-f75bfc1fdc13/scratchpad/r6c.txt', out.join('\n'));
  }, 60000);
});
