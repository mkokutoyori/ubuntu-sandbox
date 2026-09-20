/**
 * Deux criteres de securite acceptes par le CLI et jamais evalues.
 *
 * Mesure AVANT (base mise de cote par `git stash push -- src/network`) :
 *
 *   set other-application-action block  ->  le trafic PASSE quand meme
 *   set untrusted-cert block            ->  la session PASSE quand meme
 *
 * Les deux mots-cles etaient declares dans le schema FortiOS, acceptes,
 * stockes et rendus par `show`, mais la valeur ne franchissait AUCUN des
 * quatre maillons qui menent au moteur. Pour le controle applicatif, elle
 * tombait des le premier : l'`onCommit' de `application list' ne lisait
 * pas `other-application-action', pourtant declare vingt lignes plus haut
 * sur le meme objet ; `scanApplicationControl' finissait donc sur un
 * `return CLEAN' en dur. Pour l'inspection SSL, la confiance du
 * certificat ETAIT calculee (`upstream.verified', par un vrai
 * `CertificateVerifier') mais ne servait qu'a choisir la CA de
 * re-signature : un certificat non fiable etait re-signe et laisse
 * passer, quoi qu'ait ecrit l'operateur.
 *
 * C'est le cas que CLAUDE.md §6 nomme le pire des trois — << toutes les
 * apparences d'exister sauf l'effet >> — aggrave par sa clause de
 * securite : un critere que le moteur ne tranche pas doit rendre l'entree
 * NON couvrante, alors qu'ici l'operateur ecrivait `block' et le trafic
 * passait.
 *
 * REUTILISATION : le patron existait deja dans les memes fichiers.
 * `unclassifiedAction' du filtrage web et DNS est la meme notion — que
 * faire de ce qui n'est pas dans la liste — et il est plumbe puis honore
 * (`categoryAction(...)'). Les deux reglages suivent ce patron plutot
 * qu'une forme neuve.
 *
 * AUTORITE, et sa limite : FortiOS est PROPRIETAIRE et
 * `docs.fortinet.com' rend 000 depuis cette machine, comme tout le
 * domaine (`help.fortinet.com', `community.fortinet.com' aussi). Mais la
 * SEMANTIQUE des mots-cles est deja ecrite DANS ce depot : le schema
 * declare `block' = << Block it >> / << Block the session >>, `pass' =
 * << Let it through >>, `ignore' = << Ignore the server certificate >>.
 * Le comportement implante est exactement celui que ces descriptions
 * enoncent ; aucune source externe n'est necessaire pour cela. Ce qui n'a
 * PAS pu etre confirme est plus fin : si `ignore' re-signe avec la CA de
 * confiance ou contourne la verification autrement. La lecture retenue
 * est celle que la description soutient — la confiance est ignoree, donc
 * la CA normale signe — et les cas ci-dessous portent sur la DECISION
 * (passer ou bloquer), jamais sur ce detail.
 *
 * CE QUE CE BANC NE PROUVE PAS, et pourquoi il ne le pretend pas.
 * L'effet de `untrusted-cert' sur une VRAIE session n'est pas montre ici,
 * parce qu'il n'est pas montrable aujourd'hui : mesure sur ce meme labo,
 * meme serveur, meme requete —
 *
 *   curl -sS -k https://192.168.20.10/  SANS profil d'inspection
 *     -> la page nginx est servie
 *   la meme requete AVEC `set status deep-inspection'
 *     -> curl: (35) OpenSSL SSL_connect: SSL routines::wrong version
 *        number, a l'identique pour `allow', `block' ET `ignore'
 *
 * L'interception casse donc TOUTE session TLS, quelle que soit la
 * decision. Un cas << a block, la session est refusee >> passerait ici
 * pour la mauvaise raison — la session echoue de toute facon — et
 * epinglerait un defaut comme contrat. Il a ete ecrit, mesure, puis
 * RETIRE. Le defaut d'interception est reel et distinct de ce lot ; il
 * est rapporte dans le message de commit avec cette mesure.
 *
 * Ce que le banc prouve donc pour `untrusted-cert' : que le critere
 * traverse les quatre maillons et parvient au profil que le moteur lit,
 * la ou il tombait avant au premier. La decision elle-meme est ecrite au
 * point ou la confiance est calculee.
 *
 * Discrimination : 4 cas sur 9, mesures par `git stash push -- src/network'.
 * Les cinq qui passent des deux cotes, et pourquoi :
 *
 *   - les deux cas << le CLI accepte le reglage et le rend >> sont le
 *     TEMOIN DU DEFAUT lui-meme : avant comme apres, le CLI acceptait et
 *     rendait. C'est precisement ce qui rendait le manque invisible, et
 *     ils sont la pour qu'une regression du CLI se voie.
 *   - << a `pass`, la meme application sans entree passe >> : la base
 *     laissait tout passer, elle avait donc raison par accident sur ce
 *     cas. Il garde que le reglage permissif reste permissif.
 *   - << une entree explicite garde la main >> : NON-REGRESSION. La
 *     precedence entree > defaut existait deja.
 *   - << temoin : sans profil applicatif, la navigation fonctionne >> :
 *     le TEMOIN du labo. Sans lui, un banc fait de blocages ne
 *     prouverait rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }

async function taper(device: Cmd, commands: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const command of commands) out.push(await device.executeCommand(command));
  return out;
}

function propre(sorties: string[]): void {
  for (const sortie of sorties) {
    expect(sortie).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);
  await srvDmz.executeCommand('systemctl start nginx');

  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall policy', 'edit 2', 'set name "LAN-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set schedule "always"',
    'set action accept', 'set logtraffic all', 'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz };
}

async function listeSansEntreePourHttp(
  fgt: FortiGate, autreAction: 'pass' | 'block',
): Promise<string[]> {
  return taper(fgt, [
    'config application list', 'edit "APP-Lab"',
    `set other-application-action ${autreAction}`,
    'config entries', 'edit 1',
    'set application "BITTORRENT"',
    'set action block',
    'next', 'end', 'next', 'end',
    'config firewall policy', 'edit 2',
    'set utm-status enable', 'set inspection-mode flow',
    'set application-list "APP-Lab"', 'next', 'end',
  ]);
}

const navigue = (pcLan: LinuxPC): Promise<string> =>
  pcLan.executeCommand('curl -sS http://192.168.20.10/');

async function inspectionProfonde(
  fgt: FortiGate, action: 'allow' | 'block' | 'ignore',
): Promise<string[]> {
  return taper(fgt, [
    'config firewall ssl-ssh-profile', 'edit "Deep-Lab"',
    'config https', 'set ports 443', 'set status deep-inspection', 'end',
    'set server-cert-mode re-sign',
    'set caname "Fortinet_CA_SSL"',
    'set untrusted-caname "Fortinet_CA_Untrusted"',
    `set untrusted-cert ${action}`,
    'next', 'end',
    'config firewall policy', 'edit 2',
    'set utm-status enable', 'set inspection-mode flow',
    'set ssl-ssh-profile "Deep-Lab"', 'next', 'end',
  ]);
}

describe('other-application-action decide du sort des applications hors liste', () => {
  it('le CLI accepte le reglage et le rend dans la configuration', async () => {
    const { fgt } = await laboratoire();
    propre(await listeSansEntreePourHttp(fgt, 'block'));
    const rendu = await fgt.executeCommand('show application list');
    expect(rendu).toMatch(/set other-application-action block/);
  });

  it('a `block`, une application sans entree est BLOQUEE', async () => {
    const { fgt, pcLan } = await laboratoire();
    expect(await navigue(pcLan)).toMatch(/<html|It works|nginx/i);

    propre(await listeSansEntreePourHttp(fgt, 'block'));

    expect(await navigue(pcLan)).not.toMatch(/<html|It works|nginx/i);
  });

  it('a `pass`, la meme application sans entree passe', async () => {
    const { fgt, pcLan } = await laboratoire();
    propre(await listeSansEntreePourHttp(fgt, 'pass'));

    expect(await navigue(pcLan)).toMatch(/<html|It works|nginx/i);
  });

  it('une entree explicite garde la main sur le reglage par defaut', async () => {
    const { fgt, pcLan } = await laboratoire();
    propre(await taper(fgt, [
      'config application list', 'edit "APP-Lab"',
      'set other-application-action block',
      'config entries', 'edit 1',
      'set application "HTTP.BROWSER"',
      'set action pass',
      'next', 'end', 'next', 'end',
      'config firewall policy', 'edit 2',
      'set utm-status enable', 'set inspection-mode flow',
      'set application-list "APP-Lab"', 'next', 'end',
    ]));

    expect(await navigue(pcLan)).toMatch(/<html|It works|nginx/i);
  });

  it('temoin : sans profil applicatif, la navigation fonctionne', async () => {
    const { pcLan } = await laboratoire();
    expect(await navigue(pcLan)).toMatch(/<html|It works|nginx/i);
  });
});

describe('untrusted-cert decide du sort d une session au certificat non fiable', () => {
  it('le CLI accepte le reglage et le rend dans la configuration', async () => {
    const { fgt } = await laboratoire();
    propre(await inspectionProfonde(fgt, 'block'));
    const rendu = await fgt.executeCommand('show firewall ssl-ssh-profile Deep-Lab');
    expect(rendu).toMatch(/set untrusted-cert block/);
  });

  it('le reglage atteint le profil que le moteur lit', async () => {
    const { fgt } = await laboratoire();
    propre(await inspectionProfonde(fgt, 'block'));
    expect(fgt.getUtmProfiles().getSslSsh('Deep-Lab')?.untrustedCert).toBe('block');
  });

  it('`ignore` et `allow` atteignent le moteur distinctement', async () => {
    const { fgt } = await laboratoire();
    propre(await inspectionProfonde(fgt, 'ignore'));
    expect(fgt.getUtmProfiles().getSslSsh('Deep-Lab')?.untrustedCert).toBe('ignore');

    propre(await inspectionProfonde(fgt, 'allow'));
    expect(fgt.getUtmProfiles().getSslSsh('Deep-Lab')?.untrustedCert).toBe('allow');
  });

  it('l application sans entree atteint aussi le moteur', async () => {
    const { fgt } = await laboratoire();
    propre(await listeSansEntreePourHttp(fgt, 'block'));
    expect(fgt.getUtmProfiles().getApplicationList('APP-Lab')?.otherApplicationAction)
      .toBe('block');
  });
});
