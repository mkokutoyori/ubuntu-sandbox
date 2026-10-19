/*
 * Le `ssh` interactif ne touche plus l'objet du pair avant de parler : il
 * ouvre UNE connexion, et c'est le serveur qui annonce son invite de mot
 * de passe, son verdict, son message du jour et le type de son shell.
 *
 * L'AUTORITE est OpenSSH : `ssh user@host` ouvre la connexion TCP, negocie,
 * puis affiche l'invite que le SERVEUR a demandee (RFC 4252 §5.1), et un
 * refus de connexion est la reponse TCP du pair (RST), pas un verdict
 * rendu avant d'avoir emis une trame.
 *
 * Mesure de depart, trames emises par le poste (`framesOut`) :
 *
 *   ssh vers sshd arrete          0 trame   (« Connection refused » lu sur l'etat du pair)
 *   ssh vers Linux, invite        0 trame   (aucune connexion avant la saisie)
 *   ssh vers Cisco, invite        0 trame
 *   mauvais secret, Linux         20 trames (connexion ouverte seulement apres la saisie)
 *
 * Apres : un refus coute des trames (SYN puis RST), et l'invite n'existe
 * que parce qu'une connexion chiffree est deja ouverte.
 *
 * Discriminee par `git stash push -- src/network src/terminal src/shell` :
 * avant, 3 des 6 cas tombent (le refus, l'invite Linux, l'invite Cisco
 * n'emettent aucune trame). Les 3 autres passent des deux cotes et sont
 * des TEMOINS : le refus garde sa phrase, le bon secret ouvre un shell
 * et le mauvais rend `bad-password`, et la banniere du routeur porte
 * son `banner motd` — deplacer l'origine de l'information ne
 * change pas ce qu'elle dit.
 */
import { allowLegacyIosSsh } from './iosLegacySsh';
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
  allowLegacyIosSsh(host);
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  allowLegacyIosSsh(srv);
  const r1 = new CiscoRouter('R1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(host.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(r1.getPorts()[0], sw.getPorts()[2]);
  host.getPorts()[0].configureIP(new IPAddress(HOST_IP), new SubnetMask(MASK));
  srv.getPorts()[0].configureIP(new IPAddress(SERVER_IP), new SubnetMask(MASK));
  await srv.executeCommand('sudo systemctl start ssh');
  await configureCiscoSshServer(r1, ROUTER_IP, MASK, { interfaceName: 'GigabitEthernet0/0' });
  return { host, srv, r1 };
}

function launchOpts(host: LinuxPC): SshLaunchOptions {
  return { defaultUser: 'root', sourceIp: HOST_IP, sourceDevice: host };
}

const framesOut = (host: LinuxPC): number => host.getPorts()[0].getCounters().framesOut;

describe('une seule connexion, decidee par le serveur', () => {
  it('un refus emet des trames : le RST du pair, pas un verdict lu dans sa memoire', async () => {
    const { host, srv } = await lab();
    await srv.executeCommand('sudo systemctl stop ssh');
    const before = framesOut(host);
    const attempt = await tryInterpretSshLaunch(`ssh root@${SERVER_IP}`, launchOpts(host));
    expect(attempt?.kind).toBe('error');
    expect(framesOut(host) - before).toBeGreaterThan(0);
  });

  it('l\'invite Linux n\'existe que sur une connexion deja ouverte', async () => {
    const { host } = await lab();
    const before = framesOut(host);
    const attempt = await tryInterpretSshLaunch(`ssh root@${SERVER_IP}`, launchOpts(host));
    expect(attempt?.kind).toBe('pending');
    expect(framesOut(host) - before).toBeGreaterThan(0);
  });

  it('l\'invite Cisco n\'existe que sur une connexion deja ouverte', async () => {
    const { host } = await lab();
    const before = framesOut(host);
    const attempt = await tryInterpretSshLaunch(`ssh ${ROUTER_SSH_USER}@${ROUTER_IP}`, launchOpts(host));
    expect(attempt?.kind).toBe('pending');
    expect(framesOut(host) - before).toBeGreaterThan(0);
  });

  it('TEMOIN : un refus garde sa phrase', async () => {
    const { host, srv } = await lab();
    await srv.executeCommand('sudo systemctl stop ssh');
    const attempt = await tryInterpretSshLaunch(`ssh root@${SERVER_IP}`, launchOpts(host));
    expect(attempt?.result.output.join('\n')).toMatch(/Connection refused/);
  });

  it('TEMOIN : le bon secret ouvre un shell, le faux rend bad-password', async () => {
    const { host, srv } = await lab();
    const userMgr = (srv as unknown as {
      executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void } };
    }).executor.userMgr;
    userMgr.useradd('alice', { m: true });
    userMgr.setPassword('alice', 'alicepw');
    const bad = await tryInterpretSshLaunch(`ssh alice@${SERVER_IP}`, launchOpts(host));
    const badOutcome = await finalisePendingAuth(
      (bad as { pendingAuth: Parameters<typeof finalisePendingAuth>[0] }).pendingAuth, 'nope');
    expect(badOutcome.kind).toBe('bad-password');
    const good = await tryInterpretSshLaunch(`ssh alice@${SERVER_IP}`, launchOpts(host));
    const goodOutcome = await finalisePendingAuth(
      (good as { pendingAuth: Parameters<typeof finalisePendingAuth>[0] }).pendingAuth, 'alicepw');
    expect(goodOutcome.kind).toBe('success');
  });

  it('TEMOIN : la banniere du routeur porte son banner motd', async () => {
    const { host, r1 } = await lab();
    for (const c of ['enable', 'configure terminal', 'banner motd #Bienvenue sur R1#', 'end']) {
      await r1.executeCommand(c);
    }
    const attempt = await tryInterpretSshLaunch(`ssh ${ROUTER_SSH_USER}@${ROUTER_IP}`, launchOpts(host));
    const outcome = await finalisePendingAuth(
      (attempt as { pendingAuth: Parameters<typeof finalisePendingAuth>[0] }).pendingAuth, ROUTER_SSH_PASSWORD);
    expect(outcome.kind).toBe('success');
    expect((outcome as { banner: readonly string[] }).banner.join('\n')).toContain('Bienvenue sur R1');
  });
});
