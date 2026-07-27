/**
 * Scénario 2 (debug Cisco) — `debug ip routing` : tracer la convergence
 * de la table de routage.
 *
 * Transcription littérale : activation sans filtre ACL (le debug ne trace
 * que les changements de table, pas le trafic), puis observation des
 * `RT: add` / `RT: del` lors de la perte et du retour d'une route, et
 * lors du basculement d'une route flottante.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 2 (debug) — debug ip routing', () => {
  let rtr: CiscoRouter;
  let pc: LinuxPC;
  let lien: Cable;
  let lignes: string[];
  let g0: string;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    rtr = new CiscoRouter('RTR-MANDENG-01');
    rtr.powerOn();
    pc = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    pc.powerOn();

    [g0] = rtr.getPortNames();
    lien = new Cable('lien');
    lien.connect(rtr.getPort(g0)!, pc.getPort('eth0')!);

    await rtr.executeCommand('enable');
    await rtr.executeCommand('configure terminal');
    await rtr.executeCommand(`interface ${g0}`);
    await rtr.executeCommand('ip address 192.168.10.254 255.255.255.0');
    await rtr.executeCommand('no shutdown');
    await rtr.executeCommand('end');

    pc.configureInterface('eth0', new IPAddress('192.168.10.101'), new SubnetMask('255.255.255.0'));

    lignes = [];
    rtr.getDebugService().subscribe((l: string) => lignes.push(l));
  });

  const run = (cmd: string): Promise<string> => rtr.executeCommand(cmd);

  describe('activation du debug', () => {
    it('`debug ip routing` s\'active sans nécessiter de filtre ACL', async () => {
      expect(await run('debug ip routing')).toContain('IP routing debugging is on');
    });

    it('il est listé par `show debugging`', async () => {
      await run('debug ip routing');
      expect(await run('show debugging')).toContain('IP routing debugging is on');
    });
  });

  describe('ajout d\'une route statique', () => {
    it('gap confirmé : l\'ajout d\'une route devrait produire une ligne `RT: add`', async () => {
      await run('debug ip routing');
      await run('configure terminal');
      await run('ip route 192.168.30.0 255.255.255.0 192.168.10.101');
      await run('end');

      expect(lignes.some((l) => /RT: add 192\.168\.30\.0/.test(l))).toBe(true);
    });

    it('la route est bien présente dans la table après ajout', async () => {
      await run('configure terminal');
      await run('ip route 192.168.30.0 255.255.255.0 192.168.10.101');
      await run('end');

      const routes = await run('show ip route');
      expect(routes).toContain('192.168.30.0');
    });
  });

  describe('suppression d\'une route statique', () => {
    it('gap confirmé : la suppression devrait produire une ligne `RT: del`', async () => {
      await run('configure terminal');
      await run('ip route 192.168.30.0 255.255.255.0 192.168.10.101');
      await run('end');

      await run('debug ip routing');
      await run('configure terminal');
      await run('no ip route 192.168.30.0 255.255.255.0 192.168.10.101');
      await run('end');

      expect(lignes.some((l) => /RT: del 192\.168\.30\.0/.test(l))).toBe(true);
    });

    it('la route disparaît effectivement de la table', async () => {
      await run('configure terminal');
      await run('ip route 192.168.30.0 255.255.255.0 192.168.10.101');
      await run('end');
      expect(await run('show ip route')).toContain('192.168.30.0');

      await run('configure terminal');
      await run('no ip route 192.168.30.0 255.255.255.0 192.168.10.101');
      await run('end');
      expect(await run('show ip route')).not.toContain('192.168.30.0');
    });
  });

  describe('perte du lien — disparition de la route connectée', () => {
    it('la route connectée disparaît de la table quand le lien tombe', async () => {
      expect(await run('show ip route')).toContain('192.168.10.0');

      lien.disconnect();

      expect(await run('show ip route')).not.toContain('192.168.10.0/24');
    });

    it('gap confirmé : la chute du lien devrait produire une ligne `RT: del` de la route connectée', async () => {
      await run('debug ip routing');
      lien.disconnect();

      expect(lignes.some((l) => /RT: del.*192\.168\.10\.0/.test(l))).toBe(true);
    });
  });

  describe('route flottante — basculement par distance administrative', () => {
    it('gap confirmé : une route par défaut statique devrait s\'installer, puis basculer sur la flottante', async () => {
      await run('configure terminal');
      await run('ip route 0.0.0.0 0.0.0.0 192.168.10.101');
      await run('ip route 0.0.0.0 0.0.0.0 192.168.10.102 10');
      await run('end');

      const avant = await run('show ip route');
      expect(avant).toMatch(/0\.0\.0\.0|default/i);

      await run('configure terminal');
      await run('no ip route 0.0.0.0 0.0.0.0 192.168.10.101');
      await run('end');

      const apres = await run('show ip route');
      expect(apres).toMatch(/0\.0\.0\.0|default/i);
    });

    it('gap confirmé : le basculement devrait produire un `RT: del` suivi d\'un `RT: add`', async () => {
      await run('configure terminal');
      await run('ip route 0.0.0.0 0.0.0.0 192.168.10.101');
      await run('ip route 0.0.0.0 0.0.0.0 192.168.10.102 10');
      await run('end');

      await run('debug ip routing');
      await run('configure terminal');
      await run('no ip route 0.0.0.0 0.0.0.0 192.168.10.101');
      await run('end');

      const del = lignes.findIndex((l) => l.includes('RT: del'));
      const add = lignes.findIndex((l) => l.includes('RT: add'));
      expect(del).toBeGreaterThanOrEqual(0);
      expect(add).toBeGreaterThan(del);
    });
  });

  describe('corrélation avec les timers OSPF (contexte du scénario)', () => {
    it('`show ip ospf interface` expose les timers hello/dead permettant d\'expliquer un flapping', async () => {
      await run('configure terminal');
      await run('router ospf 1');
      await run('network 192.168.10.0 0.0.0.255 area 0');
      await run('exit');
      await run('end');

      const out = await run(`show ip ospf interface ${g0}`);
      expect(out).toMatch(/Hello 10|Hello.*10/);
      expect(out).toMatch(/Dead 40|Dead.*40/);
    });
  });
});
