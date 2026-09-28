/*
 * Un serveur DHCP IOS offrait une adresse OCCUPEE des que plus de quatre
 * adresses du pool l'etaient deja devant elle.
 *
 * Mesure de depart, sur la topologie de l'utilisateur rechargee
 * (`lan_with_firewall_fortigate.topology (1).json`) : R3 sert le pool HQ
 * 192.168.30.0/24 ; .2, .3, .4 et .5 repondent, et PC3 tient .6. R4
 * demande une adresse par `ip address dhcp-alloc` :
 *
 *   show ip dhcp conflict   .2 .3 .4 .5   (detection : ping)
 *   show ip dhcp binding    192.168.30.6 -> R4      <- l'adresse de PC3
 *   Server1 : ip neigh      192.168.30.6 lladdr <MAC de R4>
 *
 * R4 detournait tout le trafic destine a PC3 : `ssh -J` vers PC3 echouait
 * en « connect failed ». La boucle de `DhcpServerExchange` ne sondait que
 * QUATRE candidats ; le cinquieme partait sans ping.
 *
 * L'AUTORITE EST CISCO (`ip dhcp ping packets`) : « by default, the Cisco
 * IOS DHCP server pings a pool address twice before assigning a
 * particular address to a requesting client » ; une reponse fait de
 * l'adresse un conflit (`show ip dhcp conflict`). Rien ne borne le nombre
 * d'adresses ecartees : chacune est sondee avant d'etre offerte, jusqu'a
 * epuisement du pool.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire la boucle.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 2 des 3 cas tombent — avant, le client recevait .6, une adresse prise,
 * et .6 n'etait pas inscrite en conflit. Le TEMOIN a deux adresses
 * occupees passe des deux cotes : il reste sous la borne de quatre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(squatters: number): Promise<{ r3: CiscoRouter; client: LinuxPC }> {
  const r3 = new CiscoRouter('R3', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 12, 0, 0);
  new Cable('c-r3').connect(r3.getPorts()[0], sw.getPorts()[0]);
  for (const c of [
    'enable', 'configure terminal',
    `interface ${r3.getPorts()[0].getName()}`, 'ip address 192.168.30.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp pool HQ', 'network 192.168.30.0 255.255.255.0', 'default-router 192.168.30.1', 'exit', 'end',
  ]) await r3.executeCommand(c);
  for (let i = 0; i < squatters; i++) {
    const host = new LinuxPC('linux-pc', `H${i}`, 0, 0);
    new Cable(`c-h${i}`).connect(host.getPorts()[0], sw.getPorts()[1 + i]);
    await host.executeCommand(`ip addr add 192.168.30.${2 + i}/24 dev eth0`);
  }
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[11]);
  return { r3, client };
}

const leased = async (client: LinuxPC): Promise<string> => {
  await client.executeCommand('sudo dhclient eth0');
  return client.getPorts()[0].getIPAddress()?.toString() ?? '';
};

describe('every candidate is probed before it is offered', () => {
  it('two addresses in use: the client gets the third — WITNESS', async () => {
    const { client } = await lab(2);

    expect(await leased(client)).toBe('192.168.30.4');
  }, 30000);

  it('five addresses in use: the client gets the sixth, never a taken one', async () => {
    const { client } = await lab(5);

    expect(await leased(client)).toBe('192.168.30.7');
  }, 30000);

  it('and every taken address is recorded as a conflict', async () => {
    const { r3, client } = await lab(5);
    await leased(client);

    const conflicts = await r3.executeCommand('show ip dhcp conflict');
    for (let i = 2; i <= 6; i++) expect(conflicts).toMatch(new RegExp(`^192\\.168\\.30\\.${i}\\s+ping`, 'm'));
  }, 30000);
});
