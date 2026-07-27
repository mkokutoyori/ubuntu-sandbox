/**
 * Scénario 1 (debug Cisco) — `debug ip packet` : analyser le chemin des
 * paquets IP en temps réel.
 *
 * Transcription littérale : précautions avant activation (ACL de debug,
 * contrôle du CPU), trace nominale d'un paquet routé, puis les cas de
 * rejet (`access denied`, `unroutable`, `TTL exceeded`), et enfin
 * `undebug all` obligatoire.
 *
 * Les lignes de debug sont collectées via `RouterDebugService.subscribe()`
 * — le canal réel par lequel le simulateur émet la sortie de debug.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 1 (debug) — debug ip packet', () => {
  const LONG = 30_000;
  let rtr: CiscoRouter;
  let pc: LinuxPC;
  let lignes: string[];

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    rtr = new CiscoRouter('RTR-MANDENG-01');
    rtr.powerOn();
    pc = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    pc.powerOn();

    const [g0] = rtr.getPortNames();
    new Cable('lien').connect(rtr.getPort(g0)!, pc.getPort('eth0')!);

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

  describe('précautions avant activation', () => {
    it('`show processes cpu sorted` expose la charge avant d\'activer un debug', async () => {
      const out = await run('show processes cpu sorted');
      expect(out).toMatch(/CPU utilization for five seconds: \d+%\/\d+%; one minute: \d+%; five minutes: \d+%/);
    });

    it('une ACL de debug restrictive peut être créée avant activation', async () => {
      await run('configure terminal');
      await run('ip access-list extended DEBUG-FILTER');
      await run('10 permit ip host 192.168.10.101 host 192.168.10.20');
      await run('20 permit ip host 192.168.10.20 host 192.168.10.101');
      await run('end');

      const out = await run('show ip access-lists DEBUG-FILTER');
      expect(out).toContain('DEBUG-FILTER');
      expect(out).toContain('192.168.10.101');
    });

    it('`debug ip packet` s\'active et est listé par `show debugging`', async () => {
      expect(await run('debug ip packet')).toContain('IP packet debugging is on');
      expect(await run('show debugging')).toContain('IP packet debugging is on');
    });

    it('`debug ip packet detail` annonce le mode détaillé', async () => {
      expect(await run('debug ip packet detail')).toMatch(/detail/i);
    });

    it('gap confirmé : `debug ip packet <ACL>` (filtre par ACL) n\'est pas accepté', async () => {
      await run('configure terminal');
      await run('ip access-list extended DEBUG-FILTER');
      await run('10 permit ip host 192.168.10.101 host 192.168.10.20');
      await run('end');

      const out = await run('debug ip packet DEBUG-FILTER detail');
      expect(out).not.toContain('Invalid input');
      expect(out).toMatch(/access list DEBUG-FILTER/i);
    });
  });

  describe('sortie nominale — paquets transmis', () => {
    it('un ping produit des lignes `IP: s=… d=…` dans la sortie de debug', async () => {
      await run('debug ip packet');
      await pc.executeCommand('ping -c 2 192.168.10.254');

      expect(lignes.length).toBeGreaterThan(0);
      expect(lignes.some((l) => l.includes('s=192.168.10.101') && l.includes('d=192.168.10.254')))
        .toBe(true);
    }, LONG);

    it('la réception et l\'émission sont distinguées (`rcvd` / `sent`)', async () => {
      await run('debug ip packet');
      await pc.executeCommand('ping -c 2 192.168.10.254');

      expect(lignes.some((l) => l.includes('rcvd'))).toBe(true);
      expect(lignes.some((l) => l.includes('sent'))).toBe(true);
    }, LONG);

    it('aucune ligne n\'est produite tant que le debug n\'est pas activé', async () => {
      await pc.executeCommand('ping -c 2 192.168.10.254');
      expect(lignes).toHaveLength(0);
    }, LONG);

    it('gap confirmé : la ligne devrait porter la taille réelle (`len 84`) et l\'interface', async () => {
      await run('debug ip packet');
      await pc.executeCommand('ping -c 1 192.168.10.254');

      const ligne = lignes.find((l) => l.includes('s=192.168.10.101')) ?? '';
      expect(ligne).toMatch(/len \d+/);
      expect(ligne).toMatch(/\(GigabitEthernet|\(Gi/);
    }, LONG);

    it('gap confirmé : un paquet routé devrait porter le verdict `forward` et le next hop `g=`', async () => {
      await run('debug ip packet');
      await pc.executeCommand('ping -c 1 192.168.10.254');

      expect(lignes.some((l) => l.includes('forward'))).toBe(true);
      expect(lignes.some((l) => /g=\d+\.\d+\.\d+\.\d+/.test(l))).toBe(true);
    }, LONG);
  });

  describe('paquet rejeté par une ACL', () => {
    it('gap confirmé : un paquet refusé par une ACL devrait produire `access denied`', async () => {
      await run('configure terminal');
      await run('ip access-list extended BLOQUE');
      await run('10 deny ip host 192.168.10.101 any');
      await run('20 permit ip any any');
      await run('exit');
      const [g0] = rtr.getPortNames();
      await run(`interface ${g0}`);
      await run('ip access-group BLOQUE in');
      await run('end');

      await run('debug ip packet');
      await pc.executeCommand('ping -c 2 192.168.10.254');

      expect(lignes.some((l) => l.includes('access denied'))).toBe(true);
    }, LONG);
  });

  describe('paquet non routable', () => {
    it('gap confirmé : une destination sans route devrait produire `unroutable`', async () => {
      await run('debug ip packet');
      await pc.executeCommand('ping -c 2 10.50.0.1');

      expect(lignes.some((l) => l.includes('unroutable'))).toBe(true);
    }, LONG);
  });

  describe('désactivation du debug', () => {
    it('gap confirmé : `undebug all` annonce la coupure mais ne vide pas `show debugging`', async () => {
      await run('debug ip packet');
      await run('debug arp');
      expect(await run('show debugging')).toContain('IP packet debugging is on');

      expect(await run('undebug all')).toContain('All possible debugging has been turned off');
      expect(await run('show debugging')).not.toContain('IP packet debugging is on');
    });

    it('gap confirmé : après `undebug all`, des lignes continuent d\'être émises', async () => {
      await run('debug ip packet');
      await pc.executeCommand('ping -c 1 192.168.10.254');
      const avant = lignes.length;
      expect(avant).toBeGreaterThan(0);

      await run('undebug all');
      await pc.executeCommand('ping -c 1 192.168.10.254');
      expect(lignes.length).toBe(avant);
    }, LONG);
  });
});
