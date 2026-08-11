/**
 * Revue itération 2, §3.4 et §3.5 — `show ip route <protocole>`.
 *
 * Trois défauts tenaient dans la même écriture. Le filtre ne gardait que
 * les lignes commençant par `Codes`, donc la légende ressortait tronquée
 * à sa première ligne, suivie de lignes vides. Il ne connaissait que
 * `connected` et `static` : `local`, `eigrp`, `rip` tombaient sur le
 * rendu « un préfixe précis » et répondaient `% Network not in table` —
 * le message qui dit qu'une ADRESSE est absente, là où la bonne réponse
 * à « aucune route de ce protocole » est une table vide. Et les en-têtes
 * `is subnetted`, qui structurent la sortie d'IOS, étaient jetés.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  const peer = new CiscoRouter('R2');
  r.powerOn?.(); peer.powerOn?.();
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'end']) {
    await peer.executeCommand(c);
  }
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'ip route 192.168.50.0 255.255.255.0 10.0.12.2',
    // 172.16.5.0/24 est un SOUS-RÉSEAU de 172.16.0.0/16 : c'est lui qui
    // fait paraître l'en-tête `is subnetted`, là où 192.168.50.0/24 EST
    // son propre réseau par classe et n'en porte aucun.
    'ip route 172.16.5.0 255.255.255.0 10.0.12.2', 'end']) {
    await r.executeCommand(c);
  }
  new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, peer.getPort('GigabitEthernet0/0')!);
  return r;
}

/** Les lignes de route, légende et en-tête retirés. */
function routeLines(out: string): string[] {
  const lines = out.split('\n');
  const gw = lines.findIndex((l) => l.startsWith('Gateway of last resort'));
  return lines.slice(gw + 1).filter((l) => l.trim() !== '');
}

describe('show ip route <protocole>', () => {
  it('garde la légende ENTIÈRE, pas sa première ligne', async () => {
    const r = await lab();
    const complet = await r.executeCommand('show ip route');
    for (const filtre of ['connected', 'local', 'static']) {
      const out = await r.executeCommand(`show ip route ${filtre}`);
      // La légende est celle de la table complète, mot pour mot.
      const legende = (t: string) => t.split('\n')
        .slice(0, t.split('\n').findIndex((l) => l.startsWith('Gateway of last resort')) + 1);
      expect(legende(out), filtre).toEqual(legende(complet));
    }
  }, 30_000);

  it('ne montre que le protocole demandé', async () => {
    const r = await lab();
    for (const l of routeLines(await r.executeCommand('show ip route connected'))) {
      if (/is subnetted|is variably subnetted/.test(l)) continue;
      expect(l.trimStart().startsWith('C'), l).toBe(true);
    }
    for (const l of routeLines(await r.executeCommand('show ip route local'))) {
      if (/is subnetted|is variably subnetted/.test(l)) continue;
      expect(l.trimStart().startsWith('L'), l).toBe(true);
    }
  }, 30_000);

  it('`local` existe et montre les routes locales', async () => {
    const r = await lab();
    const out = await r.executeCommand('show ip route local');
    expect(out).not.toContain('Network not in table');
    expect(out).toMatch(/L\s+10\.0\.12\.1\/32 is directly connected, GigabitEthernet0\/0/);
  }, 30_000);

  it('un protocole sans route rend une table vide, pas une erreur de préfixe', async () => {
    const r = await lab();
    for (const proto of ['eigrp', 'rip', 'bgp']) {
      const out = await r.executeCommand(`show ip route ${proto}`);
      // `% Network not in table` répond à « ce préfixe-là », pas à
      // « ce protocole-là » : le confondre envoie chercher un préfixe.
      expect(out, proto).not.toContain('Network not in table');
      expect(routeLines(out), proto).toEqual([]);
    }
  }, 30_000);

  it("conserve les en-têtes `is subnetted` qui structurent la sortie", async () => {
    const r = await lab();
    const out = await r.executeCommand('show ip route static');
    expect(out).toMatch(/172\.16\.0\.0\/16 is subnetted, 1 subnets/);
    expect(out).toMatch(/S {8}172\.16\.5\.0\/24 \[1\/0\] via 10\.0\.12\.2/);
    // Et une route qui EST son réseau par classe n'en porte pas :
    // l'en-tête décrit un découpage, il ne décore pas la sortie.
    expect(out).toMatch(/S {4}192\.168\.50\.0\/24 \[1\/0\] via 10\.0\.12\.2/);
    expect(out).not.toMatch(/192\.168\.50\.0\/24 is subnetted/);
  }, 30_000);

  it("un préfixe précis garde son propre message d'absence", async () => {
    const r = await lab();
    // La refonte du filtre ne doit pas avaler la commande voisine.
    expect(await r.executeCommand('show ip route 172.31.99.0'))
      .toContain('Network not in table');
  }, 30_000);
});

/**
 * Revue §3.5 — les deux voisins de la même famille : la table IPv6
 * filtrée par protocole, et un process-id OSPF qui n'existe pas.
 */
describe('show ipv6 route <protocole>', () => {
  async function v6Lab(): Promise<CiscoRouter> {
    const r = new CiscoRouter('R6');
    r.powerOn?.();
    for (const c of ['enable', 'configure terminal', 'ipv6 unicast-routing',
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8::1/64', 'no shutdown', 'exit',
      'ipv6 route 2001:db8:50::/64 2001:db8::2', 'end']) {
      await r.executeCommand(c);
    }
    return r;
  }

  it('`static` filtre la table, il ne désigne pas une destination', async () => {
    const r = await v6Lab();
    const out = await r.executeCommand('show ipv6 route static');
    // Le rendu cherchait une destination NOMMÉE « static ».
    expect(out).not.toContain('% Route to static');
    expect(out).toMatch(/S\s+2001:db8:50::\/64/);
  }, 30_000);

  it('une vraie destination absente garde son message', async () => {
    const r = await v6Lab();
    expect(await r.executeCommand('show ipv6 route 2001:db8:99::/64'))
      .toContain('% Route to');
  }, 30_000);
});

describe('show ip ospf <process-id>', () => {
  it("ne répond rien pour un processus qui n'existe pas", async () => {
    const r = new CiscoRouter('R7');
    r.powerOn?.();
    for (const c of ['enable', 'configure terminal', 'router ospf 1',
      'network 10.0.0.0 0.0.0.255 area 0', 'exit', 'end']) {
      await r.executeCommand(c);
    }
    // Montrer le processus VOISIN laisse croire que le 99 existe.
    expect((await r.executeCommand('show ip ospf 99')).trim()).toBe('');
    expect(await r.executeCommand('show ip ospf 1')).toContain('Routing Process "ospf 1"');
    expect(await r.executeCommand('show ip ospf')).toContain('Routing Process "ospf 1"');
  }, 30_000);
});
