/**
 * `aaa authentication banner|fail-message|username-prompt|password-prompt` reach a remote user
 * as bytes on a real cable: a Linux client opens a raw TCP socket to port 23 of the router through
 * a switch, answers the telnet negotiation, and reads what the router's own telnet server sends.
 * Nothing here touches the router's objects once the session is open.
 *
 * Measured on a worktree of the commit before the feature: the 3 cases that configure the commands fall (the commands
 * are rejected and the stock texts are sent); the witness (stock texts on an unconfigured router)
 * passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { connectTelnet, settle, type WireTelnet } from './_helpers/telnetWireClient';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function lab(extra: string[]): Promise<{ telnet: WireTelnet }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const router = new CiscoRouter('cisco1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(router.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.6 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret Admin@2025',
    'line vty 0 4', 'login local', 'exit',
    ...extra, 'end',
  ]) await router.executeCommand(c);
  await pc.executeCommand('ping -c 1 10.0.0.6');
  return { telnet: await connectTelnet(pc, '10.0.0.6') };
}

describe('aaa authentication messages over a real telnet session', () => {
  it('witness: an unconfigured router sends the stock header and prompts', async () => {
    const { telnet } = await lab([]);
    expect(telnet.received).toContain('User Access Verification');
    expect(telnet.received).toContain('Username:');
  });

  it('the configured header and username prompt are what arrives on the wire', async () => {
    const { telnet } = await lab([
      'aaa authentication banner ^Restricted system^',
      'aaa authentication username-prompt "Who goes there:"',
    ]);
    expect(telnet.received).toContain('Restricted system');
    expect(telnet.received).not.toContain('User Access Verification');
    expect(telnet.received).toContain('Who goes there:');
    expect(telnet.received).not.toContain('Username:');
  });

  it('the configured password prompt follows the username', async () => {
    const { telnet } = await lab(['aaa authentication password-prompt "Secret word:"']);
    telnet.send('admin');
    await settle();
    expect(telnet.received).toContain('Secret word:');
  });

  it('a wrong password is answered with the configured failure message', async () => {
    const { telnet } = await lab(['aaa authentication fail-message ^Go away^']);
    telnet.send('admin');
    await settle();
    telnet.send('wrong');
    await settle();
    expect(telnet.received).toContain('Go away');
    expect(telnet.received).not.toContain('% Login invalid');
  });
});
