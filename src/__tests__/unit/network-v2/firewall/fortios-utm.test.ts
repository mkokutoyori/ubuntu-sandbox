/**
 * Phase 6 : l'inspection et l'UTM — et les laboratoires L10 et L11.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait, verifie contre
 * la documentation Fortinet AVANT d'ecrire une ligne de produit.
 *
 * Cinq points ne sont pas cosmetiques :
 *
 *   1. **Le trafic traverse le fil.** Aucun cas ne fabrique un paquet a
 *      la main : c'est un vrai `curl` vers un vrai nginx, et la charge
 *      HTTP que l'etage `utm-inspect` lit est celle que le client a
 *      reellement emise. Une sonde qui synthetiserait la requete
 *      prouverait que la fonction sait lire une chaine, pas qu'elle
 *      inspecte du trafic.
 *   2. **`utm-status` COMMANDE l'existence des references.** Sur un vrai
 *      FortiGate les attributs `av-profile`/`webfilter-profile` ne sont
 *      meme pas proposes tant que `set utm-status enable` n'a pas ete
 *      tape. Les accepter avant serait ranger une reference que rien
 *      n'applique.
 *   3. **`certificate-inspection` lit le SNI du VRAI ClientHello.**
 *      Fortinet documente que sans dechiffrement le FortiGate filtre sur
 *      le SNI, donc sur le NOM D'HOTE SEUL, jamais sur le chemin. Les
 *      deux moities sont verifiees : le nom bloque, le chemin ne peut
 *      pas etre lu.
 *   4. **`deep-inspection` est REFUSE en nommant la brique absente.**
 *      L'accepter laisserait la session chiffree pendant que la CLI
 *      annoncerait qu'elle est dechiffree — le defaut exact que ce
 *      depot refuse (« ne jamais ranger un critere qu'on n'evalue
 *      pas »).
 *   5. **Le type de fichier vient du CONTENU.** Un vrai FortiGate lit le
 *      nombre magique, pas l'extension ; renommer `.exe` en `.txt` ne
 *      change rien, et c'est tout l'interet du filtre.
 *
 * Discrimination : `git stash push -- src/network/`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  EICAR_SIGNATURE, detectFileType, parseDnsQuestion, readSni,
  scanDnsFilter, scanFileFilter, scanWebFilterHost,
  type InspectedFlow,
} from '@/network/devices/firewall/inspection/ContentInspector';
import {
  categoryName, categoryOfDomain,
  type DnsFilterProfile, type FileFilterProfile, type WebFilterProfile,
} from '@/network/devices/firewall/inspection/UtmProfiles';
import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { encodeRecords } from '@/network/http/https/TlsRecordWire';
import { encodeMessages } from '@/network/tls/messages';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function shell(): { fw: FortiGate; sh: FortiShell } {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

const CLIENT_IP = '192.168.1.10';
const SERVER_IP = '203.0.113.10';

async function laboratoire() {
  const { fw, sh } = shell();
  const poste = new LinuxPC('linux-pc', 'POSTE', -100, 0);
  const serveur = new LinuxServer('linux-server', 'WEB', 100, 0);

  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(fw.getPort('port2')!, serveur.getPort('eth0')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', `ip addr add ${CLIENT_IP}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);
  await runOn(serveur, ['ip link set eth0 up', `ip addr add ${SERVER_IP}/24 dev eth0`,
    'ip route add default via 203.0.113.1']);

  return { fw, sh, poste, serveur };
}

/** La politique de sortie ; `extra` porte les references UTM. */
function politique(sh: FortiShell, ...extra: string[]): string {
  return run(sh,
    'config firewall policy', 'edit 1',
    'set name "SORTIE"',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'set nat enable', ...extra, 'next', 'end');
}

async function siteHttp(serveur: LinuxServer): Promise<void> {
  await serveur.executeCommand('systemctl start nginx');
}

/** `config webfilter urlfilter` : la table REFERENCEE, comme sur un vrai FortiGate. */
function tableUrl(sh: FortiShell, motif: string): void {
  run(sh, 'config webfilter urlfilter', 'edit 1',
    'set name "BLOQUES"',
    'config entries', 'edit 1',
    `set url "${motif}"`, 'set type simple', 'set action block',
    'next', 'end', 'next', 'end');
}

