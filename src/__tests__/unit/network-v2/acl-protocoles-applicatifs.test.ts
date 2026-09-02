/**
 * Les protocoles APPLICATIFS a travers un routeur qui filtre.
 *
 * ── La lacune que ce fichier comble ─────────────────────────────────
 *
 * Mesure faite avant d'ecrire : 82 fichiers de ce depot eprouvent SMTP,
 * FTP, HTTP et la messagerie. CINQ font traverser un routeur. UN SEUL
 * pose une liste de controle — et c'est le serveur HTTP du routeur
 * LUI-MEME (`ip http access-class`), donc pas du trafic applicatif qui
 * TRANSITE. Autrement dit, ces protocoles etaient tous eprouves en
 * tete-a-tete, sur un cable direct, et aucun ne l'avait jamais ete a
 * travers une machine qui filtre.
 *
 * Les fichiers voisins couvrent ce qui roule SUR IP — ICMP, TCP, UDP,
 * OSPF, EIGRP, RIP, BGP, DHCP, IKE, ESP, HSRP, VRRP, GLBP, IGMP, PIM.
 * Celui-ci monte d'un etage.
 *
 * ── Ce que la mesure a trouve, et il faut le dire d'emblee ──────────
 *
 * **Aucun defaut.** Les cinq protocoles se comportent correctement a
 * travers le filtre. Ce fichier n'est donc pas un correctif : c'est de
 * la couverture, et un garde-fou pour le jour ou un changement du plan
 * de donnees casserait l'un d'eux sans que rien ne le dise.
 *
 * ── Le cas qui vaut a lui seul le fichier : FTP ─────────────────────
 *
 * `permit tcp any any eq 21` — la ligne que tout le monde ecrit — donne
 * ceci, mesure :
 *
 *   banniere 220, login 230, PASV 227 ... et ZERO ligne de donnees.
 *
 * Le canal de CONTROLE fonctionne de bout en bout, et le transfert
 * echoue en silence. C'est la panne FTP canonique derriere un filtre :
 * la connexion de donnees passive vise un port HAUT negocie dans la
 * reponse 227, que la ligne `eq 21` ne couvre pas. L'operateur voit sa
 * session s'ouvrir et conclut que la liste est bonne.
 *
 * **FTPS rend la meme lecon plus tranchante** : la poignee de main TLS
 * aboutit (234), le login passe (230), `PROT P` est accepte (200) — et
 * le fichier revient `null`. Et la, aucune passerelle applicative ne
 * peut sauver la situation, puisque la reponse 227 est CHIFFREE : le
 * routeur ne peut pas y lire le port pour ouvrir un passage. C'est la
 * raison operationnelle pour laquelle FTPS est difficile a filtrer, et
 * elle est ici observable plutot que racontee.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * `ACLEngine.evaluateForDataPlane` neutralise (rendant `permit` sans
 * lire la liste), 6 des 18 cas tombent : les blocages HTTP, SMTP (dont
 * le mauvais port) et FTP, plus les DEUX cas `eq 21` de FTP et FTPS —
 * ces derniers etant les plus parlants, puisque sous un moteur permissif
 * les donnees passent et le transfert reussit. Les temoins et les cas
 * « la bonne ligne retablit » passent des deux cotes par construction,
 * leur verdict attendu etant que le trafic passe.
 *
 * **Les quatre cas SSH ne tombent pas sous CETTE neutralisation, et la
 * raison a ete trouvee.** `ssh … whoami` lance depuis `executeCommand`
 * ne traverse PAS le fil : une prise posee sur le port du serveur voit
 * les deux trames d'un `ping` et ZERO trame pendant un SSH qui reussit
 * pourtant. `LinuxSshClient` appelle `transitTcpAclVerdict`
 * (`network/HostLookup.ts`), qui parcourt la topologie et evalue un SYN
 * SYNTHETIQUE contre la liste de chaque routeur du chemin — par
 * `evaluateACLByName`, une SECONDE implantation de « ce paquet
 * passerait-il ? », distincte de `evaluateForDataPlane` que suit le vrai
 * plan de donnees.
 *
 * D'ou les trois observations qui semblaient contradictoires : aucune
 * trame, la liste mord quand meme, et neutraliser le plan de donnees ne
 * change rien. Neutraliser `evaluateACLByName` a la place fait tomber
 * EXACTEMENT ces deux cas de blocage — verifie.
 *
 * Ces cas discriminent donc bien, sur l'autre fonction ; et ils gardent
 * en plus le COUPLE `eq 22` marche / `eq 23` non, sur le meme
 * laboratoire, qu'un moteur ignorant les ports ne produirait pas. Le
 * defaut de fond — SSH ne traverse pas le fil — est inscrit au
 * `TODO.md`, la regle du depot etant que tout echange entre deux
 * machines DOIT passer par de vraies trames.
 *
 * Note pour qui refera la mesure : le plan de donnees appelle
 * `evaluateForDataPlane` et non `evaluateACL`.
 *
 * ── Un piege de mesure rencontre en ecrivant ────────────────────────
 *
 * La premiere version de FTPS rendait `AUTH TLS = 502` dans les QUATRE
 * cas, ACL comprise. Ce n'etait pas un defaut du produit : le serveur
 * n'avait recu aucun certificat et le client aucun verificateur, donc
 * la commande etait refusee avant que la liste ait son mot a dire. Un
 * temoin SANS liste qui echoue est toujours le signe d'un laboratoire
 * faux, jamais d'une fonction cassee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { FtpServer } from '@/network/ftp/FtpServer';
import { FtpClientSession } from '@/network/ftp/FtpClientSession';
import { SmtpServer } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const DENY_TOUT = 'access-list 100 deny ip any any';
const NOW = Date.now();

/** Client — R1 — serveur, la liste posee EN ENTREE du cote client. */
async function labo(acl: readonly string[]) {
  const routeur = new CiscoRouter('R1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  new Cable('c1').connect(routeur.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  new Cable('c2').connect(routeur.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);
  for (const commande of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    ...acl,
    ...(acl.length
      ? ['interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit'] : []),
    'end']) {
    await routeur.executeCommand(commande);
  }
  pc.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  pc.setDefaultGateway(new IPAddress('10.0.1.1'));
  srv.configureInterface('eth0', new IPAddress('10.0.2.10'), new SubnetMask('255.255.255.0'));
  srv.setDefaultGateway(new IPAddress('10.0.2.1'));
  // Cache ARP chaud : les clients FTP et SMTP sont SYNCHRONES, donc une
  // premiere trame mise en file par la resolution ferait echouer la
  // connexion pour une raison etrangere a la liste.
  await pc.executeCommand('ping -c 1 10.0.2.10');
  return { routeur, pc, srv };
}

