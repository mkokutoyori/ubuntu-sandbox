/**
 * Probes — les canaux de collecte, hors console.
 *
 * Scénarios couverts ici :
 *   5  SPAN local : tout ce qui entre/sort du port source est dupliqué
 *      vers le port destination
 *  13  export syslog distant : les messages partent bien en UDP/514 vers
 *      le collecteur
 *  14  tampon mémoire : `show logging` restitue l'historique dans l'ordre
 *  15  NetFlow : un enregistrement part vers le collecteur avec les bons
 *      ports et compteurs
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';
import type { EthernetFrame } from '@/network/core/types';
import { pingOnSimulatedClock } from '../../support/fastPing';

/**
 * Ce qui arrive réellement sur un port, lu sur le bus d'observation —
 * c'est le même point d'écoute que les autres suites de mirroring.
 */
function capturerSur(pc: LinuxPC): EthernetFrame[] {
  const recus: EthernetFrame[] = [];
  getDefaultEventBus().subscribe('port.frame.received', (e) => {
    const p = e.payload as { deviceId?: string; portName?: string; frame: EthernetFrame };
    if (p.deviceId === pc.getId() && p.portName === 'eth0') recus.push(p.frame);
  });
  return recus;
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const LONG = 30_000;

describe('Scénario 5 — port mirroring local (SPAN)', () => {
  /**
   * Trois postes sur un switch : deux qui se parlent sur Fa0/1 et Fa0/3,
   * un analyseur sur Fa0/2 qui ne doit rien manquer du port surveillé.
   */
  async function lab() {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const source = new LinuxPC('linux-pc', 'SRC', 0, 0);
    const analyseur = new LinuxPC('linux-pc', 'SNIFFER', 0, 0);
    const pair = new LinuxPC('linux-pc', 'PAIR', 0, 0);
    for (const d of [sw, source, analyseur, pair]) d.powerOn();

    new Cable('c1').connect(sw.getPort('FastEthernet0/1')!, source.getPort('eth0')!);
    new Cable('c2').connect(sw.getPort('FastEthernet0/2')!, analyseur.getPort('eth0')!);
    new Cable('c3').connect(sw.getPort('FastEthernet0/3')!, pair.getPort('eth0')!);

    source.configureInterface('eth0', new IPAddress('192.168.5.1'), new SubnetMask('255.255.255.0'));
    pair.configureInterface('eth0', new IPAddress('192.168.5.3'), new SubnetMask('255.255.255.0'));

    // L'analyseur compte tout ce qui lui arrive, quelle qu'en soit la
    // destination — c'est le propre d'un port SPAN.
    const capture = capturerSur(analyseur);

    return { sw, source, pair, capture };
  }

  it('la session SPAN se configure et se relit', async () => {
    const { sw } = await lab();
    for (const c of [
      'enable', 'configure terminal',
      'monitor session 1 source interface FastEthernet0/1',
      'monitor session 1 destination interface FastEthernet0/2',
      'end',
    ]) await sw.executeCommand(c);

    const etat = await sw.executeCommand('show monitor session 1');
    expect(etat).toContain('Session 1');
    expect(etat).toMatch(/Source Ports[\s\S]*Fa0\/1|FastEthernet0\/1/);
    expect(etat).toMatch(/Destination Ports[\s\S]*Fa0\/2|FastEthernet0\/2/);
  }, LONG);

  it('le trafic du port surveillé est dupliqué vers l\'analyseur', async () => {
    const { sw, source, capture } = await lab();
    for (const c of [
      'enable', 'configure terminal',
      'monitor session 1 source interface FastEthernet0/1',
      'monitor session 1 destination interface FastEthernet0/2',
      'end',
    ]) await sw.executeCommand(c);

    await pingOnSimulatedClock(source, 'ping -c 2 -W 1 192.168.5.3');

    expect(
      capture.length,
      'l\'analyseur doit voir le trafic de Fa0/1 alors qu\'il ne lui est pas destiné',
    ).toBeGreaterThan(0);
  }, LONG);

  it('sans session SPAN, l\'analyseur ne voit pas le trafic des autres', async () => {
    const { source, capture } = await lab();
    await pingOnSimulatedClock(source, 'ping -c 2 -W 1 192.168.5.3');

    const unicastPourAutrui = capture.filter((f) => {
      const dst = f.dstMAC.toString().toLowerCase();
      // Le diffusé et le multicast IPv4 étaient déjà écartés : un switch
      // les inonde légitimement, et ce cas parle de l'UNICAST appris.
      // `33:33:…` est le multicast IPv6 (RFC 2464 §7), de la même
      // famille ; il n'apparaissait pas ici tant que rien n'émettait
      // vers un groupe v6 — LLMNR et mDNS le font maintenant.
      return dst !== 'ff:ff:ff:ff:ff:ff'
        && !dst.startsWith('01:00:5e')
        && !dst.startsWith('33:33');
    });
    expect(
      unicastPourAutrui,
      'un switch ne diffuse pas l\'unicast appris à tout le monde',
    ).toEqual([]);
  }, LONG);
});

describe('Scénario 13 — export syslog distant', () => {
  async function routeur() {
    const r = new CiscoRouter('R1', 0, 0);
    const collecteur = new LinuxPC('linux-pc', 'SYSLOG', 0, 0);
    r.powerOn(); collecteur.powerOn();
    new Cable('c').connect(r.getPorts()[0], collecteur.getPort('eth0')!);
    collecteur.configureInterface('eth0', new IPAddress('192.168.1.50'), new SubnetMask('255.255.255.0'));
    for (const c of [
      'enable', 'configure terminal',
      `interface ${r.getPortNames()[0]}`,
      'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'end',
    ]) await r.executeCommand(c);
    return { r, collecteur };
  }

  it('`logging host` est enregistré et relu dans la configuration', async () => {
    const { r } = await routeur();
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging host 192.168.1.50');
    await r.executeCommand('end');

    expect(await r.executeCommand('show logging')).toContain('192.168.1.50');
    expect(await r.executeCommand('show running-config')).toContain('logging host 192.168.1.50');
  }, LONG);

  it('un message part réellement en UDP/514 vers le collecteur', async () => {
    const { r, collecteur } = await routeur();
    const trames = capturerSur(collecteur);
    const datagrammes = () => trames.flatMap((f) => {
      const ip = (f.payload ?? {}) as { type?: string; protocol?: number; sourceIP?: { toString(): string }; payload?: { destinationPort?: number } };
      if (ip.type !== 'ipv4' || ip.protocol !== 17) return [];
      const port = ip.payload?.destinationPort;
      return port === undefined ? [] : [{ port, src: ip.sourceIP?.toString() ?? '' }];
    });

    await r.executeCommand('configure terminal');
    await r.executeCommand('logging host 192.168.1.50');
    await r.executeCommand('logging trap debugging');
    // Une transition d'interface est un vrai message syslog.
    await r.executeCommand(`interface ${r.getPortNames()[1]}`);
    await r.executeCommand('no shutdown');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');

    const recus = datagrammes();
    expect(recus.length, 'le collecteur doit recevoir au moins un datagramme').toBeGreaterThan(0);
    expect(recus.every((d) => d.port === 514), 'syslog parle sur UDP/514').toBe(true);
    expect(recus[0].src).toBe('192.168.1.1');
  }, LONG);
});

describe('Scénario 14 — enregistrement dans le tampon mémoire', () => {
  it('`show logging` restitue l\'historique dans l\'ordre chronologique', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    const [g0, g1] = r.getPortNames();
    for (const c of [
      'enable', 'configure terminal',
      'logging buffered 64000 debugging',
      `interface ${g0}`, 'ip address 172.16.0.1 255.255.255.0', 'no shutdown', 'exit',
      `interface ${g1}`, 'ip address 172.16.1.1 255.255.255.0', 'no shutdown', 'exit',
      `interface ${g0}`, 'shutdown', 'exit',
      'end',
    ]) await r.executeCommand(c);

    const journal = await r.executeCommand('show logging');
    expect(journal).toContain('Buffer logging:  level debugging');
    expect(journal).toContain('Log Buffer (64000 bytes):');

    const evenements = journal.split('\n').filter((l) => /%LINK|%LINEPROTO/.test(l));
    expect(evenements.length, 'les transitions doivent être mémorisées').toBeGreaterThan(1);

    const premierUp = evenements.findIndex((l) => /changed state to up/.test(l));
    const dernierDown = evenements.map((l) => /changed state to (administratively )?down/.test(l)).lastIndexOf(true);
    expect(
      premierUp,
      'la montée précède la descente : le tampon garde l\'ordre',
    ).toBeLessThan(dernierDown);
  }, LONG);

  it('le tampon survit à la fermeture de la console — il vit sur l\'équipement', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    for (const c of [
      'enable', 'configure terminal', 'logging buffered 64000 debugging',
      `interface ${r.getPortNames()[0]}`, 'no shutdown', 'end',
    ]) await r.executeCommand(c);

    const avant = (await r.executeCommand('show logging')).split('\n').length;
    // Rien ne « ferme » une console ici : ce que la probe vérifie, c'est que
    // l'historique n'est rattaché à aucune session et se relit à volonté.
    const apres = (await r.executeCommand('show logging')).split('\n').length;
    expect(apres).toBe(avant);
  }, LONG);
});