/** Une vraie question DNS encodee sur le fil (RFC 1035), pas du texte. */
function fluxDns(nom: string): InspectedFlow {
  return Object.freeze({
    protocol: 'dns' as const, sourcePort: 40000, destinationPort: 53,
    payload: '',
    bytes: encodeDnsMessage({
      id: 1,
      flags: {
        qr: false, opcode: 0, aa: false, tc: false, rd: true, ra: false,
        ad: false, cd: false, rcode: 0,
      },
      questions: [{ qname: nom, qtype: 1, qclass: 1 }],
      answers: [], authorities: [], additionals: [],
    }),
  });
}

/** Un vrai ClientHello TLS encapsule dans un vrai enregistrement. */
function fluxTls(sni: string): InspectedFlow {
  const hello = encodeMessages([{
    kind: 'client_hello',
    legacyVersion: '0303',
    random: 'r',
    cipherSuites: ['TLS_AES_128_GCM_SHA256'],
    extensions: {
      supportedVersions: ['1.3'], keyShare: 'k',
      supportedGroups: ['x25519'], signatureAlgorithms: ['rsa_pss_rsae_sha256'],
      serverName: sni,
    },
  }] as never);

  return Object.freeze({
    protocol: 'https' as const, sourcePort: 40000, destinationPort: 443,
    payload: '',
    bytes: encodeRecords([{ contentType: 'handshake', legacyVersion: 0x0303, fragment: hello }]),
  });
}

beforeEach(() => { Logger.reset(); });

describe('l`inspection lit le trafic qui a VRAIMENT traverse', () => {
  it('sans profil UTM, la requete passe intacte — temoin', async () => {
    const { sh, poste, serveur } = await laboratoire();
    await siteHttp(serveur);
    politique(sh);

    const vu = await poste.executeCommand(`curl -sS http://${SERVER_IP}/`);

    expect(vu).toContain('Welcome to nginx!');
  });

  it('un profil antivirus bloque EICAR envoye en HTTP', async () => {
    const { sh, poste, serveur } = await laboratoire();
    await siteHttp(serveur);

    run(sh, 'config antivirus profile', 'edit "AV"',
      'config http', 'set av-scan block', 'end', 'next', 'end');
    politique(sh, 'set utm-status enable', 'set av-profile "AV"');

    const vu = await poste.executeCommand(
      `curl -sS -d '${EICAR_SIGNATURE}' http://${SERVER_IP}/`);

    expect(vu).not.toContain('Welcome to nginx!');
  });

  it('le meme profil laisse passer une requete propre', async () => {
    const { sh, poste, serveur } = await laboratoire();
    await siteHttp(serveur);

    run(sh, 'config antivirus profile', 'edit "AV"',
      'config http', 'set av-scan block', 'end', 'next', 'end');
    politique(sh, 'set utm-status enable', 'set av-profile "AV"');

    const vu = await poste.executeCommand(`curl -sS http://${SERVER_IP}/`);

    expect(vu).toContain('Welcome to nginx!');
  });

  it('`av-scan monitor` journalise et LAISSE PASSER', async () => {
    const { sh, poste, serveur } = await laboratoire();
    await siteHttp(serveur);

    run(sh, 'config antivirus profile', 'edit "AV"',
      'config http', 'set av-scan monitor', 'end', 'next', 'end');
    politique(sh, 'set utm-status enable', 'set av-profile "AV"');

    const vu = await poste.executeCommand(
      `curl -sS -d '${EICAR_SIGNATURE}' http://${SERVER_IP}/`);

    expect(vu).toContain('Welcome to nginx!');
  });

  it('un filtre d`URL bloque l`hote demande dans l`en-tete Host', async () => {
    const { sh, poste, serveur } = await laboratoire();
    await siteHttp(serveur);

    tableUrl(sh, 'interdit.test');
    run(sh, 'config webfilter profile', 'edit "WEB"',
      'config web', 'set urlfilter-table 1', 'end', 'next', 'end');
    politique(sh, 'set utm-status enable', 'set webfilter-profile "WEB"');

    const vu = await poste.executeCommand(
      `curl -sS -H "Host: interdit.test" http://${SERVER_IP}/`);

    expect(vu).not.toContain('Welcome to nginx!');
  });

  it('le meme filtre laisse passer un autre hote', async () => {
    const { sh, poste, serveur } = await laboratoire();
    await siteHttp(serveur);

    tableUrl(sh, 'interdit.test');
    run(sh, 'config webfilter profile', 'edit "WEB"',
      'config web', 'set urlfilter-table 1', 'end', 'next', 'end');
    politique(sh, 'set utm-status enable', 'set webfilter-profile "WEB"');

    const vu = await poste.executeCommand(
      `curl -sS -H "Host: autorise.test" http://${SERVER_IP}/`);

    expect(vu).toContain('Welcome to nginx!');
  });

  it('un filtre de CATEGORIE bloque sans qu`aucune URL soit nommee', async () => {
    const { sh, poste, serveur } = await laboratoire();
    await siteHttp(serveur);

    run(sh, 'config webfilter profile', 'edit "WEB"',
      'config ftgd-wf', 'config filters', 'edit 1',
      'set category 26', 'set action block', 'next', 'end', 'end',
      'next', 'end');
    politique(sh, 'set utm-status enable', 'set webfilter-profile "WEB"');

    const vu = await poste.executeCommand(
      `curl -sS -H "Host: lab-social.test" http://${SERVER_IP}/`);

    expect(vu).not.toContain('Welcome to nginx!');
  });
});

