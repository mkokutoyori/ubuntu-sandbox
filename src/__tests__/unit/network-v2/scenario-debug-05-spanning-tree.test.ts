/**
 * Scénario 5 (debug Cisco) — `debug spanning-tree` : diagnostiquer les
 * problèmes STP.
 *
 * Transcription littérale : `debug spanning-tree events` pour les
 * transitions d'état et les Topology Change, `debug spanning-tree bpdu`
 * pour exposer le Bridge ID d'un équipement non autorisé qui clame le
 * root bridge, puis protection par PortFast + BPDU Guard et validation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 5 (debug) — debug spanning-tree', () => {
  const LONG = 30_000;
  let sw: CiscoSwitch;
  let intrus: CiscoSwitch;
  let pc: LinuxPC;
  let lignes: string[];

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    sw = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    intrus = new CiscoSwitch('switch-cisco', 'SW-INTRUS', 8);
    pc = new LinuxPC('linux-pc', 'pc-win-2', 0, 0);
    sw.powerOn();
    intrus.powerOn();
    pc.powerOn();

    new Cable('lien-pc').connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);

    await sw.executeCommand('enable');
    lignes = [];
    sw.getDebugService().subscribe((l: string) => lignes.push(l));
  });

  const run = (cmd: string): Promise<string> => sw.executeCommand(cmd);

  describe('activation des debugs STP', () => {
    it('`debug spanning-tree events` s\'active', async () => {
      expect(await run('debug spanning-tree events')).toMatch(/debugging is on/i);
    });

    it('`debug spanning-tree bpdu` s\'active', async () => {
      const out = await run('debug spanning-tree bpdu');
      expect(out).not.toContain('Invalid input');
      expect(out).toMatch(/debugging is on/i);
    });

    it('les debugs STP apparaissent dans `show debugging`', async () => {
      await run('debug spanning-tree events');
      expect(await run('show debugging')).toMatch(/[Ss]panning/);
    });
  });

  describe('transitions d\'état des ports', () => {
    it('gap confirmé : le raccordement d\'un switch devrait tracer les transitions d\'état', async () => {
      await run('debug spanning-tree events');
      new Cable('lien-intrus').connect(sw.getPort('FastEthernet0/3')!, intrus.getPort('FastEthernet0/1')!);

      expect(lignes.some((l) => /listening|learning|forwarding/i.test(l))).toBe(true);
    }, LONG);

    it('l\'état de forwarding des ports est consultable via `show spanning-tree`', async () => {
      const out = await run('show spanning-tree');
      expect(out).toMatch(/Fa0\/1/);
    });
  });

  describe('réception de BPDU et élection du root bridge', () => {
    it('le raccordement d\'un second switch fait apparaître son port dans la topologie STP', async () => {
      new Cable('lien-intrus').connect(sw.getPort('FastEthernet0/3')!, intrus.getPort('FastEthernet0/1')!);
      const out = await run('show spanning-tree');
      expect(out).toMatch(/Fa0\/3/);
    }, LONG);

    it('gap confirmé : `debug spanning-tree bpdu` devrait exposer le Bridge ID reçu', async () => {
      await run('debug spanning-tree bpdu');
      new Cable('lien-intrus').connect(sw.getPort('FastEthernet0/3')!, intrus.getPort('FastEthernet0/1')!);

      expect(lignes.some((l) => /bridge id|root bridge id/i.test(l))).toBe(true);
    }, LONG);

    it('un switch prioritaire devient root bridge et c\'est visible dans `show spanning-tree`', async () => {
      await run('configure terminal');
      await run('spanning-tree vlan 1 priority 4096');
      await run('end');

      const out = await run('show spanning-tree');
      expect(out).toMatch(/4097|4096/);
    });
  });

  describe('protection PortFast et BPDU Guard', () => {
    it('`spanning-tree portfast` est accepté sur un port d\'accès', async () => {
      await run('configure terminal');
      await run('interface FastEthernet0/1');
      const out = await run('spanning-tree portfast');
      await run('end');
      expect(out).not.toContain('Invalid input');
    });

    it('`spanning-tree bpduguard enable` est accepté', async () => {
      await run('configure terminal');
      await run('interface FastEthernet0/1');
      const out = await run('spanning-tree bpduguard enable');
      await run('end');
      expect(out).not.toContain('Invalid input');
    });

    it('gap confirmé : BPDU Guard devrait err-disable le port à réception d\'un BPDU', async () => {
      await run('configure terminal');
      await run('interface FastEthernet0/3');
      await run('spanning-tree portfast');
      await run('spanning-tree bpduguard enable');
      await run('end');

      new Cable('lien-intrus').connect(sw.getPort('FastEthernet0/3')!, intrus.getPort('FastEthernet0/1')!);

      const status = await run('show interfaces status');
      expect(status).toMatch(/Fa0\/3\s+(err-disabled|disabled|notconnect)/);
    }, LONG);

    it('gap confirmé : le déclenchement de BPDU Guard devrait journaliser %SPANTREE-2-BLOCK_BPDUGUARD', async () => {
      await run('configure terminal');
      await run('interface FastEthernet0/3');
      await run('spanning-tree portfast');
      await run('spanning-tree bpduguard enable');
      await run('end');

      new Cable('lien-intrus').connect(sw.getPort('FastEthernet0/3')!, intrus.getPort('FastEthernet0/1')!);

      const logs = await run('show logging');
      expect(logs).toContain('SPANTREE-2-BLOCK_BPDUGUARD');
    }, LONG);
  });

  describe('vérification finale', () => {
    it('`show spanning-tree summary` expose l\'état global du protocole', async () => {
      const out = await run('show spanning-tree summary');
      expect(out).toMatch(/Root bridge for|mode/i);
    });

    it('`undebug all` est accepté après investigation', async () => {
      await run('debug spanning-tree events');
      expect(await run('undebug all')).toContain('All possible debugging has been turned off');
    });
  });
});
