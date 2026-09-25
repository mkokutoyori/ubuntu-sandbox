/*
 * Le mot de passe tape a l'invite d'un `ssh` interactif ne traversait
 * pas le fil quand il etait faux, et une connexion reussie etait
 * inscrite deux fois.
 *
 * L'AUTORITE est OpenSSH, et RFC 4252 pour le protocole qu'il parle : le
 * mot de passe part dans un SSH_MSG_USERAUTH_REQUEST, c'est le SERVEUR
 * qui tranche, et `sshd` ecrit une ligne `Accepted password for U from IP
 * port P ssh2` par authentification reussie, une ligne `Failed password
 * ...` par echec. IOS, sous `login on-failure log`, ecrit un
 * `%SEC_LOGIN-4-LOGIN_FAILED` par echec.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire le lanceur.
 *
 * Mesure de depart, une ouverture interactive chacune, en comptant les
 * trames emises par le poste pendant `finalisePendingAuth` :
 *
 *   Linux, bon secret     9 trames    auth.log : 2 x `Accepted password`
 *   Linux, secret faux    0 trame     auth.log : 1 x `Failed password`
 *   Cisco, bon secret     8 trames
 *   Cisco, secret faux    0 trame     show logging : 1 x LOGIN_FAILED
 *
 * Zero trame pour un refus : le verdict ET sa trace etaient fabriques en
 * memoire, sur l'objet du pair. C'est le raccourci que la regle 4 de
 * `CLAUDE.md` refuse, et la raison pour laquelle il se voyait si peu :
 * la trace etait la bonne, seul le chemin etait faux.
 *
 * LA CAUSE. `finalisePendingAuth` appelait `verifyCredentials(target,
 * user, password)` — la base de comptes du pair, lue en memoire — et, si
 * le secret etait faux, inscrivait l'echec par
 * `target.recordSshLogin(false)` puis rendait `bad-password` sans jamais
 * ouvrir de connexion. Si le secret etait bon, il inscrivait la reussite
 * par `target.recordSshLogin(true)`, PUIS ouvrait la connexion, dont le
 * serveur inscrivait la reussite a son tour : deux `Accepted`, le premier
 * attribue au port de la connexion precedente.
 *
 * Le lanceur ne juge plus rien : il ouvre la connexion avec le secret
 * tape, et c'est la reponse du serveur — `auth-failed` ou non — qui fait
 * le verdict. L'inscription reste la ou le fil l'a mise.
 *
 * LE FIL A ALORS MONTRE SA PROPRE FAUTE : un secret faux, tape UNE fois,
 * y partait TROIS fois — trois `Failed password`, trois
 * `%SEC_LOGIN-4-LOGIN_FAILED`. `SshSession.doAuthenticate` offre jusqu'a
 * trois invites, et un mot de passe FOURNI d'avance etait rendu tel quel
 * a chacune. Or un secret fourni d'avance est une seule saisie : `sshpass`
 * l'envoie une fois et sort en code 5 (« Invalid/incorrect password ») a
 * la seconde invite, et l'utilisateur du lanceur n'a tape qu'une ligne,
 * le terminal redemandant la suivante. Un secret fourni ne part qu'une
 * fois — la regle que le gestionnaire silencieux portait deja, posee
 * desormais sur le fait et non sur le type de gestionnaire.
 *
 * Discriminee contre TROIS etats (`git stash push`) :
 *
 *  - avant les deux correctifs : 3 des 7 cas tombent — le secret faux
 *    traverse le fil, Linux et Cisco, et « une reussite, un Accepted » ;
 *  - le lanceur corrige SEUL : 2 des 7 tombent, les deux « un echec, une
 *    ligne » — c'est ce qui prouve que le correctif de `SshSession` est
 *    requis ;
 *  - les deux : 7 sur 7.
 *
 * Les cas qui passent avant sont nommes ici :
 *
 *  - TEMOINS DU VERDICT, Linux et Cisco : le bon secret ouvre, le faux
 *    refuse, des deux cotes. Deplacer le jugement ne doit pas changer ce
 *    qu'il juge.
 *  - LA TRACE, Linux et Cisco : un echec laisse exactement UNE ligne
 *    avant — par le jugement en memoire — et apres — par le serveur. Ils
 *    tombent a l'etat intermediaire, ou le fil la triplait.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  tryInterpretSshLaunch, finalisePendingAuth, type SshLaunchOptions,
} from '@/shell/sshLauncher';
import { reinstallDefaultShells } from '@/shell/registerDefaults';
import {
  configureCiscoSshServer, ROUTER_SSH_USER, ROUTER_SSH_PASSWORD,
} from './_helpers/routerSshFixtures';

const MASK = '255.255.255.0';
const HOST_IP = '10.0.0.1';
const SERVER_IP = '10.0.0.2';
const ROUTER_IP = '10.0.0.6';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  reinstallDefaultShells();
});

async function lab(): Promise<{ host: LinuxPC; srv: LinuxServer; r1: CiscoRouter }> {
  const host = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  const r1 = new CiscoRouter('R1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(host.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(r1.getPorts()[0], sw.getPorts()[2]);
  host.getPorts()[0].configureIP(new IPAddress(HOST_IP), new SubnetMask(MASK));
  srv.getPorts()[0].configureIP(new IPAddress(SERVER_IP), new SubnetMask(MASK));
  await srv.executeCommand('sudo systemctl start ssh');
  await configureCiscoSshServer(r1, ROUTER_IP, MASK, { interfaceName: 'GigabitEthernet0/0' });
  for (const c of ['enable', 'configure terminal', 'login on-failure log', 'end']) {
    await r1.executeCommand(c);
  }
  return { host, srv, r1 };
}

function launchOpts(host: LinuxPC): SshLaunchOptions {
  return {
    defaultUser: 'root',
    sourceIp: HOST_IP,
    sourceDevice: host,
    wireProbe: (h, p) => host.tcpConnectOutcome(new IPAddress(h), p),
  };
}

async function interactiveLogin(
  host: LinuxPC, target: string, password: string,
): Promise<{ verdict: string; frames: number }> {
  const launch = await tryInterpretSshLaunch(target, launchOpts(host));
  expect(launch?.kind).toBe('pending');
  const before = host.getPorts()[0].getCounters().framesOut;
  const outcome = await finalisePendingAuth(
    (launch as { pendingAuth: Parameters<typeof finalisePendingAuth>[0] }).pendingAuth,
    password,
  );
  return { verdict: outcome.kind, frames: host.getPorts()[0].getCounters().framesOut - before };
}

const authLog = (srv: LinuxServer): Promise<string> =>
  srv.executeCommand('sudo cat /var/log/auth.log');

describe('le secret faux traverse le fil', () => {
  it('vers Linux', async () => {
    const { host } = await lab();

    const { frames } = await interactiveLogin(host, `ssh alice@${SERVER_IP}`, 'faux');
    expect(frames).toBeGreaterThan(0);
  });

  it('vers IOS', async () => {
    const { host } = await lab();

    const { frames } = await interactiveLogin(host, `ssh ${ROUTER_SSH_USER}@${ROUTER_IP}`, 'faux');
    expect(frames).toBeGreaterThan(0);
  });
});

describe('une reussite, un `Accepted`', () => {
  it('auth.log porte UNE ligne pour UNE ouverture', async () => {
    const { host, srv } = await lab();
    await interactiveLogin(host, `ssh alice@${SERVER_IP}`, 'alice');

    expect((await authLog(srv)).match(/Accepted password for alice/g) ?? []).toHaveLength(1);
  });
});

describe('le verdict ne change pas — les TEMOINS', () => {
  it('Linux : le bon secret ouvre, le faux refuse', async () => {
    const { host } = await lab();

    expect((await interactiveLogin(host, `ssh alice@${SERVER_IP}`, 'alice')).verdict).toBe('success');
    expect((await interactiveLogin(host, `ssh alice@${SERVER_IP}`, 'faux')).verdict).toBe('bad-password');
  });

  it('IOS : le bon secret ouvre, le faux refuse', async () => {
    const { host } = await lab();
    const target = `ssh ${ROUTER_SSH_USER}@${ROUTER_IP}`;

    expect((await interactiveLogin(host, target, ROUTER_SSH_PASSWORD)).verdict).toBe('success');
    expect((await interactiveLogin(host, target, 'faux')).verdict).toBe('bad-password');
  });
});

describe('la trace d\'un echec ne se perd ni ne se double', () => {
  it('Linux : UN `Failed password`', async () => {
    const { host, srv } = await lab();
    await interactiveLogin(host, `ssh alice@${SERVER_IP}`, 'faux');

    expect((await authLog(srv)).match(/Failed password for alice/g) ?? []).toHaveLength(1);
  });

  it('IOS : UN `%SEC_LOGIN-4-LOGIN_FAILED`', async () => {
    const { host, r1 } = await lab();
    await interactiveLogin(host, `ssh ${ROUTER_SSH_USER}@${ROUTER_IP}`, 'faux');

    expect((await r1.executeCommand('show logging')).match(/%SEC_LOGIN-4-LOGIN_FAILED/g) ?? [])
      .toHaveLength(1);
  });
});
