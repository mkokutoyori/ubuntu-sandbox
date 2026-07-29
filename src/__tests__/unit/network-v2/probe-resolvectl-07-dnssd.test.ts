/**
 * Probes — DNS-SD (RFC 6763) et la suppression par réponses connues
 * (RFC 6762 §7.1).
 *
 * Les deux points étaient déclarés hors périmètre dans le §7.4 du PRD, et
 * le §8 justifiait l'absence de `resolvectl service` par le fait que
 * « SRV, OPENPGPKEY et TLSA n'ont pas de source de données dans les
 * zones du simulateur ». DNS-SD *est* cette source : le verbe existe
 * désormais parce qu'il a enfin quelque chose à interroger.
 *
 * La publication ne se fait pas par une commande mais par un fichier
 * d'unité `/etc/systemd/dnssd/*.dnssd` — c'est ainsi que systemd
 * procède (`systemd.dnssd(5)`), et c'est ce que ces probes exercent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { EndHost } from '@/network/devices/EndHost';
import { queryMulticastDns } from '@/network/dns/transport/MulticastDnsTransport';
import { buildLegacyQueryMessage, nextDnsTransactionId } from '@/network/dns/compat/DnsWireCompat';
import { MDNS_BINDING } from '@/network/mdns/types';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import { RRType } from '@/network/dns/wire/RRType';
import {
  parseInstanceName, instanceName, isServiceTypeName, DNSSD_ENUM_NAME,
} from '@/network/dnssd/types';
import { parseDnssdFile } from '@/network/devices/linux/net/DnssdFiles';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const LONG = 40_000;
const MASK = new SubnetMask('255.255.255.0');

interface MdnsAgentView {
  start(): void;
  whenReady(): Promise<void>;
  ownName(): string;
  browse(type: string, ms?: number): Promise<string[]>;
  browseTypes(ms?: number): Promise<string[]>;
  resolveService(fqdn: string, ms?: number): Promise<{
    instance: string; type: string; host: string; port: number;
    txt: string[]; addresses: string[];
  } | null>;
  services(): { list(): Array<{ instance: string; type: string; port: number }> };
}
type Pc = LinuxPC & { getMdnsAgent(): MdnsAgentView };

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

/** Publie un service comme systemd le fait : par un fichier d'unité. */
async function publish(pc: LinuxPC, file: string, body: string): Promise<void> {
  await pc.executeCommand('sudo mkdir -p /etc/systemd/dnssd');
  await pc.executeCommand(`sudo sh -c 'printf "${body}" > /etc/systemd/dnssd/${file}'`);
  await pc.executeCommand('sudo systemctl restart systemd-resolved');
}

const SERVICE_WEB =
  '[Service]\\nName=Mon serveur web\\nType=_http._tcp\\nPort=80\\nTxtText=path=/index.html\\n';

describe('Scénario 1 — le fichier d\'unité publie le service', () => {
  it('`.dnssd` est lu au démarrage du service', async () => {
    const { b } = await lab();
    await publish(b, 'web.dnssd', SERVICE_WEB);

    expect(b.getMdnsAgent().services().list()).toEqual([
      { instance: 'Mon serveur web', type: '_http._tcp', port: 80, txt: ['path=/index.html'] },
    ]);
  }, LONG);

  it('une unité incomplète est ignorée plutôt que publiée à moitié', () => {
    expect(parseDnssdFile('/etc/systemd/dnssd/x.dnssd', '[Service]\nName=Sans type\n')).toBeNull();
    expect(parseDnssdFile('/etc/systemd/dnssd/x.dnssd', '[Service]\nType=_http._tcp\nPort=80\n')).toBeNull();
    expect(parseDnssdFile('/etc/systemd/dnssd/x.txt', SERVICE_WEB.replace(/\\n/g, '\n'))).toBeNull();
  });

  it('plusieurs `TxtText` s\'accumulent', () => {
    const parsed = parseDnssdFile('/etc/systemd/dnssd/x.dnssd',
      '[Service]\nName=S\nType=_http._tcp\nPort=8080\nTxtText=a=1\nTxtText=b=2\n');
    expect(parsed?.service.txt).toEqual(['a=1', 'b=2']);
  });
});

