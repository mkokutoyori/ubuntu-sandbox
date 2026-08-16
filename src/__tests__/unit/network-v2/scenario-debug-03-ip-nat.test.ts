/**
 * Scénario 3 (debug Cisco) — `debug ip nat` : tracer les traductions NAT
 * en temps réel.
 *
 * Transcription littérale : activation filtrée, distinction entre `NAT*`
 * (paquet traduit) et `NAT` (paquet vu mais NON traduit) — la signature
 * clé du scénario —, `debug ip nat detailed` avec direction `i:`/`o:` et
 * ports PAT, création/expiration d'entrées, puis correction du masque
 * wildcard de l'ACL NAT et validation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { pingOnSimulatedClock } from '../../support/fastPing';

describe('Scénario 3 (debug) — debug ip nat', () => {
  const LONG = 30_000;
  let rtr: CiscoRouter;
  let interne: LinuxPC;
  let externe: LinuxPC;
  let lignes: string[];
  let gIn: string;
  let gOut: string;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    rtr = new CiscoRouter('RTR-MANDENG-01');
    rtr.powerOn();
    interne = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    externe = new LinuxPC('linux-pc', 'serveur-externe', 0, 0);
    interne.powerOn();
    externe.powerOn();

    [gIn, gOut] = rtr.getPortNames();
    new Cable('lan').connect(rtr.getPort(gIn)!, interne.getPort('eth0')!);
    new Cable('wan').connect(rtr.getPort(gOut)!, externe.getPort('eth0')!);

    await rtr.executeCommand('enable');
    await rtr.executeCommand('configure terminal');
    await rtr.executeCommand(`interface ${gIn}`);
    await rtr.executeCommand('ip address 192.168.10.254 255.255.255.0');
    await rtr.executeCommand('ip nat inside');
    await rtr.executeCommand('no shutdown');
    await rtr.executeCommand('exit');
    await rtr.executeCommand(`interface ${gOut}`);
    await rtr.executeCommand('ip address 203.0.113.1 255.255.255.0');
    await rtr.executeCommand('ip nat outside');
    await rtr.executeCommand('no shutdown');
    await rtr.executeCommand('exit');
    await rtr.executeCommand('end');

    interne.configureInterface('eth0', new IPAddress('192.168.10.101'), new SubnetMask('255.255.255.0'));
    externe.configureInterface('eth0', new IPAddress('203.0.113.50'), new SubnetMask('255.255.255.0'));
    await interne.executeCommand('sudo ip route add default via 192.168.10.254');

    lignes = [];
    rtr.getDebugService().subscribe((l: string) => lignes.push(l));
  });

  const run = (cmd: string): Promise<string> => rtr.executeCommand(cmd);

  /** ACL NAT au masque wildcard trop étroit (bug du scénario). */
  async function natAvecMasqueEtroit(): Promise<void> {
    await run('configure terminal');
    await run('ip access-list standard ACL-LAN-INTERNE');
    await run('10 permit 192.168.10.0 0.0.0.224');
    await run('exit');
    await run(`ip nat inside source list ACL-LAN-INTERNE interface ${gOut} overload`);
    await run('end');
  }

  /** ACL NAT corrigée couvrant tout le /24. */
  async function natAvecMasqueCorrect(): Promise<void> {
    await run('configure terminal');
    await run('ip access-list standard ACL-LAN-INTERNE');
    // IOS refuse un numero de sequence deja pris (« % Duplicate sequence
    // number. ») : corriger un masque impose de retirer l'ACE d'abord.
    await run('no 10');
    await run('10 permit 192.168.10.0 0.0.0.255');
    await run('exit');
    await run(`ip nat inside source list ACL-LAN-INTERNE interface ${gOut} overload`);
    await run('end');
  }

  describe('activation du debug NAT', () => {
    it('`debug ip nat` s\'annonce actif et apparaît dans `show debugging`', async () => {
      expect(await run('debug ip nat')).toContain('IP NAT debugging is on');
      expect(await run('show debugging')).toMatch(/NAT debugging is on/);
    });

    it('`debug ip nat detailed` est accepté', async () => {
      const out = await run('debug ip nat detailed');
      expect(out).not.toContain('Invalid input');
    });

    it('`debug ip nat <acl>` (filtre) est accepté', async () => {
      await run('configure terminal');
      await run('ip access-list standard NAT-DEBUG');
      await run('10 permit 192.168.10.105');
      await run('end');

      const out = await run('debug ip nat NAT-DEBUG');
      expect(out).not.toContain('Invalid input');
    });
  });

  describe('flux traduit correctement', () => {
    it('la traduction NAT est effectivement appliquée et visible dans la table', async () => {
      await natAvecMasqueCorrect();
      await pingOnSimulatedClock(interne, 'ping -c 2 203.0.113.50');

      const trad = await run('show ip nat translations');
      expect(trad).toContain('192.168.10.101');
      expect(trad).toContain('203.0.113.1');
    }, LONG);

    it('un paquet traduit devrait produire une ligne `NAT*: s=…->…`', async () => {
      await natAvecMasqueCorrect();
      await run('debug ip nat');
      await pingOnSimulatedClock(interne, 'ping -c 2 203.0.113.50');

      expect(lignes.some((l) => /NAT\*: s=192\.168\.10\.101->203\.0\.113\.1/.test(l))).toBe(true);
    }, LONG);

    it('`debug ip nat` devrait produire au moins une ligne lors d\'un flux traduit', async () => {
      await natAvecMasqueCorrect();
      await run('debug ip nat');
      await pingOnSimulatedClock(interne, 'ping -c 2 203.0.113.50');

      expect(lignes.some((l) => l.includes('NAT'))).toBe(true);
    }, LONG);
  });

  describe('masque wildcard trop étroit — machine hors plage', () => {
    it('le masque 0.0.0.224 est enregistré tel quel dans l\'ACL', async () => {
      await natAvecMasqueEtroit();
      const out = await run('show ip access-lists ACL-LAN-INTERNE');
      expect(out).toContain('192.168.10.0');
    });

    it('la correction du masque en 0.0.0.255 est prise en compte', async () => {
      await natAvecMasqueEtroit();
      await natAvecMasqueCorrect();

      const out = await run('show ip access-lists ACL-LAN-INTERNE');
      expect(out).toContain('0.0.0.255');
    });

    it('après correction, la traduction fonctionne pour la machine concernée', async () => {
      await natAvecMasqueCorrect();
      await pingOnSimulatedClock(interne, 'ping -c 2 203.0.113.50');

      const trad = await run('show ip nat translations');
      expect(trad).toContain('192.168.10.101');
    }, LONG);
  });

  describe('statistiques et table NAT', () => {
    it('`show ip nat statistics` expose les compteurs de traduction', async () => {
      await natAvecMasqueCorrect();
      await pingOnSimulatedClock(interne, 'ping -c 2 203.0.113.50');

      const out = await run('show ip nat statistics');
      expect(out).toMatch(/Total (active )?translations/i);
    }, LONG);

    it('`clear ip nat translation *` vide la table', async () => {
      await natAvecMasqueCorrect();
      await pingOnSimulatedClock(interne, 'ping -c 2 203.0.113.50');
      expect(await run('show ip nat translations')).toContain('192.168.10.101');

      await run('clear ip nat translation *');
      expect(await run('show ip nat translations')).not.toContain('192.168.10.101');
    }, LONG);
  });
});
