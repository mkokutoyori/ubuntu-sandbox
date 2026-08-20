/**
 * Probes — sous-types DNS-SD (§7.1) et cycle de vie d'un service
 * (§8.4 mise à jour, §10.1 adieu).
 *
 * Le §7.5 du PRD rangeait les deux hors périmètre. Le second posait un
 * problème de fond : une annonce que personne n'écoute n'est pas
 * observable, donc pas vérifiable — émettre un adieu dans le vide aurait
 * été décoratif. L'agent tient désormais un cache passif de ce qu'il
 * entend annoncer sur le groupe, et c'est ce cache que ces probes
 * mesurent : c'est la seule façon de montrer qu'un adieu *arrive*, et
 * pas seulement qu'il part.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { parseDnssdFile } from '@/network/devices/linux/net/DnssdFiles';
import { subtypeName, parseSubtypeName } from '@/network/dnssd/types';

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
  nameState(): string;
  browse(type: string, ms?: number): Promise<string[]>;
  resolveService(fqdn: string, ms?: number): Promise<{
    port: number; priority: number; weight: number; txt: string[];
  } | null>;
  knownServices(): Array<{ name: string; port: number; host: string }>;
  services(): { list(): Array<{ instance: string; type: string }> };
}
type Pc = LinuxPC & { getMdnsAgent(): AgentView };

async function lab(): Promise<{ a: Pc; b: Pc }> {
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
  return { a: a as Pc, b: b as Pc };
}

/** Écrit une unité `.dnssd` et fait relire le démon. */
async function write(pc: LinuxPC, file: string, body: string): Promise<void> {
  await pc.executeCommand('sudo mkdir -p /etc/systemd/dnssd');
  await pc.executeCommand(`sudo sh -c 'printf "${body}" > /etc/systemd/dnssd/${file}'`);
  await pc.executeCommand('sudo systemctl restart systemd-resolved');
}

describe('Scénario 1 — le nom d\'un sous-type', () => {
  it('se compose et se décompose', () => {
    expect(subtypeName('_printer', '_http._tcp')).toBe('_printer._sub._http._tcp.local');
    // Le préfixe `_` est ajouté si l'opérateur l'a oublié.
    expect(subtypeName('printer', '_http._tcp')).toBe('_printer._sub._http._tcp.local');
    expect(parseSubtypeName('_printer._sub._http._tcp.local'))
      .toEqual({ subtype: '_printer', type: '_http._tcp' });
  });

  it('un type ordinaire n\'est pas un sous-type', () => {
    // C'est le marqueur `_sub` qui tranche, pas la longueur du nom.
    expect(parseSubtypeName('_http._tcp.local')).toBeNull();
    expect(parseSubtypeName('Mon serveur._http._tcp.local')).toBeNull();
  });

  it('l\'unité accepte `SubType`, `Priority` et `Weight`', () => {
    const parsed = parseDnssdFile('/etc/systemd/dnssd/x.dnssd',
      '[Service]\nName=S\nType=_http._tcp\nSubType=_printer\nSubType=_scanner\n'
      + 'Port=80\nPriority=5\nWeight=7\n');
    expect(parsed?.service.subtypes).toEqual(['_printer', '_scanner']);
    expect(parsed?.service.priority).toBe(5);
    expect(parsed?.service.weight).toBe(7);
  });
});