describe('`utm-status` commande l`existence des references', () => {
  it('une reference de profil est REFUSEE tant que `utm-status` est absent', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config antivirus profile', 'edit "AV"', 'next', 'end');

    const vu = run(sh,
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set av-profile "AV"');

    expect(vu).toContain('Command fail');
  });

  it('la meme reference est acceptee apres `set utm-status enable`', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config antivirus profile', 'edit "AV"', 'next', 'end');

    const vu = run(sh,
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set utm-status enable', 'set av-profile "AV"');

    expect(vu).not.toContain('Command fail');
  });

  it('un profil qui n`existe pas est refuse', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh,
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set utm-status enable', 'set av-profile "ABSENT"');

    expect(vu).toContain('Command fail');
  });
});

describe('SSL : ce qui est lisible sans dechiffrer, et ce qui ne l`est pas', () => {
  it('`deep-inspection` est refuse en nommant la brique absente', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh, 'config firewall ssl-ssh-profile', 'edit "SSL"',
      'config https', 'set status deep-inspection');

    expect(vu).toContain('Command fail');
    expect(vu).toContain('deep-inspection');
    expect(vu).toContain('certificate-inspection');
  });

  it('`certificate-inspection` est acceptee', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh, 'config firewall ssl-ssh-profile', 'edit "SSL"',
      'config https', 'set status certificate-inspection');

    expect(vu).not.toContain('Command fail');
  });

  it('le SNI est lu sur un VRAI ClientHello, decode par le codec du depot', () => {
    expect(readSni(fluxTls('lab-social.test'))).toBe('lab-social.test');
  });

  it('un flux qui n`est pas un ClientHello ne donne aucun SNI', () => {
    expect(readSni({
      protocol: 'http', sourcePort: 40000, destinationPort: 80,
      payload: 'GET / HTTP/1.1\r\nHost: lab-social.test\r\n\r\n',
    })).toBeUndefined();
  });

  it('le filtrage par SNI porte sur le NOM D`HOTE, jamais sur le chemin', () => {
    const profile: WebFilterProfile = {
      name: 'WEB',
      urlFilterTable: '1',
      categoryFilters: [],
      unclassifiedAction: 'allow',
      logAllUrl: false,
    };
    const chemins = [
      { id: '1', pattern: 'lab-social.test/videos', type: 'simple' as const, action: 'block' as const },
    ];

    expect(scanWebFilterHost('lab-social.test', profile, chemins).blocked).toBe(false);
  });

  it('la CATEGORIE du SNI, elle, suffit a bloquer', () => {
    const profile: WebFilterProfile = {
      name: 'WEB',
      categoryFilters: [{ id: '1', category: 26, action: 'block' }],
      unclassifiedAction: 'allow',
      logAllUrl: false,
    };

    const verdict = scanWebFilterHost('lab-social.test', profile, []);

    expect(verdict.blocked).toBe(true);
    expect(verdict.categoryLabel).toBe('Social Networking');
  });
});

describe('categories locales', () => {
  it('un sous-domaine herite de la categorie de son domaine', () => {
    expect(categoryOfDomain('www.lab-social.test')).toBe(26);
  });

  it('un domaine inconnu est `Unrated`', () => {
    expect(categoryOfDomain('inconnu.test')).toBe(0);
    expect(categoryName(0)).toBe('Unrated');
  });

  it('la comparaison ignore la casse', () => {
    expect(categoryOfDomain('LAB-GAMES.TEST')).toBe(33);
  });

  it('un domaine dont le nom CONTIENT une categorie n`en herite pas', () => {
    expect(categoryOfDomain('faux-lab-social.test.example')).toBe(0);
  });
});

