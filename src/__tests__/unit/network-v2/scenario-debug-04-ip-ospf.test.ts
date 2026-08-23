/**
 * Scénario 4 (debug Cisco) — `debug ip ospf` : diagnostiquer les
 * problèmes d'adjacence et de LSA.
 *
 * Transcription littérale : activation progressive (`events`, puis `adj`,
 * puis `lsa-generation`), diagnostic d'un mismatch de hello interval
 * entre un Cisco (10 s) et un Huawei (30 s), progression des états
 * d'adjacence jusqu'à FULL, puis correction des timers et validation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 4 (debug) — debug ip ospf', () => {
  const LONG = 30_000;
  let r1: CiscoRouter;
  let r2: CiscoRouter;
  let lignes: string[];
  let g1: string;
  let g2: string;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    r1 = new CiscoRouter('RTR-MANDENG-01');
    r2 = new CiscoRouter('RTR-KRIBI-01');
    r1.powerOn();
    r2.powerOn();

    [g1] = r1.getPortNames();
    [g2] = r2.getPortNames();
    new Cable('wan').connect(r1.getPort(g1)!, r2.getPort(g2)!);

    await configurer(r1, g1, '10.0.0.1', '1.1.1.1');
    await configurer(r2, g2, '10.0.0.2', '2.2.2.2');

    lignes = [];
    r1.getDebugService().subscribe((l: string) => lignes.push(l));
  });

  async function configurer(r: CiscoRouter, iface: string, ip: string, rid: string): Promise<void> {
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand(`interface ${iface}`);
    await r.executeCommand(`ip address ${ip} 255.255.255.0`);
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    await r.executeCommand('router ospf 1');
    await r.executeCommand(`router-id ${rid}`);
    await r.executeCommand('network 10.0.0.0 0.0.0.255 area 0');
    await r.executeCommand('exit');
    await r.executeCommand('end');
  }

  const run = (cmd: string): Promise<string> => r1.executeCommand(cmd);

  describe('activation progressive des debugs OSPF', () => {
    it('`debug ip ospf events` s\'active une fois OSPF configuré', async () => {
      const out = await run('debug ip ospf events');
      expect(out).not.toContain('OSPF is not enabled');
      expect(out).toMatch(/debugging is on/i);
    });

    it('`debug ip ospf adj` s\'active', async () => {
      expect(await run('debug ip ospf adj')).toMatch(/debugging is on/i);
    });

    it('`debug ip ospf lsa-generation` s\'active', async () => {
      const out = await run('debug ip ospf lsa-generation');
      expect(out).not.toContain('Invalid input');
    });

    it("sur un routeur sans OSPF, le drapeau s'arme quand meme", async () => {
      const vierge = new CiscoRouter('RTR-VIERGE');
      vierge.powerOn();
      await vierge.executeCommand('enable');
      expect(await vierge.executeCommand('debug ip ospf events'))
        .toBe('OSPF events debugging is on');
      expect(await vierge.executeCommand('show debugging'))
        .toContain('OSPF events debugging is on');
    });
  });

  describe('adjacence nominale entre deux routeurs aux timers identiques', () => {
    it('l\'adjacence atteint l\'état FULL', async () => {
      const out = await run('show ip ospf neighbor');
      expect(out).toContain('2.2.2.2');
      expect(out).toMatch(/FULL/);
    }, LONG);

    it('`show ip ospf interface` expose les timers hello 10 / dead 40 par défaut', async () => {
      const out = await run(`show ip ospf interface ${g1}`);
      expect(out).toMatch(/Hello 10/);
      expect(out).toMatch(/Dead 40/);
    });
  });

  describe('mismatch de hello interval (Cisco 10 s vs Huawei 30 s)', () => {
    it('le hello interval est modifiable par interface', async () => {
      await run('configure terminal');
      await run(`interface ${g1}`);
      await run('ip ospf hello-interval 30');
      await run('ip ospf dead-interval 120');
      await run('end');

      const out = await run(`show ip ospf interface ${g1}`);
      expect(out).toMatch(/Hello 30/);
      expect(out).toMatch(/Dead 120/);
    });

    it('un hello interval divergent devrait empêcher l\'adjacence', async () => {
      // R1 passe à 30 s alors que R2 reste à 10 s : un vrai IOS refuse
      // l'adjacence et la sort de l'état FULL.
      await run('configure terminal');
      await run(`interface ${g1}`);
      await run('ip ospf hello-interval 30');
      await run('ip ospf dead-interval 120');
      await run('end');

      const out = await run('show ip ospf neighbor');
      expect(out).not.toMatch(/FULL/);
    }, LONG);

    it('`debug ip ospf hello` signale le mismatch dans les mots d IOS', async () => {
      await run('debug ip ospf hello');
      await run('configure terminal');
      await run(`interface ${g1}`);
      await run('ip ospf hello-interval 30');
      await run('end');
      await run('show ip ospf neighbor');

      expect(lignes.some((l) => /Mismatched hello parameters from/.test(l))).toBe(true);
      expect(lignes.some((l) => /Hello R 10 C 30/.test(l))).toBe(true);
    }, LONG);
  });

  describe('progression des états d\'adjacence', () => {
    it('`debug ip ospf adj` devrait tracer la montée jusqu\'à FULL', async () => {
      await run('debug ip ospf adj');

      // Faire retomber puis remonter l'adjacence.
      await run('configure terminal');
      await run(`interface ${g1}`);
      await run('shutdown');
      await run('no shutdown');
      await run('end');

      expect(lignes.some((l) => /FULL|2WAY|Exchange|Loading/i.test(l))).toBe(true);
    }, LONG);
  });

  describe('génération de LSA', () => {
    it('`show ip ospf database` expose les LSA de la base', async () => {
      const out = await run('show ip ospf database');
      expect(out).toMatch(/Router Link States|Link ID/i);
    }, LONG);

    it('`debug ip ospf lsa-generation` devrait produire des lignes de génération', async () => {
      await run('debug ip ospf lsa-generation');
      await run('configure terminal');
      await run(`interface ${g1}`);
      await run('shutdown');
      await run('no shutdown');
      await run('end');

      expect(lignes.some((l) => /LSA/i.test(l))).toBe(true);
    }, LONG);
  });

  describe('correction et validation', () => {
    it('le retour à des timers identiques rétablit l\'adjacence FULL', async () => {
      await run('configure terminal');
      await run(`interface ${g1}`);
      await run('ip ospf hello-interval 30');
      await run('end');

      await run('configure terminal');
      await run(`interface ${g1}`);
      await run('ip ospf hello-interval 10');
      await run('ip ospf dead-interval 40');
      await run('end');

      const out = await run('show ip ospf neighbor');
      expect(out).toContain('2.2.2.2');
      expect(out).toMatch(/FULL/);
    }, LONG);
  });
});
