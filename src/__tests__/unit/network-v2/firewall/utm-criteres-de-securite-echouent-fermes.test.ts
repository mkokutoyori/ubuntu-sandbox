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
 * L'EFFET SUR UNE VRAIE SESSION a d'abord ete indemontrable, et c'est
 * ce qui a mis au jour un second defaut, corrige depuis. Mesure d'alors,
 * sur ce meme labo :
 *
 *   curl -sS -k https://192.168.20.10/  sans profil d'inspection
 *     -> la page nginx est servie
 *   la meme requete AVEC `set status deep-inspection'
 *     -> curl: (35) ... wrong version number, a l'identique pour
 *        `allow', `block' ET `ignore'
 *
 * L'interception cassait TOUTE session TLS. Un cas << a block, la session
 * est refusee >> passait alors pour la mauvaise raison. Il avait ete
 * ecrit, mesure, puis RETIRE ; il est revenu ici une fois la cause
 * fermee — la session cliente amont abandonnait la poignee de main des
 * que le certificat du serveur ne se verifiait pas, sans jamais envoyer
 * son `Finished', de sorte qu'aucun serveur non deja de confiance ne
 * pouvait etre inspecte. C'est precisement le cas que `untrusted-cert'
 * existe pour arbitrer.
 *
 * Les trois valeurs se distinguent donc maintenant, et c'est le TRIO qui
 * fait la preuve : `block' ne prouverait rien seul — une session qui
 * echoue de toute facon le satisferait —, mais `allow' et `ignore' qui
 * SERVENT la page, a cote, etablissent que le refus vient bien de la
 * decision.
 *
 * Discrimination : 4 cas sur 9 pour le plombage des deux criteres, puis
 * 2 cas sur 13 pour le correctif d'interception, chacun mesure par
 * `git stash push -- src/network' contre l'etat qui le precede.
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
 *   - << temoin : sans profil applicatif, la navigation fonctionne >> et
 *     << temoin : sans profil d'inspection, la meme page HTTPS est
 *     servie >> : les deux TEMOINS du labo. Sans eux, un banc fait de
 *     blocages ne prouverait rien.
 *   - << a `block`, la session ... est REFUSEE >> ne discrimine pas le
 *     correctif d'interception, puisque la session echouait deja avant.
 *     Il ne vaut qu'accompagne de `allow' et `ignore', qui eux
 *     discriminent : c'est leur succes qui donne son sens a ce refus.
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

const navigueTls = (pcLan: LinuxPC): Promise<string> =>
  pcLan.executeCommand('curl -sS -k https://192.168.20.10/');

const SITE_HTTPS =
  'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n'
  + '  index index.nginx-debian.html;\\n'
  + '  ssl_certificate /etc/ssl/certs/srv.crt;\\n'
  + '  ssl_certificate_key /etc/ssl/private/srv.key;\\n}\\n';

async function servirHttpsAutoSigne(srvDmz: LinuxServer): Promise<void> {
  await srvDmz.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srvDmz.executeCommand(
    'openssl req -x509 -newkey rsa:512 -keyout /etc/ssl/private/srv.key '
    + '-out /etc/ssl/certs/srv.crt -days 365 -nodes -subj "/CN=192.168.20.10"');
  await srvDmz.executeCommand(
    `sh -c 'printf "${SITE_HTTPS}" > /etc/nginx/sites-available/default'`);
  await srvDmz.executeCommand('systemctl restart nginx');
}

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

  it('a `block`, la session vers un certificat auto-signe est REFUSEE', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await servirHttpsAutoSigne(srvDmz);
    propre(await inspectionProfonde(fgt, 'block'));

    expect(await navigueTls(pcLan)).not.toMatch(/<html|Welcome to nginx/i);
  });

  it('a `allow`, la meme session est inspectee ET servie', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await servirHttpsAutoSigne(srvDmz);
    propre(await inspectionProfonde(fgt, 'allow'));

    expect(await navigueTls(pcLan)).toMatch(/Welcome to nginx/i);
  });

  it('a `ignore`, la session est servie elle aussi', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await servirHttpsAutoSigne(srvDmz);
    propre(await inspectionProfonde(fgt, 'ignore'));

    expect(await navigueTls(pcLan)).toMatch(/Welcome to nginx/i);
  });

  it('temoin : sans profil d inspection, la meme page HTTPS est servie', async () => {
    const { pcLan, srvDmz } = await laboratoire();
    await servirHttpsAutoSigne(srvDmz);

    expect(await navigueTls(pcLan)).toMatch(/Welcome to nginx/i);
  });

  it('l application sans entree atteint aussi le moteur', async () => {
    const { fgt } = await laboratoire();
    propre(await listeSansEntreePourHttp(fgt, 'block'));
    expect(fgt.getUtmProfiles().getApplicationList('APP-Lab')?.otherApplicationAction)
      .toBe('block');
  });
});