describe('Scénario 2 — parcourir par sous-type', () => {
  it('le sous-type ne rend que les instances qui s\'y sont déclarées', async () => {
    const { a, b } = await lab();
    await write(b, 'p.dnssd',
      '[Service]\\nName=Imprimante\\nType=_http._tcp\\nSubType=_printer\\nPort=631\\n');
    await write(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\n');
    await b.getMdnsAgent().whenReady();

    expect(
      (await a.getMdnsAgent().browse('_http._tcp')).sort(),
      'le type large voit les deux',
    ).toEqual(['Imprimante._http._tcp.local', 'Site._http._tcp.local']);

    expect(
      await a.getMdnsAgent().browse('_printer._sub._http._tcp'),
      'le sous-type restreint la découverte sans créer un second service',
    ).toEqual(['Imprimante._http._tcp.local']);
  }, LONG);

  it('un sous-type que personne ne déclare ne rend rien', async () => {
    const { a, b } = await lab();
    await write(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\n');
    await b.getMdnsAgent().whenReady();

    expect(await a.getMdnsAgent().browse('_printer._sub._http._tcp')).toEqual([]);
  }, LONG);

  it('`resolvectl service` accepte un sous-type', async () => {
    const { a, b } = await lab();
    await write(b, 'p.dnssd',
      '[Service]\\nName=Imprimante\\nType=_http._tcp\\nSubType=_printer\\nPort=631\\n');
    await b.getMdnsAgent().whenReady();

    const out = await a.executeCommand('resolvectl service _printer._sub._http._tcp local');
    expect(out).toContain('Imprimante');
    expect(out).toContain('bravo.local:631');
  }, LONG);

  it('les champs SRV sont ceux de l\'unité, pas des zéros codés en dur', async () => {
    const { a, b } = await lab();
    await write(b, 'w.dnssd',
      '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\nPriority=5\\nWeight=7\\n');
    await b.getMdnsAgent().whenReady();

    const r = await a.getMdnsAgent().resolveService('Site._http._tcp.local');
    expect(r?.priority).toBe(5);
    expect(r?.weight).toBe(7);
  }, LONG);
});

describe('Scénario 3 — le pair apprend des annonces', () => {
  it('un service publié est annoncé dès le nom acquis', async () => {
    const { a, b } = await lab();
    await write(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\n');
    await b.getMdnsAgent().whenReady();
    await pause(120);

    // L'unité est écrite avant la fin du sondage : sans annonce au
    // moment de l'acquisition, personne ne l'apprendrait jamais.
    const connus = a.getMdnsAgent().knownServices();
    expect(connus.length).toBe(1);
    expect(connus[0].port).toBe(80);
    expect(connus[0].host).toBe('bravo.local');
  }, LONG);

  it('une modification est réannoncée et remplace l\'ancienne', async () => {
    const { a, b } = await lab();
    await write(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\n');
    await b.getMdnsAgent().whenReady();
    await pause(120);
    expect(a.getMdnsAgent().knownServices()[0].port).toBe(80);

    await write(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=8080\\n');
    await pause(150);

    const connus = a.getMdnsAgent().knownServices();
    expect(connus.length, 'le bit cache-flush remplace, il n\'empile pas').toBe(1);
    expect(connus[0].port).toBe(8080);
  }, LONG);

  it('et la résolution suit la nouvelle valeur', async () => {
    const { a, b } = await lab();
    await write(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\n');
    await b.getMdnsAgent().whenReady();
    await write(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=8080\\n');
    await pause(120);

    expect((await a.getMdnsAgent().resolveService('Site._http._tcp.local'))?.port).toBe(8080);
  }, LONG);

  it('le TXT modifié se propage aussi', async () => {
    const { a, b } = await lab();
    await write(b, 'w.dnssd',
      '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\nTxtText=v=1\\n');
    await b.getMdnsAgent().whenReady();
    await write(b, 'w.dnssd',
      '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\nTxtText=v=2\\n');
    await pause(120);

    expect((await a.getMdnsAgent().resolveService('Site._http._tcp.local'))?.txt).toEqual(['v=2']);
  }, LONG);
});

describe('Scénario 4 — l\'adieu retire le service du lien', () => {
  it('supprimer l\'unité vide le cache du pair', async () => {
    const { a, b } = await lab();
    await write(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\n');
    await b.getMdnsAgent().whenReady();
    await pause(120);
    expect(a.getMdnsAgent().knownServices().length).toBe(1);

    await b.executeCommand('sudo rm /etc/systemd/dnssd/w.dnssd');
    await b.executeCommand('sudo systemctl restart systemd-resolved');
    await pause(150);

    expect(
      a.getMdnsAgent().knownServices(),
      'un TTL nul est une instruction de suppression (§10.1), pas un silence',
    ).toEqual([]);
  }, LONG);

  it('et le registre local ne le publie plus', async () => {
    const { a, b } = await lab();
    await write(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\n');
    await b.getMdnsAgent().whenReady();

    await b.executeCommand('sudo rm /etc/systemd/dnssd/w.dnssd');
    await b.executeCommand('sudo systemctl restart systemd-resolved');
    await pause(120);

    expect(b.getMdnsAgent().services().list()).toEqual([]);
    expect(await a.getMdnsAgent().browse('_http._tcp')).toEqual([]);
  }, LONG);

  it('retirer une unité n\'emporte pas les autres', async () => {
    const { a, b } = await lab();
    await write(b, 'w.dnssd', '[Service]\\nName=Site\\nType=_http._tcp\\nPort=80\\n');
    await write(b, 's.dnssd', '[Service]\\nName=Shell\\nType=_ssh._tcp\\nPort=22\\n');
    await b.getMdnsAgent().whenReady();

    await b.executeCommand('sudo rm /etc/systemd/dnssd/w.dnssd');
    await b.executeCommand('sudo systemctl restart systemd-resolved');
    await pause(150);

    expect(b.getMdnsAgent().services().list().map((s) => s.type)).toEqual(['_ssh._tcp']);
    expect(await a.getMdnsAgent().browse('_ssh._tcp')).toEqual(['Shell._ssh._tcp.local']);
    expect(await a.getMdnsAgent().browse('_http._tcp')).toEqual([]);
  }, LONG);
});
