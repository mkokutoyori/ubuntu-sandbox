/**
 * Probes — l'expiration par TTL du cache passif de services (RFC 6762 §10).
 *
 * C'était la dernière limite déclarée du §7.6 : une entrée entendue ne
 * partait que sur un adieu explicite. Un pair qui s'éteint brutalement
 * n'en émet aucun — son service restait donc dans le cache
 * indéfiniment, ce qui est précisément le genre d'affirmation sans
 * fondement que cette série traque.
 *
 * L'horloge du cache est injectable. Ce n'est pas un artifice de test :
 * un TTL DNS-SD vaut 120 s, et sans cela vérifier l'expiration
 * demanderait deux minutes par cas — autant dire qu'on ne la vérifierait
 * pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { DNSSD_RECORD_TTL } from '@/network/dnssd/DnsSdRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const LONG = 40_000;
const MASK = new SubnetMask('255.255.255.0');
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface AgentView {
  whenReady(): Promise<void>;
  knownServices(): Array<{ name: string; port: number; host: string }>;
  setClock(fn: () => number): void;
  pruneExpired(): void;
  browse(type: string, ms?: number): Promise<string[]>;
}
type Pc = LinuxPC & { getMdnsAgent(): AgentView };

/** `a` écoute, `b` publie. L'horloge de `a` est celle qu'on avance. */
async function lab(): Promise<{ a: Pc; b: Pc; avance(ms: number): void }> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const a = new LinuxPC('linux-pc', 'alpha', 0, 0);
  const b = new LinuxPC('linux-pc', 'bravo', 0, 0);
  sw.powerOn(); a.powerOn(); b.powerOn();
  new Cable('c1').connect(a.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(b.getPorts()[0], sw.getPorts()[1]);
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  for (const pc of [a, b]) {
    await pc.executeCommand("sudo sh -c 'printf \"nameserver 127.0.0.53\\n\" > /etc/resolv.conf'");
    await pc.executeCommand('sudo resolvectl mdns eth0 yes');
  }
  let horloge = Date.now();
  (a as Pc).getMdnsAgent().setClock(() => horloge);
  return { a: a as Pc, b: b as Pc, avance: (ms) => { horloge += ms; } };
}

async function publier(pc: LinuxPC, file: string, body: string): Promise<void> {
  await pc.executeCommand('sudo mkdir -p /etc/systemd/dnssd');
  await pc.executeCommand(`sudo sh -c 'printf "${body}" > /etc/systemd/dnssd/${file}'`);
  await pc.executeCommand('sudo systemctl restart systemd-resolved');
}

const SITE = '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\n';

describe('Scénario 1 — une entrée ne survit pas à son TTL', () => {
  it('elle est là juste avant l\'échéance, plus après', async () => {
    const { a, b, avance } = await lab();
    await publier(b, 'w.dnssd', SITE);
    await b.getMdnsAgent().whenReady();
    await pause(120);
    expect(a.getMdnsAgent().knownServices().length).toBe(1);

    avance((DNSSD_RECORD_TTL - 1) * 1000);
    expect(
      a.getMdnsAgent().knownServices().length,
      'une seconde avant l\'échéance, le service est encore annoncé',
    ).toBe(1);

    avance(2000);
    expect(
      a.getMdnsAgent().knownServices(),
      'passé le TTL, l\'auditeur n\'a plus de raison d\'affirmer que le service est là',
    ).toEqual([]);
  }, LONG);

  it('un pair qui disparaît sans adieu finit par être oublié', async () => {
    const { a, b, avance } = await lab();
    await publier(b, 'w.dnssd', SITE);
    await b.getMdnsAgent().whenReady();
    await pause(120);

    // Extinction brutale : aucun adieu n'est émis. C'est exactement le
    // cas que le TTL existe pour couvrir.
    b.powerOff();
    expect(a.getMdnsAgent().knownServices().length).toBe(1);

    avance((DNSSD_RECORD_TTL + 1) * 1000);
    expect(a.getMdnsAgent().knownServices()).toEqual([]);
  }, LONG);

  it('l\'expiration est annoncée sur le bus', async () => {
    const { a, b, avance } = await lab();
    const expires: string[] = [];
    a.getBus().subscribe('mdns.service.expired', (e) => expires.push(e.payload.name));

    await publier(b, 'w.dnssd', SITE);
    await b.getMdnsAgent().whenReady();
    await pause(120);
    expect(expires).toEqual([]);

    avance((DNSSD_RECORD_TTL + 1) * 1000);
    a.getMdnsAgent().pruneExpired();
    expect(expires).toEqual(['site._http._tcp.local']);
  }, LONG);

  it('l\'expiration ne se produit qu\'une fois', async () => {
    const { a, b, avance } = await lab();
    const expires: string[] = [];
    a.getBus().subscribe('mdns.service.expired', (e) => expires.push(e.payload.name));

    await publier(b, 'w.dnssd', SITE);
    await b.getMdnsAgent().whenReady();
    await pause(120);

    avance((DNSSD_RECORD_TTL + 1) * 1000);
    a.getMdnsAgent().pruneExpired();
    a.getMdnsAgent().pruneExpired();
    a.getMdnsAgent().knownServices();
    expect(expires.length, 'une entrée retirée ne peut plus expirer').toBe(1);
  }, LONG);
});

describe('Scénario 2 — une annonce repousse l\'échéance', () => {
  it('réannoncer remet le compteur à zéro', async () => {
    const { a, b, avance } = await lab();
    await publier(b, 'w.dnssd', SITE);
    await b.getMdnsAgent().whenReady();
    await pause(120);

    // À dix secondes de l'échéance, le service change et se réannonce.
    avance((DNSSD_RECORD_TTL - 10) * 1000);
    await publier(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=8080\\n');
    await pause(150);
    expect(a.getMdnsAgent().knownServices()[0].port).toBe(8080);

    // Vingt secondes plus tard : l'ancienne échéance est passée, la
    // nouvelle non.
    avance(20 * 1000);
    expect(
      a.getMdnsAgent().knownServices().length,
      'sans report d\'échéance, une réannonce ne servirait à rien',
    ).toBe(1);
  }, LONG);
});

describe('Scénario 3 — le cache expiré ne ment pas sur le lien', () => {
  it('un parcours actif retrouve le service que le cache a oublié', async () => {
    const { a, b, avance } = await lab();
    await publier(b, 'w.dnssd', SITE);
    await b.getMdnsAgent().whenReady();
    await pause(120);

    avance((DNSSD_RECORD_TTL + 1) * 1000);
    expect(a.getMdnsAgent().knownServices()).toEqual([]);

    // Le cache dit ce qu'on a *entendu* ; le parcours pose une vraie
    // question. Les deux ne peuvent pas se contredire : le service est
    // toujours là, simplement plus dans la mémoire de l'auditeur.
    expect(
      await a.getMdnsAgent().browse('_http._tcp'),
      'une entrée expirée n\'est pas une absence de service',
    ).toEqual(['Site._http._tcp.local']);
  }, LONG);

  it('et le service réentendu revient dans le cache', async () => {
    const { a, b, avance } = await lab();
    await publier(b, 'w.dnssd', SITE);
    await b.getMdnsAgent().whenReady();
    await pause(120);

    avance((DNSSD_RECORD_TTL + 1) * 1000);
    expect(a.getMdnsAgent().knownServices()).toEqual([]);

    await publier(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=8080\\n');
    await pause(150);
    expect(a.getMdnsAgent().knownServices().length).toBe(1);
  }, LONG);
});
