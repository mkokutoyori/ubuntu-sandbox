/**
 * Scénario 6 — SSH et AAA sur équipements Huawei (purement Huawei).
 *
 * Couvre rsa local-key-pair/stelnet server enable, aaa local-user,
 * user-interface vty authentication-mode aaa + protocol inbound ssh, et le
 * chaînage domain → authentication-scheme → radius-server template avec un
 * vrai serveur RADIUS (le FreeRADIUS simulé sur un LinuxServer), en passant
 * par le point d'intégration réel qu'utilise le serveur SSH du routeur
 * (`authenticateViaAaa`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
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

interface Lab { ar1: HuaweiRouter; client: LinuxPC; radiusSrv: LinuxServer; sw: GenericSwitch }

function buildLab(): Lab {
  const ar1 = new HuaweiRouter('AR1');
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const radiusSrv = new LinuxServer('linux-server', 'RADIUS-SRV');
  const sw = new GenericSwitch('switch-generic', 'SW1', 4, 0, 0);
  new Cable('c1').connect(ar1.getPort('GE0/0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(client.getPort('eth0')!, sw.getPorts()[1]);
  new Cable('c3').connect(radiusSrv.getPort('eth0')!, sw.getPorts()[2]);
  return { ar1, client, radiusSrv, sw };
}

async function configureRouterBase(ar1: HuaweiRouter): Promise<void> {
  await ar1.executeCommand('system-view');
  await ar1.executeCommand('interface GigabitEthernet 0/0/0');
  await ar1.executeCommand('ip address 10.0.0.1 24');
  await ar1.executeCommand('undo shutdown');
  await ar1.executeCommand('quit');
  await ar1.executeCommand('rsa local-key-pair create');
  await ar1.executeCommand('stelnet server enable');
  await ar1.executeCommand('aaa');
  await ar1.executeCommand('local-user admin password cipher Admin@123');
  await ar1.executeCommand('local-user admin privilege level 15');
  await ar1.executeCommand('local-user admin service-type ssh');
  await ar1.executeCommand('quit');
  await ar1.executeCommand('user-interface vty 0 4');
  await ar1.executeCommand('authentication-mode aaa');
  await ar1.executeCommand('protocol inbound ssh');
  await ar1.executeCommand('quit');
  await ar1.executeCommand('return');
}

async function configureClientAndRadiusServer(client: LinuxPC, radiusSrv: LinuxServer): Promise<void> {
  await client.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await radiusSrv.executeCommand('ifconfig eth0 10.0.0.3 netmask 255.255.255.0');
}

describe('Scénario 6 — SSH et AAA sur équipements Huawei', () => {
  describe('prise en main SSH', () => {
    it('rsa local-key-pair create, stelnet server enable et local-user sont acceptés et reflétés', async () => {
      const { ar1 } = buildLab();
      await configureRouterBase(ar1);

      const pubKey = await ar1.executeCommand('display rsa local-key-pair public');
      expect(pubKey).not.toMatch(/Unrecognized|Error/);

      const runningConfig = await ar1.executeCommand('display current-configuration');
      expect(runningConfig).toMatch(/stelnet server enable/);
      expect(runningConfig).toMatch(/local-user admin/);
      expect(runningConfig).toMatch(/authentication-mode aaa/);
      expect(runningConfig).toMatch(/protocol inbound ssh/);

      const u = ar1._getLocalUser('admin');
      expect(u?.privilege).toBe(15);
    });
  });

  describe('authentification locale via aaa (sans RADIUS configuré)', () => {
    it('un utilisateur local valide passe, un mauvais mot de passe échoue', async () => {
      const { ar1 } = buildLab();
      await configureRouterBase(ar1);

      expect(await ar1.authenticateViaAaa('admin', 'Admin@123')).toBe(true);
      expect(await ar1.authenticateViaAaa('admin', 'wrong-password')).toBe(false);
    });
  });

  describe('RADIUS via domain/authentication-scheme/radius-server template', () => {
    it('un utilisateur connu uniquement du serveur RADIUS peut se connecter', async () => {
      const { ar1, client, radiusSrv } = buildLab();
      await configureRouterBase(ar1);
      await configureClientAndRadiusServer(client, radiusSrv);

      radiusSrv.getRadiusServer().setSharedSecret('huawei-secret');
      radiusSrv.getRadiusServer().addUser('raduser', 'radpass');
      // Confirm this user is genuinely absent from the router's own local
      // database — any acceptance below can only come from RADIUS.
      expect(ar1._getLocalUser('raduser')).toBeUndefined();

      await ar1.executeCommand('system-view');
      await ar1.executeCommand('radius-server template RADIUS1');
      await ar1.executeCommand('radius-server authentication 10.0.0.3 1812');
      await ar1.executeCommand('radius-server shared-key cipher huawei-secret');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('aaa');
      await ar1.executeCommand('authentication-scheme radius_first');
      await ar1.executeCommand('authentication-mode radius local');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('domain huawei.com');
      await ar1.executeCommand('authentication-scheme radius_first');
      await ar1.executeCommand('radius-server group RADIUS1');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('return');

      const accepted = await ar1.authenticateViaAaa('raduser@huawei.com', 'radpass');
      expect(accepted).toBe(true);
    });

    it('un mauvais mot de passe RADIUS est rejeté', async () => {
      const { ar1, client, radiusSrv } = buildLab();
      await configureRouterBase(ar1);
      await configureClientAndRadiusServer(client, radiusSrv);

      radiusSrv.getRadiusServer().setSharedSecret('huawei-secret');
      radiusSrv.getRadiusServer().addUser('raduser', 'radpass');

      await ar1.executeCommand('system-view');
      await ar1.executeCommand('radius-server template RADIUS1');
      await ar1.executeCommand('radius-server authentication 10.0.0.3 1812');
      await ar1.executeCommand('radius-server shared-key cipher huawei-secret');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('aaa');
      await ar1.executeCommand('authentication-scheme radius_first');
      await ar1.executeCommand('authentication-mode radius local');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('domain huawei.com');
      await ar1.executeCommand('authentication-scheme radius_first');
      await ar1.executeCommand('radius-server group RADIUS1');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('return');

      const accepted = await ar1.authenticateViaAaa('raduser@huawei.com', 'wrong-password');
      expect(accepted).toBe(false);
    });

    it('un groupe radius-server référençant un template inexistant retombe sur l\'authentification locale', async () => {
      const { ar1 } = buildLab();
      await configureRouterBase(ar1);

      await ar1.executeCommand('system-view');
      await ar1.executeCommand('aaa');
      await ar1.executeCommand('authentication-scheme radius_first');
      await ar1.executeCommand('authentication-mode radius local');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('domain huawei.com');
      await ar1.executeCommand('authentication-scheme radius_first');
      await ar1.executeCommand('radius-server group DOES-NOT-EXIST');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('return');

      // admin@huawei.com resolves the domain, but the RADIUS group is a
      // dangling reference — the local part of the chain still succeeds.
      expect(await ar1.authenticateViaAaa('admin@huawei.com', 'Admin@123')).toBe(true);
    });
  });

  describe('display radius-server configuration et display ssh server session', () => {
    it('affiche le template RADIUS réel configuré', async () => {
      const { ar1 } = buildLab();
      await configureRouterBase(ar1);

      await ar1.executeCommand('system-view');
      await ar1.executeCommand('radius-server template RADIUS1');
      await ar1.executeCommand('radius-server authentication 10.0.0.3 1812');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('return');

      const out = await ar1.executeCommand('display radius-server configuration');
      expect(out).toContain('RADIUS1');
      expect(out).toContain('10.0.0.3');
      expect(out).toContain('1812');
    });

    it('affiche une session SSH réelle pendant son exécution', async () => {
      const { ar1, client } = buildLab();
      await configureRouterBase(ar1);
      await client.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const out = await client.executeCommand('ssh admin@10.0.0.1 "display ssh server session"');
      expect(out).toContain('admin');
      expect(out).toContain('10.0.0.2');
    });
  });

  describe('critère de réussite', () => {
    it('config SSH/AAA acceptée, RADIUS authentifie un utilisateur distant, compteurs et display cohérents', async () => {
      const { ar1, client, radiusSrv } = buildLab();
      await configureRouterBase(ar1);
      await configureClientAndRadiusServer(client, radiusSrv);

      radiusSrv.getRadiusServer().setSharedSecret('huawei-secret');
      radiusSrv.getRadiusServer().addUser('raduser', 'radpass');

      await ar1.executeCommand('system-view');
      await ar1.executeCommand('radius-server template RADIUS1');
      await ar1.executeCommand('radius-server authentication 10.0.0.3 1812');
      await ar1.executeCommand('radius-server shared-key cipher huawei-secret');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('aaa');
      await ar1.executeCommand('authentication-scheme radius_first');
      await ar1.executeCommand('authentication-mode radius local');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('domain huawei.com');
      await ar1.executeCommand('authentication-scheme radius_first');
      await ar1.executeCommand('radius-server group RADIUS1');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('return');

      expect(await ar1.authenticateViaAaa('raduser@huawei.com', 'radpass')).toBe(true);
      // No domain suffix → the 'default' domain, which has no scheme bound
      // and so falls back to plain local authentication.
      expect(await ar1.authenticateViaAaa('admin', 'Admin@123')).toBe(true);
      expect(await ar1.authenticateViaAaa('raduser@huawei.com', 'wrong')).toBe(false);

      const radiusDisplay = await ar1.executeCommand('display radius-server configuration');
      expect(radiusDisplay).toContain('RADIUS1');
    });
  });
});
