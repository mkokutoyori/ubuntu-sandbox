/**
 * Scénario 3 — Filtrage par ACL Cisco sur le port TCP 22 (couche réseau).
 *
 * Objectif : vérifier qu'on peut bloquer ou autoriser sélectivement le
 * trafic SSH entre deux sous-réseaux au niveau d'un commutateur de
 * niveau 3 (modélisé par un CiscoRouter — équivalent fonctionnel d'un
 * multilayer switch / SVI pour ce qui concerne le plan de données).
 *
 * Déroulé :
 *   - Trois sous-réseaux : admin (10.0.10.0/24), user (10.0.20.0/24),
 *     server (10.0.30.0/24), routés par un CiscoRouter.
 *   - Une ACL étendue 100 attachée en sortie sur l'interface serveur :
 *       permit tcp 10.0.10.0 0.0.0.255 host 10.0.30.10 eq 22
 *       deny   tcp any host 10.0.30.10 eq 22
 *       permit ip any any
 *   - Tentative SSH depuis admin-pc (autorisée), puis depuis user-pc
 *     (hors plage).
 *
 * Points de contrôle :
 *   - `show access-lists` affiche les entrées,
 *   - `show ip access-lists` montre les compteurs permit/deny qui
 *     s'incrémentent,
 *   - `tcpdump` côté client non autorisé montre un SYN sorti sans
 *     SYN-ACK retour.
 *
 * Critère de réussite : la machine autorisée établit la session,
 * la non autorisée n'obtient aucune réponse SYN-ACK (drop silencieux,
 * pas de RST actif).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Lan {
  adminPc: LinuxPC;
  userPc: LinuxPC;
  server: LinuxServer;
  router: CiscoRouter;
}

async function buildLan(): Promise<Lan> {
  const adminPc = new LinuxPC('linux-pc', 'admin-pc', 0, 0);
  const userPc  = new LinuxPC('linux-pc', 'user-pc',  0, 0);
  const server  = new LinuxServer('linux-server', 'server', 0, 0);
  const router  = new CiscoRouter('switch-l3');

  router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.10.1'), new SubnetMask('255.255.255.0'));
  router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.20.1'), new SubnetMask('255.255.255.0'));
  router.configureInterface('GigabitEthernet0/2', new IPAddress('10.0.30.1'), new SubnetMask('255.255.255.0'));

  new Cable('c1').connect(adminPc.getPorts()[0], router.getPorts()[0]);
  new Cable('c2').connect(userPc.getPorts()[0],  router.getPorts()[1]);
  new Cable('c3').connect(server.getPorts()[0],  router.getPorts()[2]);

  adminPc.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
  userPc.getPorts()[0].configureIP(new IPAddress('10.0.20.10'), new SubnetMask('255.255.255.0'));
  server.getPorts()[0].configureIP(new IPAddress('10.0.30.10'), new SubnetMask('255.255.255.0'));
  adminPc.setDefaultGateway(new IPAddress('10.0.10.1'));
  userPc.setDefaultGateway(new IPAddress('10.0.20.1'));
  server.setDefaultGateway(new IPAddress('10.0.30.1'));

  // Provision alice on the server side so authentication can succeed
  // for the *permitted* flow.
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'admin');

  return { adminPc, userPc, server, router };
}

async function installAcl(router: CiscoRouter) {
  for (const cmd of [
    'enable',
    'configure terminal',
    'access-list 100 permit tcp 10.0.10.0 0.0.0.255 host 10.0.30.10 eq 22',
    'access-list 100 deny tcp any host 10.0.30.10 eq 22',
    'access-list 100 permit ip any any',
    'interface GigabitEthernet0/2',
    'ip access-group 100 out',
    'end',
  ]) await router.executeCommand(cmd);
}

describe('Scénario 3 — ACL Cisco étendue filtrant SSH (TCP/22) entre VLANs', () => {
  it('show access-lists renvoie les trois entrées de l\'ACL 100', async () => {
    const { router } = await buildLan();
    await installAcl(router);
    const out = await router.executeCommand('show access-lists');
    expect(out).toMatch(/Extended IP access list 100/);
    expect(out).toMatch(/permit tcp 10\.0\.10\.0 0\.0\.0\.255 host 10\.0\.30\.10 eq 22/);
    expect(out).toMatch(/deny tcp any host 10\.0\.30\.10 eq 22/);
    expect(out).toMatch(/permit ip any any/);
  });

  it('la machine du sous-réseau d\'administration établit la session SSH', async () => {
    const { adminPc, server, router } = await buildLan();
    await installAcl(router);
    const out = await adminPc.executeCommand('ssh alice@10.0.30.10 whoami');
    expect(out).toMatch(/^alice\s*$/m);
    expect(out).not.toMatch(/Connection timed out/);
    expect(server).toBeDefined();
  });

  it('la machine hors plage est silencieusement droppée (Connection timed out)', async () => {
    const { userPc, router } = await buildLan();
    await installAcl(router);
    const out = await userPc.executeCommand('ssh alice@10.0.30.10 whoami');
    expect(out).toMatch(/Connection timed out/);
    expect(out).not.toMatch(/Connection refused/);
    expect(out).not.toMatch(/^alice\s*$/m);
  });

  it('show ip access-lists incrémente le compteur permit (admin) et deny (user)', async () => {
    const { adminPc, userPc, router } = await buildLan();
    await installAcl(router);

    await adminPc.executeCommand('ssh alice@10.0.30.10 whoami');
    await userPc.executeCommand('ssh alice@10.0.30.10 whoami');

    const out = await router.executeCommand('show ip access-lists 100');
    const permitLine = out.split('\n').find(l => /permit tcp 10\.0\.10\.0/.test(l)) ?? '';
    const denyLine   = out.split('\n').find(l => /deny tcp any host 10\.0\.30\.10 eq 22/.test(l)) ?? '';
    const permitMatches = parseInt(/\((\d+) match/.exec(permitLine)?.[1] ?? '0', 10);
    const denyMatches   = parseInt(/\((\d+) match/.exec(denyLine)?.[1] ?? '0', 10);
    expect(permitMatches).toBeGreaterThanOrEqual(1);
    expect(denyMatches).toBeGreaterThanOrEqual(1);
  });

  it('tcpdump côté user-pc montre le SYN sortant sans SYN-ACK en retour', async () => {
    const { userPc, router } = await buildLan();
    await installAcl(router);
    await userPc.executeCommand('ssh alice@10.0.30.10 whoami');

    const tcpdump = await userPc.executeCommand('tcpdump -nn');
    // The exact line shape comes from PacketCaptureLog → cmdTcpdump
    // (a `tcpdump` row carries "<src.ip>.<src.port> > <dst.ip>.<dst.port>:
    // Flags [<flags>]"). We assert (a) a SYN went out toward 10.0.30.10:22
    // and (b) no SYN-ACK came back (no S. flag from 10.0.30.10:22).
    expect(tcpdump).toMatch(/10\.0\.30\.10\.22.*Flags \[S\]|10\.0\.30\.10\.22:\s*Flags \[S\]|> 10\.0\.30\.10\.22:.*Flags \[S\]/);
    expect(tcpdump).not.toMatch(/10\.0\.30\.10\.22 > .*Flags \[S\.\]/);
  });

  it('sans ACL, la même connexion depuis user-pc passe (sanity)', async () => {
    const { userPc, router } = await buildLan();
    // Pas d'ACL → tout passe.
    expect(router).toBeDefined();
    const out = await userPc.executeCommand('ssh alice@10.0.30.10 whoami');
    expect(out).toMatch(/^alice\s*$/m);
    expect(out).not.toMatch(/Connection timed out/);
  });
});
