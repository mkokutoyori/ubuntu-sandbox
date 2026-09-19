/**
 * Sonde — un commutateur acceptait toute la configuration SSH et
 * n'ecoutait jamais.
 *
 * Mesure AVANT, sur un Catalyst cable a un `LinuxPC` :
 *
 *   hostname / ip domain-name            -> acceptes
 *   username admin privilege 15 secret … -> accepte
 *   line vty 0 4 / login local
 *     / transport input ssh              -> acceptes
 *   crypto key generate rsa modulus 2048 -> "[OK] (elapsed time was 2
 *                                            seconds)", et `hasRsaKeys()'
 *                                            passe bien a vrai
 *   ssh admin@10.0.0.2 "show version"    -> "Connection refused"
 *
 * Tout est saisi, tout est range, tout se re-affiche -- et rien n'ecoute
 * sur le port 22, ni avant ni apres la generation de la cle. C'est la
 * forme exacte que la regle 6 nomme : un critere accepte et rendu, dont
 * le moteur ne fait rien.
 *
 * QUATRE cas sur sept tombent avant la correction. Les TROIS autres sont
 * NOMMES :
 *
 *   - sans cle RSA, `ssh' est refuse : TEMOIN, et c'est deja le bon
 *     comportement. Il prouve que le refus mesure plus haut n'est pas un
 *     cable debranche, et il doit le rester APRES la correction : un
 *     commutateur sans cle n'a pas de serveur SSH.
 *   - `telnet' continue de fonctionner : NON-REGRESSION du lot
 *     precedent.
 *   - le ping vers le SVI repond toujours : NON-REGRESSION.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');
const SWITCH_IP = '10.0.0.2';

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function buildLan(withKeys: boolean): Promise<{ pc: LinuxPC; sw: CiscoSwitch }> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  const lines = [
    'enable', 'configure terminal',
    'hostname SW1', 'ip domain-name lab.local',
    'interface Vlan1', `ip address ${SWITCH_IP} 255.255.255.0`, 'no shutdown', 'exit',
    'username admin privilege 15 secret cisco',
    'line vty 0 4', 'login local', 'transport input all', 'password cisco', 'exit',
  ];
  if (withKeys) lines.push('crypto key generate rsa modulus 2048');
  lines.push('end');
  for (const l of lines) await sw.executeCommand(l);
  await settle();
  return { pc, sw };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('un commutateur repond vraiment en SSH', () => {
  it('temoin : sans cle RSA, ssh reste refuse', async () => {
    const { pc } = await buildLan(false);
    expect(await pc.executeCommand(`ssh admin@${SWITCH_IP} "show version"`, 'cisco\n'))
      .toContain('Connection refused');
  }, 30000);

  it('non-regression : le ping vers le SVI repond toujours', async () => {
    const { pc } = await buildLan(true);
    expect(await pc.executeCommand(`ping -c 1 ${SWITCH_IP}`)).toMatch(/1 (packets )?received|bytes from/);
  }, 30000);

  it('non-regression : telnet fonctionne toujours', async () => {
    const { pc } = await buildLan(true);
    expect(await pc.executeCommand(`telnet ${SWITCH_IP}`, 'admin\ncisco\nexit\n'))
      .toContain('Connected to');
  }, 30000);

  it('la generation de la cle ouvre le port 22', async () => {
    const { sw } = await buildLan(true);
    const stack = (sw as unknown as { getTcpStack(): { listListeners(): Array<{ localPort: number }> } }).getTcpStack();
    expect(stack.listListeners().some((l) => l.localPort === 22)).toBe(true);
  }, 30000);

  it('ssh rend la sortie du PROPRE shell du commutateur', async () => {
    const { pc } = await buildLan(true);
    const out = await pc.executeCommand(`ssh admin@${SWITCH_IP} "show version"`, 'cisco\n');
    expect(out).toContain('Cisco IOS Software');
  }, 30000);

  it('un mauvais mot de passe est refuse', async () => {
    const { pc } = await buildLan(true);
    const out = await pc.executeCommand(`ssh admin@${SWITCH_IP} "show version"`, 'WRONG\n');
    expect(out).not.toContain('Cisco IOS Software');
    expect(out).toMatch(/Permission denied|denied/i);
  }, 30000);

  it('la session ssh est comptee dans le registre du commutateur', async () => {
    const { pc, sw } = await buildLan(true);
    await pc.executeCommand(`ssh admin@${SWITCH_IP} "show version"`, 'cisco\n');
    const seen = (sw as unknown as {
      getSshSessionRegistry(): { recent?: (n: number) => unknown[]; list(): unknown[] };
    }).getSshSessionRegistry();
    expect((seen.recent?.(10) ?? seen.list()).length).toBeGreaterThan(0);
  }, 30000);
});