describe('Scénario 2 — parcourir et résoudre depuis le lien', () => {
  it('le type annonce ses instances', async () => {
    const { a, b } = await lab();
    await publish(b, 'web.dnssd', SERVICE_WEB);
    await b.getMdnsAgent().whenReady();

    expect(await a.getMdnsAgent().browse('_http._tcp'))
      .toEqual(['Mon serveur web._http._tcp.local']);
  }, LONG);

  it('l\'énumération dit quels types existent sur le lien', async () => {
    const { a, b } = await lab();
    await publish(b, 'web.dnssd', SERVICE_WEB);
    await b.getMdnsAgent().whenReady();

    expect(
      await a.getMdnsAgent().browseTypes(),
      'c\'est le méta-service de §9 : savoir quoi chercher avant de chercher',
    ).toEqual(['_http._tcp.local']);
  }, LONG);

  it('résoudre une instance donne l\'hôte, le port et les métadonnées', async () => {
    const { a, b } = await lab();
    await publish(b, 'web.dnssd', SERVICE_WEB);
    await b.getMdnsAgent().whenReady();

    const r = await a.getMdnsAgent().resolveService('Mon serveur web._http._tcp.local');
    expect(r).not.toBeNull();
    expect(r!.host).toBe('bravo.local');
    expect(r!.port).toBe(80);
    expect(r!.txt).toEqual(['path=/index.html']);
    expect(
      r!.addresses,
      'le répondeur joint l\'adresse en additionnel (§12) : un seul aller-retour suffit',
    ).toEqual(['10.0.0.2']);
  }, LONG);

  it('un type que personne ne publie ne rend rien', async () => {
    const { a, b } = await lab();
    await publish(b, 'web.dnssd', SERVICE_WEB);
    await b.getMdnsAgent().whenReady();

    expect(await a.getMdnsAgent().browse('_ipp._tcp')).toEqual([]);
  }, LONG);

  it('deux services publiés donnent deux types', async () => {
    const { a, b } = await lab();
    await publish(b, 'web.dnssd', '[Service]\\nName=Web\\nType=_http._tcp\\nPort=80\\n');
    await publish(b, 'ssh.dnssd', '[Service]\\nName=Shell\\nType=_ssh._tcp\\nPort=22\\n');
    await b.getMdnsAgent().whenReady();

    expect((await a.getMdnsAgent().browseTypes()).sort())
      .toEqual(['_http._tcp.local', '_ssh._tcp.local']);
  }, LONG);
});

describe('Scénario 3 — `resolvectl service`', () => {
  it('parcourt et résout en une commande', async () => {
    const { a, b } = await lab();
    await publish(b, 'web.dnssd', SERVICE_WEB);
    await b.getMdnsAgent().whenReady();

    const out = await a.executeCommand('resolvectl service _http._tcp local');
    expect(out).toContain('Mon serveur web');
    expect(out).toContain('bravo.local:80');
    expect(out).toContain('10.0.0.2');
    expect(out).toContain('txt: path=/index.html');
    expect(out).toContain('protocol mDNS/IPv4');
  }, LONG);

  it('un type absent rend un code non nul', async () => {
    const { a, b } = await lab();
    await publish(b, 'web.dnssd', SERVICE_WEB);
    await b.getMdnsAgent().whenReady();

    const out = await a.executeCommand('resolvectl service _ipp._tcp local; echo rc=$?');
    expect(out).toContain('no services found');
    expect(out).toContain('rc=1');
  }, LONG);

  it('un argument qui n\'est pas un type est refusé', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('resolvectl service http local; echo rc=$?'))
      .toContain('rc=1');
  }, LONG);
});