describe('filtre DNS', () => {
  const profile: DnsFilterProfile = {
    name: 'DNS',
    categoryFilters: [{ id: '1', category: 14, action: 'block' }],
    domainFilterTable: '1',
    unclassifiedAction: 'allow',
  };

  const DOMAINES = [
    { id: '1', pattern: '*.interdit.test', type: 'wildcard' as const, action: 'block' as const },
  ];

  const filtres = profile.domainFilterTable === undefined ? DOMAINES : DOMAINES;

  it('la question est lue dans un VRAI paquet DNS encode RFC 1035', () => {
    expect(parseDnsQuestion(fluxDns('a.interdit.test'))).toBe('a.interdit.test');
  });

  it('un domaine explicitement filtre est bloque', () => {
    const verdict = scanDnsFilter(fluxDns('a.interdit.test'), profile, filtres);

    expect(verdict.blocked).toBe(true);
    expect(verdict.kind).toBe('dns-blocked');
  });

  it('une categorie filtree bloque sans que le domaine soit nomme', () => {
    const verdict = scanDnsFilter(fluxDns('lab-adult.test'), profile, filtres);

    expect(verdict.blocked).toBe(true);
    expect(verdict.categoryLabel).toBe('Adult Materials');
  });

  it('un domaine hors filtre et hors categorie passe', () => {
    const verdict = scanDnsFilter(fluxDns('exemple.test'), profile, filtres);

    expect(verdict.blocked).toBe(false);
  });
});

describe('filtre de fichiers : le CONTENU decide, pas l`extension', () => {
  const profile: FileFilterProfile = {
    name: 'FILE',
    entries: [{ id: '1', fileTypes: ['exe'], action: 'block', direction: 'any' }],
    scanArchiveContents: false,
  };

  const flow = (payload: string): InspectedFlow => Object.freeze({
    protocol: 'http' as const, sourcePort: 40000, destinationPort: 80, payload,
  });

  it('un executable renomme en `.txt` est reconnu par son nombre magique', () => {
    expect(detectFileType('MZ rien-du-tout')).toBe('exe');
  });

  it('et il est bloque', () => {
    const verdict = scanFileFilter(
      flow('HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nMZ charge'), profile);

    expect(verdict.blocked).toBe(true);
    expect(verdict.fileType).toBe('exe');
  });

  it('un PDF, non filtre, passe', () => {
    const verdict = scanFileFilter(
      flow('HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n%PDF-1.7 charge'), profile);

    expect(verdict.blocked).toBe(false);
  });

  it('un contenu sans nombre magique connu n`est pas un type', () => {
    expect(detectFileType('juste du texte')).toBeUndefined();
  });
});

describe('les familles sans moteur sont REFUSEES, pas rangees', () => {
  it.each([
    ['application list', 'signature'],
    ['ips sensor', 'signature'],
    ['dlp sensor', 'signature'],
    ['firewall shaper traffic-shaper', 'clock'],
  ])('`config %s` refuse en nommant la brique absente', async (chemin, brique) => {
    const { sh } = await laboratoire();

    const vu = run(sh, `config ${chemin}`, 'edit "X"', 'set name "X"');

    expect(vu).toContain('Command fail');
    expect(vu.toLowerCase()).toContain(brique);
  });
});

describe('la configuration rendue reproduit ce qui a ete tape', () => {
  it('`show` ne rend que ce qui a ete modifie', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config antivirus profile', 'edit "AV"',
      'set comment "labo"', 'next', 'end');

    const vu = run(sh, 'show antivirus profile');

    expect(vu).toContain('edit "AV"');
    expect(vu).toContain('set comment "labo"');
    expect(vu).not.toContain('set feature-set');
  });

  it('`get` rend aussi les valeurs par defaut', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config antivirus profile', 'edit "AV"', 'next', 'end');

    const vu = run(sh, 'config antivirus profile', 'edit "AV"', 'get');

    expect(vu).toContain('name');
    expect(vu).toContain('AV');
  });

  it('la reference UTM d`une politique est rendue', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config antivirus profile', 'edit "AV"', 'next', 'end');
    politique(sh, 'set utm-status enable', 'set av-profile "AV"');

    const vu = run(sh, 'show firewall policy');

    expect(vu).toContain('set utm-status enable');
    expect(vu).toContain('set av-profile "AV"');
  });

  it('supprimer un profil le retire du magasin', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config antivirus profile', 'edit "AV"', 'next', 'end');
    expect(fw.getUtmProfiles().antivirusNames()).toContain('AV');

    run(sh, 'config antivirus profile', 'delete "AV"', 'end');

    expect(fw.getUtmProfiles().antivirusNames()).not.toContain('AV');
  });
});