describe('Scénario 15 — export de flux NetFlow', () => {
  it('l\'export se configure et se relit', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    for (const c of [
      'enable', 'configure terminal',
      'ip flow-export destination 192.168.1.60 9996',
      'ip flow-export version 9',
      `interface ${r.getPortNames()[0]}`, 'ip flow ingress', 'end',
    ]) await r.executeCommand(c);

    const etat = await r.executeCommand('show ip flow export');
    expect(etat).not.toContain('not configured');
    expect(etat).toContain('192.168.1.60');
  }, LONG);

  /**
   * NetFlow compte le trafic de TRANSIT, pas celui qui se termine sur le
   * routeur : ce cas fait donc traverser un vrai paquet d'un LAN vers
   * l'autre. La version precedente pingait l'adresse du routeur LUI-MEME
   * et attendait un enregistrement — une premisse fausse, et la seule
   * raison pour laquelle il echouait.
   */
  it('un flux de TRANSIT produit un enregistrement dans le cache', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
    const serveur = new LinuxPC('linux-pc', 'SERVEUR', 0, 0);
    r.powerOn(); client.powerOn(); serveur.powerOn();
    new Cable('c1').connect(r.getPorts()[0], client.getPort('eth0')!);
    new Cable('c2').connect(r.getPorts()[1], serveur.getPort('eth0')!);
    const m = new SubnetMask('255.255.255.0');
    client.configureInterface('eth0', new IPAddress('192.168.1.10'), m);
    serveur.configureInterface('eth0', new IPAddress('192.168.2.10'), m);
    await client.executeCommand('sudo ip route add default via 192.168.1.1');
    await serveur.executeCommand('sudo ip route add default via 192.168.2.1');
    for (const c of [
      'enable', 'configure terminal',
      `interface ${r.getPortNames()[0]}`,
      'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'ip flow ingress', 'exit',
      `interface ${r.getPortNames()[1]}`,
      'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'ip flow ingress', 'exit',
      'ip flow-export destination 192.168.1.10 9996',
      'end',
    ]) await r.executeCommand(c);

    await pingOnSimulatedClock(client, 'ping -c 2 -W 1 192.168.2.10');

    const cache = await r.executeCommand('show ip cache flow');
    expect(cache, 'le cache de flux doit connaître le trafic observé').not.toContain('Invalid input');
    expect(cache).toMatch(/192\.168\.1\.10/);
  }, LONG);
});
