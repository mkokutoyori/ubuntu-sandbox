/**
 * `execute vpn sslvpn list` montre une connexion qui a REELLEMENT eu lieu.
 *
 * Le portail SSL-VPN authentifiait et ne RETENAIT rien : `respond`
 * repondait la page de bienvenue et n'ecrivait nulle part qui venait
 * d'entrer, d'ou. Aucune des quatre commandes que la reference decrit
 * n'existait — « unknown action "vpn sslvpn" » — et il n'y avait, de
 * toute facon, rien a lister ni a couper. C'est le magasin qui manquait,
 * pas seulement la porte.
 *
 * `SslVpnSessionTable` le pose : index, utilisateur, groupe, adresse
 * source, mode, instant d'ouverture. Le portail y inscrit une session a
 * chaque authentification reussie, et seulement en mode WEB — ce build
 * n'a pas de client de tunnel, donc declarer des sessions de tunnel
 * serait inventer ce qu'aucun echange ne produit ; `list tunnel` rend
 * l'en-tete et aucune ligne, ce qui est la verite.
 *
 * **`idle-timeout` est declare ET evalue** : la colonne `Timeout` compte
 * le temps restant, et une session dont le compte est ecoule n'est plus
 * listee. Sans cela le reglage aurait ete un critere range que rien ne
 * lit, et la table aurait grossi indefiniment.
 *
 * La mise en forme vient de DEUX transcriptions independantes de vrais
 * FortiGate : deux sections, « SSL VPN Login Users: » avec ses colonnes
 * Index / User / Auth Type / Timeout / From / HTTP in/out / HTTPS in/out,
 * puis « SSL VPN sessions: » avec Index / User / Source IP / Duration /
 * I/O Bytes / Tunnel/Dest IP. L'ORDRE et les intitules sont donc attestes ;
 * les largeurs exactes ne le sont pas, les sources etant du HTML qui
 * ecrase les blancs, et elles sont posees par le module de tableaux du
 * depot. Les compteurs d'octets valent `0/0` parce que ce portail ne
 * compte pas les octets d'une session : c'est une mesure absente, pas un
 * chiffre invente.
 *
 * Discrimine par `git stash push` sur les fichiers SUIVIS, le magasin
 * etant un fichier neuf ecarte a la main : 9 cas tombent. Les 2 autres
 * sont nommes ici — « une authentification reussie rend la page de
 * bienvenue » est le TEMOIN du laboratoire, dont c'est l'objet de passer
 * des deux cotes, et « une authentification REFUSEE n'ouvre aucune
 * session » passait avant parce qu'AUCUNE session n'etait jamais
 * ouverte ; il ne garde que l'apres.
 *
 * Piege rencontre en le discriminant, et note ici pour la prochaine fois :
 * `git stash push` sur une liste contenant un fichier NON SUIVI abandonne
 * TOUT le remisage en silence, et la sonde passe alors contre un arbre
 * intact — c'est-a-dire qu'elle ne discrimine rien tout en ayant l'air de
 * le faire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem, privateKeyToPem } from '@/network/pki/pem';

const NOW = Date.UTC(2026, 0, 1);
const PORTAL_IP = '192.168.1.1';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function runOn(d: Cmd, cmds: string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function flat(pem: string): string { return pem.replace(/\s+/g, ' ').trim(); }

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function laboratoire(extra: readonly string[] = []) {
  let horloge = NOW;
  const autorite = CertificateAuthority.generate('CN = Labo VPN', { now: NOW - 86_400_000 });
  const issued = autorite.issueCertificate({
    subject: 'CN = portail.labo',
    notBefore: NOW - 3600_000,
    notAfter: NOW + 365 * 24 * 3600_000,
  });

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0, { now: () => horloge });
  const sh = new FortiShell(fw);
  const poste = new LinuxPC('linux-pc', 'POSTE', 100, 0);
  new Cable('lan').connect(poste.getPort('eth0')!, fw.getPort('port1')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    `set ip ${PORTAL_IP} 255.255.255.0`, 'set allowaccess ping', 'next', 'end',
    'config vpn certificate local',
    'edit "PORTAIL"',
    `set certificate "${flat(certToPem(issued.cert))}"`,
    `set private-key "${flat(privateKeyToPem(issued.privateKey))}"`,
    'next', 'end',
    'config user local',
    'edit "alice"', 'set type password', 'set passwd "MotDePasse1"', 'next', 'end',
    'config user group',
    'edit "vpn-users"', 'set member "alice"', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);

  run(sh,
    'config vpn ssl settings',
    'set status enable',
    'set servercert "PORTAIL"',
    'set source-interface "port1"',
    ...extra,
    'config authentication-rule',
    'edit 1', 'set groups "vpn-users"', 'set portal "full-access"', 'next', 'end',
    'end');

  return { fw, sh, poste, avancer: (secondes: number) => { horloge += secondes * 1000; } };
}

async function seConnecter(poste: LinuxPC, user: string, mdp: string): Promise<string> {
  return poste.executeCommand(
    `curl -sk -d "username=${user}&password=${mdp}" `
    + `https://${PORTAL_IP}:10443/remote/logincheck`);
}

describe('execute vpn sslvpn', () => {
  it('TEMOIN : une authentification reussie rend la page de bienvenue', async () => {
    const { poste } = await laboratoire();

    expect(await seConnecter(poste, 'alice', 'MotDePasse1')).toContain('Welcome, alice');
  });

  it('`list` montre la connexion sous les deux en-tetes attestes', async () => {
    const { sh, poste } = await laboratoire();
    await seConnecter(poste, 'alice', 'MotDePasse1');

    const vue = sh.execute('execute vpn sslvpn list');
    expect(vue).not.toMatch(/unknown action/i);
    expect(vue).toContain('SSL VPN Login Users:');
    expect(vue).toContain('SSL VPN sessions:');
    expect(vue).toContain('alice');
    expect(vue).toContain('192.168.1.10');
  });

  it('`list web` ne rend que la section des connexions au portail', async () => {
    const { sh, poste } = await laboratoire();
    await seConnecter(poste, 'alice', 'MotDePasse1');

    const vue = sh.execute('execute vpn sslvpn list web');
    expect(vue).toContain('SSL VPN Login Users:');
    expect(vue).not.toContain('SSL VPN sessions:');
    expect(vue).toContain('alice');
  });

  it('`list tunnel` rend l\'en-tete et aucune ligne', async () => {
    const { sh, poste } = await laboratoire();
    await seConnecter(poste, 'alice', 'MotDePasse1');

    const vue = sh.execute('execute vpn sslvpn list tunnel');
    expect(vue).toContain('SSL VPN sessions:');
    expect(vue).not.toContain('alice');
  });

  it('une authentification REFUSEE n\'ouvre aucune session', async () => {
    const { sh, poste } = await laboratoire();
    await seConnecter(poste, 'alice', 'PasCelui-La');

    expect(sh.execute('execute vpn sslvpn list web')).not.toContain('alice');
  });

  it('`del-web <index>` ferme cette connexion-la', async () => {
    const { sh, poste } = await laboratoire();
    await seConnecter(poste, 'alice', 'MotDePasse1');

    expect(sh.execute('execute vpn sslvpn del-web 0')).not.toMatch(/Command fail/i);
    expect(sh.execute('execute vpn sslvpn list web')).not.toContain('alice');
  });

  it('`del-tunnel` sur un index de connexion web est refuse', async () => {
    const { sh, poste } = await laboratoire();
    await seConnecter(poste, 'alice', 'MotDePasse1');

    expect(sh.execute('execute vpn sslvpn del-tunnel 0'))
      .toContain('no tunnel connection at index 0.');
    expect(sh.execute('execute vpn sslvpn list web')).toContain('alice');
  });

  it('`del-all` vide la table', async () => {
    const { sh, poste } = await laboratoire();
    await seConnecter(poste, 'alice', 'MotDePasse1');

    expect(sh.execute('execute vpn sslvpn del-all')).not.toMatch(/Command fail/i);
    expect(sh.execute('execute vpn sslvpn list web')).not.toContain('alice');
  });

  it('`idle-timeout` est evalue : la session tombe quand il expire', async () => {
    const { sh, poste, avancer } = await laboratoire(['set idle-timeout 60']);
    await seConnecter(poste, 'alice', 'MotDePasse1');

    expect(sh.execute('execute vpn sslvpn list web')).toContain('alice');
    avancer(61);
    expect(sh.execute('execute vpn sslvpn list web')).not.toContain('alice');
  });

  it('la colonne Timeout compte le temps restant', async () => {
    const { sh, poste, avancer } = await laboratoire(['set idle-timeout 300']);
    await seConnecter(poste, 'alice', 'MotDePasse1');
    avancer(4);

    expect(sh.execute('execute vpn sslvpn list web')).toMatch(/alice\s+1\(1\)\s+296\s/);
  });

  it('une operation inconnue est refusee', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('execute vpn sslvpn zorglub'))
      .toContain('unknown action "vpn sslvpn zorglub"');
  });
});