describe('Scénario 4 — la suppression par réponses connues', () => {
  it('le répondeur se tait quand le demandeur sait déjà', async () => {
    const { a, b } = await lab();
    await b.getMdnsAgent().whenReady();
    const cible = b.getMdnsAgent().ownName();

    // Une question ordinaire obtient une réponse…
    const nue = buildLegacyQueryMessage(nextDnsTransactionId(), cible, 'A', {
      recursionDesired: false,
    })!;
    const avant = await queryMulticastDns(
      a as unknown as EndHost, MDNS_BINDING, nue, 600, { firstOnly: true });
    expect(avant.length).toBeGreaterThan(0);

    // …la même, portant déjà la réponse en section Answer, n'en obtient
    // aucune : répéter au lien ce que le demandeur vient d'écrire serait
    // du bruit pur (RFC 6762 §7.1).
    const savante = buildLegacyQueryMessage(nextDnsTransactionId(), cible, 'A', {
      recursionDesired: false,
    })!;
    const connu = { ...savante, answers: [makeARecord(cible, 120, '10.0.0.2')] };
    const apres = await queryMulticastDns(
      a as unknown as EndHost, MDNS_BINDING, connu, 600, { firstOnly: true });

    expect(apres, 'le répondeur n\'avait rien à ajouter').toEqual([]);
  }, LONG);

  it('un TTL déjà bas ne supprime pas : la copie du demandeur va expirer', async () => {
    const { a, b } = await lab();
    await b.getMdnsAgent().whenReady();
    const cible = b.getMdnsAgent().ownName();

    // Le seuil se compare au TTL que le répondeur *aurait* mis. Cette
    // question vient d'un port éphémère, donc §6.7 plafonne sa réponse à
    // 10 s : la moitié est 5, et une copie à 2 s doit être rafraîchie.
    const query = buildLegacyQueryMessage(nextDnsTransactionId(), cible, 'A', {
      recursionDesired: false,
    })!;
    const presqueExpire = { ...query, answers: [makeARecord(cible, 2, '10.0.0.2')] };
    const reponses = await queryMulticastDns(
      a as unknown as EndHost, MDNS_BINDING, presqueExpire, 600, { firstOnly: true });

    expect(reponses.length).toBeGreaterThan(0);
  }, LONG);

  it('une réponse connue qui ne correspond pas ne supprime rien', async () => {
    const { a, b } = await lab();
    await b.getMdnsAgent().whenReady();
    const cible = b.getMdnsAgent().ownName();

    const query = buildLegacyQueryMessage(nextDnsTransactionId(), cible, 'A', {
      recursionDesired: false,
    })!;
    // Une autre adresse pour le même nom : ce n'est pas ce que le
    // répondeur a, il doit donc parler.
    const autre = { ...query, answers: [makeARecord(cible, 120, '10.9.9.9')] };
    const reponses = await queryMulticastDns(
      a as unknown as EndHost, MDNS_BINDING, autre, 600, { firstOnly: true });

    expect(reponses.length).toBeGreaterThan(0);
    expect(reponses[0].answers.some(
      (rr) => rr.data.type === RRType.A
        && (rr.data as { address: { toString(): string } }).address.toString() === '10.0.0.2',
    )).toBe(true);
  }, LONG);
});

describe('Scénario 5 — la convention de nommage de RFC 6763', () => {
  it('compose et décompose un nom d\'instance', () => {
    expect(instanceName('Mon serveur', '_http._tcp')).toBe('Mon serveur._http._tcp.local');
    expect(parseInstanceName('Mon serveur._http._tcp.local')).toEqual({
      instance: 'Mon serveur', type: '_http._tcp', domain: 'local',
    });
  });

  it('un nom d\'instance peut contenir un point', () => {
    // §4.1.1 : le nom d'instance est fait pour être lu, pas pour être un
    // nom d'hôte. Découper depuis la fin est la seule façon correcte.
    expect(parseInstanceName('Bureau 2.4._http._tcp.local')).toEqual({
      instance: 'Bureau 2.4', type: '_http._tcp', domain: 'local',
    });
  });

  it('un type nu n\'est pas une instance', () => {
    expect(parseInstanceName('_http._tcp.local')).toBeNull();
    expect(isServiceTypeName('_http._tcp.local')).toBe(true);
    expect(isServiceTypeName('Mon serveur._http._tcp.local')).toBe(false);
  });

  it('le méta-service d\'énumération porte le nom de la RFC', () => {
    expect(DNSSD_ENUM_NAME).toBe('_services._dns-sd._udp.local');
  });
});