async function httpRepond(acl: readonly string[]): Promise<string> {
  const { pc, srv } = await labo(acl);
  await srv.executeCommand('sudo systemctl start nginx');
  const sortie = await pc.executeCommand(
    'curl -s -o /dev/null -w "%{http_code}" http://10.0.2.10/');
  return sortie.trim();
}

/** Le sujet du message REELLEMENT accepte par le serveur, ou null. */
async function smtpLivre(acl: readonly string[]): Promise<string | null> {
  const { pc, srv } = await labo(acl);
  const recues: string[] = [];
  const server = new SmtpServer(srv.getTcpStack(),
    { hostname: 'mail.example.com', users: new Map([['alice', 'Wonderland1']]),
      allowPlainTextAuth: true },
    25, { onMessageAccepted: (m) => { recues.push(m.message.headers.get('Subject') ?? ''); } });
  server.start();
  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.2.10', '10.0.1.10');
  if (client.connect()?.code !== 220) return null;
  client.sendCommand({ verb: 'EHLO', argument: 'pc1.example.com' });
  client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.com>' });
  client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.com>' });
  client.sendCommand({ verb: 'DATA' });
  client.sendDataBody('Subject: essai\r\n\r\ncorps\r\n');
  return recues[0] ?? null;
}

async function sshRepond(acl: readonly string[]): Promise<string> {
  const { pc, srv } = await labo(acl);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  return (await pc.executeCommand(
    'ssh -o StrictHostKeyChecking=no alice@10.0.2.10 whoami')).trim();
}

