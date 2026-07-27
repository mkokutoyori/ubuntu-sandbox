/**
 * Scénario 6 (debug Cisco) — `debug ip dhcp server` : diagnostiquer les
 * problèmes d'attribution d'adresses.
 *
 * Transcription littérale : `debug ip dhcp server events` (haut niveau)
 * et `debug ip dhcp server packet` (contenu DORA), séquence DORA réussie,
 * cas d'échec (pool épuisé, adresse en conflit), puis résolution
 * (réduction du bail, `clear ip dhcp conflict *`) et validation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 6 (debug) — debug ip dhcp server', () => {
  const LONG = 30_000;
  let rtr: CiscoRouter;
  let sw: CiscoSwitch;
  let client: LinuxPC;
  let lignes: string[];
  let g0: string;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    rtr = new CiscoRouter('RTR-MANDENG-01');
    sw = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    client = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    rtr.powerOn();
    sw.powerOn();
    client.powerOn();

    [g0] = rtr.getPortNames();
    new Cable('rtr-sw').connect(rtr.getPort(g0)!, sw.getPort('FastEthernet0/8')!);
    new Cable('sw-pc').connect(sw.getPort('FastEthernet0/1')!, client.getPort('eth0')!);

    await rtr.executeCommand('enable');
    await rtr.executeCommand('configure terminal');
    await rtr.executeCommand(`interface ${g0}`);
    await rtr.executeCommand('ip address 192.168.10.254 255.255.255.0');
    await rtr.executeCommand('no shutdown');
    await rtr.executeCommand('exit');
    await rtr.executeCommand('ip dhcp pool LAN-MANDENG');
    await rtr.executeCommand('network 192.168.10.0 255.255.255.0');
    await rtr.executeCommand('default-router 192.168.10.254');
    await rtr.executeCommand('dns-server 192.168.10.10');
    await rtr.executeCommand('lease 1 0 0');
    await rtr.executeCommand('exit');
    await rtr.executeCommand('end');

    lignes = [];
    rtr.getDebugService().subscribe((l: string) => lignes.push(l));
  });

  const run = (cmd: string): Promise<string> => rtr.executeCommand(cmd);

  describe('activation des debugs DHCP', () => {
    it('`debug ip dhcp server events` s\'active', async () => {
      expect(await run('debug ip dhcp server events')).toMatch(/DHCP server event debugging is on/i);
    });

    it('`debug ip dhcp server packet` s\'active', async () => {
      expect(await run('debug ip dhcp server packet')).toMatch(/DHCP server packet debugging is on/i);
    });

    it('gap confirmé : les debugs DHCP devraient apparaître dans `show debugging`', async () => {
      await run('debug ip dhcp server events');
      const out = await run('show debugging');
      expect(out).toMatch(/DHCP/i);
    });
  });

  describe('séquence DORA réussie', () => {
    it('le client obtient une adresse du pool', async () => {
      await client.executeCommand('sudo dhclient eth0');

      const bindings = await run('show ip dhcp binding');
      expect(bindings).toMatch(/192\.168\.10\.\d+/);
    }, LONG);

    it('gap confirmé : `debug ip dhcp server events` devrait tracer DISCOVER/OFFER/REQUEST/ACK', async () => {
      await run('debug ip dhcp server events');
      await client.executeCommand('sudo dhclient eth0');

      expect(lignes.some((l) => /DHCPDISCOVER/i.test(l))).toBe(true);
      expect(lignes.some((l) => /DHCPOFFER/i.test(l))).toBe(true);
      expect(lignes.some((l) => /DHCPREQUEST/i.test(l))).toBe(true);
      expect(lignes.some((l) => /DHCPACK/i.test(l))).toBe(true);
    }, LONG);

    it('gap confirmé : `debug ip dhcp server packet` devrait exposer chaddr et yiaddr', async () => {
      await run('debug ip dhcp server packet');
      await client.executeCommand('sudo dhclient eth0');

      expect(lignes.some((l) => /chaddr/i.test(l))).toBe(true);
      expect(lignes.some((l) => /yiaddr/i.test(l))).toBe(true);
    }, LONG);
  });

  describe('état du pool et des baux', () => {
    it('gap confirmé : `show ip dhcp pool` devrait exposer Total addresses / Leased addresses', async () => {
      const out = await run('show ip dhcp pool');
      expect(out).toMatch(/LAN-MANDENG/);
      expect(out).toMatch(/[Tt]otal addresses|Leased/);
    });

    it('`show ip dhcp binding` liste les baux actifs après attribution', async () => {
      await client.executeCommand('sudo dhclient eth0');
      const out = await run('show ip dhcp binding');
      expect(out).toMatch(/192\.168\.10\./);
    }, LONG);

    it('la durée du bail est configurable (résolution du pool épuisé)', async () => {
      await run('configure terminal');
      await run('ip dhcp pool LAN-MANDENG');
      const out = await run('lease 0 12 0');
      await run('end');
      expect(out).not.toContain('Invalid input');
    });
  });

  describe('conflits d\'adresses', () => {
    it('`show ip dhcp conflict` est disponible et vide par défaut', async () => {
      const out = await run('show ip dhcp conflict');
      expect(out).not.toContain('Invalid input');
      expect(out).not.toMatch(/192\.168\.10\.\d+\s+Ping/);
    });

    it('`clear ip dhcp conflict *` est accepté', async () => {
      const out = await run('clear ip dhcp conflict *');
      expect(out).not.toContain('Invalid input');
    });

    it('gap confirmé : une adresse déjà utilisée devrait être détectée et marquée en conflit', async () => {
      // Un poste porte statiquement une adresse du pool : un vrai serveur
      // DHCP Cisco la ping avant attribution et la marque « in conflict ».
      const squatteur = new LinuxPC('linux-pc', 'squatteur', 0, 0);
      squatteur.powerOn();
      new Cable('sw-squat').connect(sw.getPort('FastEthernet0/2')!, squatteur.getPort('eth0')!);
      await squatteur.executeCommand('sudo ip addr add 192.168.10.1/24 dev eth0');

      await client.executeCommand('sudo dhclient eth0');

      const conflits = await run('show ip dhcp conflict');
      expect(conflits).toMatch(/192\.168\.10\.1\b/);
    }, LONG);
  });

  describe('désactivation', () => {
    it('`no debug ip dhcp server events` est accepté', async () => {
      await run('debug ip dhcp server events');
      const out = await run('no debug ip dhcp server events');
      expect(out).not.toContain('Invalid input');
    });
  });
});