function serveurFtp(srv: LinuxServer, chiffre: boolean) {
  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/ftp', 0o755, 1000, 1000);
  vfs.writeFile('/srv/ftp/hello.txt', 'bonjour ftp', 1000, 1000, 0o022);
  const ca = CertificateAuthority.generate('CN=ftps-ca', { now: NOW });
  const issued = ca.issueCertificate(
    { subject: 'CN=ftp.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const server = new FtpServer(srv.getTcpStack(), '10.0.2.10', {
    users: new Map([['alice', 'wonderland']]),
    fs: new LinuxSftpFSAdapter(vfs, 1000, 1000),
    rootPath: '/srv/ftp',
    ...(chiffre ? { ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } } : {}),
  });
  server.start();
  const verifier = new CertificateVerifier(
    { trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return { verifier };
}

interface EtapesFtp { controle: boolean; donnees: string | null }

/** Le controle et les DONNEES sont deux verdicts, et c'est tout l'objet. */
async function ftpEtapes(acl: readonly string[], chiffre: boolean): Promise<EtapesFtp> {
  const { pc, srv } = await labo(acl);
  const { verifier } = serveurFtp(srv, chiffre);
  const client = new FtpClientSession(
    pc.getTcpStack(), '10.0.2.10', '10.0.1.10', undefined, chiffre ? { verifier } : undefined);

  if (client.connect()?.code !== 220) return { controle: false, donnees: null };
  if (chiffre && client.authTls()?.code !== 234) return { controle: false, donnees: null };
  client.sendCommand({ verb: 'USER', argument: 'alice' });
  if (client.sendCommand({ verb: 'PASS', argument: 'wonderland' })?.code !== 230) {
    return { controle: false, donnees: null };
  }
  if (chiffre) client.setDataProtectionLevel('P');
  client.enterPassiveMode();
  return { controle: true, donnees: client.retrieveFile('hello.txt').content };
}

describe('HTTP a travers le filtre', () => {
  it('TEMOIN : sans liste, nginx repond 200', async () => {
    expect(await httpRepond([])).toBe('200');
  });

  it('`deny ip any any` coupe la requete', async () => {
    expect(await httpRepond([DENY_TOUT])).not.toBe('200');
  });

  it('`permit tcp any any eq 80` la retablit', async () => {
    expect(await httpRepond(
      ['access-list 100 permit tcp any any eq 80', DENY_TOUT])).toBe('200');
  });
});

describe('SMTP a travers le filtre', () => {
  it('TEMOIN : sans liste, le message est accepte', async () => {
    expect(await smtpLivre([])).toBe('essai');
  });

  it('`deny ip any any` empeche jusqu\'a la banniere', async () => {
    expect(await smtpLivre([DENY_TOUT])).toBeNull();
  });

  it('`permit tcp any any eq 25` retablit la remise', async () => {
    expect(await smtpLivre(
      ['access-list 100 permit tcp any any eq 25', DENY_TOUT])).toBe('essai');
  });

  it('le port 80 ne sauve pas le courrier — le NUMERO decide', async () => {
    expect(await smtpLivre(
      ['access-list 100 permit tcp any any eq 80', DENY_TOUT])).toBeNull();
  });
});

describe('SSH a travers le filtre', () => {
  it('TEMOIN : sans liste, la commande distante s\'execute', async () => {
    expect(await sshRepond([])).toBe('alice');
  });

  it('`deny ip any any` la fait expirer', async () => {
    expect(await sshRepond([DENY_TOUT])).toContain('Connection timed out');
  });

  it('`permit tcp any any eq 22` la retablit', async () => {
    expect(await sshRepond(
      ['access-list 100 permit tcp any any eq 22', DENY_TOUT])).toBe('alice');
  });

  it('le port 23 ne sauve pas SSH', async () => {
    expect(await sshRepond(
      ['access-list 100 permit tcp any any eq 23', DENY_TOUT])).toContain('Connection timed out');
  });
});

describe('FTP — le controle passe et les DONNEES tombent', () => {
  it('TEMOIN : sans liste, le fichier arrive', async () => {
    expect(await ftpEtapes([], false)).toEqual({ controle: true, donnees: 'bonjour ftp' });
  });

  it('`deny ip any any` coupe des la banniere', async () => {
    expect(await ftpEtapes([DENY_TOUT], false)).toEqual({ controle: false, donnees: null });
  });

  it('`permit tcp … eq 21` ouvre la session et PERD le transfert', async () => {
    expect(await ftpEtapes(
      ['access-list 100 permit tcp any any eq 21', DENY_TOUT], false))
      .toEqual({ controle: true, donnees: null });
  });

  it('`permit tcp any any` rend le transfert', async () => {
    expect(await ftpEtapes(['access-list 100 permit tcp any any', DENY_TOUT], false))
      .toEqual({ controle: true, donnees: 'bonjour ftp' });
  });
});

describe('FTPS — meme lecon, et aucune passerelle ne peut aider', () => {
  it('TEMOIN : sans liste, le fichier chiffre arrive', async () => {
    expect(await ftpEtapes([], true)).toEqual({ controle: true, donnees: 'bonjour ftp' });
  });

  it('`permit tcp … eq 21` laisse monter le TLS et perd le fichier', async () => {
    expect(await ftpEtapes(
      ['access-list 100 permit tcp any any eq 21', DENY_TOUT], true))
      .toEqual({ controle: true, donnees: null });
  });

  it('`permit tcp any any` le rend', async () => {
    expect(await ftpEtapes(['access-list 100 permit tcp any any', DENY_TOUT], true))
      .toEqual({ controle: true, donnees: 'bonjour ftp' });
  });
});
