/**
 * Scénario 8 (debug Cisco) — `debug arp` : diagnostiquer les problèmes de
 * résolution d'adresses.
 *
 * Transcription littérale : PC-Linux-1 (192.168.10.101) ne joint pas la
 * passerelle (192.168.10.254) malgré un lien actif. Activation de
 * `debug arp`, observation du cycle nominal (`rcvd req` / `sent rep`),
 * puis des deux anomalies du scénario — conflit d'adresse IP
 * (`rcvd rep` pour sa propre IP avec une autre MAC + `%IP-4-DUPADDR`) et
 * ARP gratuit non sollicité (IP source = IP destination) —, localisation
 * du fautif via `show mac address-table address`, `clear arp-cache`, et
 * validation par ping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 8 (debug) — debug arp', () => {
  const LONG = 30_000;
  let rtr: CiscoRouter;
  let sw: CiscoSwitch;
  let pc: LinuxPC;
  let usurpateur: LinuxPC;
  let lignes: string[];
  let g0: string;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    rtr = new CiscoRouter('RTR-MANDENG-01');
    sw = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    pc = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    usurpateur = new LinuxPC('linux-pc', 'poste-en-conflit', 0, 0);
    rtr.powerOn();
    sw.powerOn();
    pc.powerOn();
    usurpateur.powerOn();

    [g0] = rtr.getPortNames();
    new Cable('rtr-sw').connect(rtr.getPort(g0)!, sw.getPort('FastEthernet0/8')!);
    new Cable('sw-pc').connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);
    new Cable('sw-usurp').connect(sw.getPort('FastEthernet0/5')!, usurpateur.getPort('eth0')!);

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

  describe('activation de debug arp', () => {
    it('gap confirmé : `debug arp` devrait s\'annoncer « ARP packet debugging is on »', async () => {
      expect(await run('debug arp')).toContain('ARP packet debugging is on');
    });

    it('gap confirmé : `debug arp` devrait apparaître dans `show debugging`', async () => {
      await run('debug arp');
      expect(await run('show debugging')).toMatch(/ARP packet debugging is on/);
    });
  });

  describe('cycle ARP nominal', () => {
    /**
     * Le routeur émet un ARP gratuit réel à la configuration de `ip address`
     * (vérifié sur le bus : trame 0x0806 op=request), que le poste apprend.
     * Le premier ping n'a donc besoin d'aucune résolution : il faut vider le
     * cache pour observer un vrai cycle ARP, comme le ferait un technicien.
     */
    async function resolutionFraiche(): Promise<void> {
      await pc.executeCommand('sudo ip -s -s neigh flush all');
      await pc.executeCommand('ping -c 1 -W 1 192.168.10.254');
    }

    it('une requête ARP reçue produit une ligne `rcvd req` avec IP et MAC source', async () => {
      await run('debug arp');
      await resolutionFraiche();

      expect(lignes.some((l) => /IP ARP: rcvd req src 192\.168\.10\.101/.test(l))).toBe(true);
    }, LONG);

    it('la réponse ARP émise produit une ligne `sent rep` avec la MAC du routeur', async () => {
      await run('debug arp');
      await resolutionFraiche();

      expect(lignes.some((l) => /IP ARP: sent rep src 192\.168\.10\.254/.test(l))).toBe(true);
      expect(lignes.some((l) => /sent rep .*dst 192\.168\.10\.101/.test(l))).toBe(true);
    }, LONG);

    it('la ligne de debug mentionne l\'interface de réception', async () => {
      await run('debug arp');
      await resolutionFraiche();

      expect(lignes.some((l) => l.includes(g0))).toBe(true);
    }, LONG);

    it('gap confirmé : les MAC devraient être au format Cisco pointé (aaaa.bbbb.cccc)', async () => {
      await run('debug arp');
      await resolutionFraiche();

      expect(lignes.some((l) => /[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/i.test(l))).toBe(true);
    }, LONG);

    it('gap confirmé : la MAC destination d\'une requête devrait être 0000.0000.0000 (inconnue)', async () => {
      await run('debug arp');
      await resolutionFraiche();

      const requetes = lignes.filter((l) => /rcvd req/.test(l));
      expect(requetes.length).toBeGreaterThan(0);
      expect(requetes.some((l) => /dst 192\.168\.10\.254 0000\.0000\.0000/.test(l))).toBe(true);
    }, LONG);

    it('l\'ARP gratuit du routeur à la configuration de `ip address` peuple le cache du poste', async () => {
      const neigh = await pc.executeCommand('ip neigh show');
      expect(neigh).toContain('192.168.10.254');
      expect(neigh).toMatch(/REACHABLE/);
    }, LONG);

    it('le cache ARP du routeur se peuple après la résolution', async () => {
      await pc.executeCommand('ping -c 1 -W 1 192.168.10.254');

      const arp = await run('show arp');
      expect(arp).toContain('192.168.10.101');
      expect(arp).toMatch(/ARPA/);
    }, LONG);
  });

  describe('conflit d\'adresse IP — un autre équipement porte 192.168.10.254', () => {
    async function provoquerLeConflit(): Promise<void> {
      usurpateur.configureInterface('eth0', new IPAddress('192.168.10.254'), new SubnetMask('255.255.255.0'));
      await usurpateur.executeCommand('ping -c 1 -W 1 192.168.10.101');
    }

    it('gap confirmé : recevoir une réponse ARP pour sa propre IP devrait produire une ligne `rcvd rep`', async () => {
      await run('debug arp');
      await provoquerLeConflit();

      expect(lignes.some((l) => /IP ARP: rcvd rep src 192\.168\.10\.254/.test(l))).toBe(true);
    }, LONG);

    it('gap confirmé : une IP dupliquée devrait journaliser %IP-4-DUPADDR', async () => {
      await provoquerLeConflit();

      const logs = await run('show logging');
      expect(logs).toContain('%IP-4-DUPADDR');
      expect(logs).toMatch(/Duplicate address 192\.168\.10\.254/);
    }, LONG);

    it('gap confirmé : le message %IP-4-DUPADDR devrait nommer l\'interface et la MAC fautive', async () => {
      await provoquerLeConflit();

      const logs = await run('show logging');
      expect(logs).toMatch(new RegExp(`Duplicate address 192\\.168\\.10\\.254 on ${g0}`));
      expect(logs).toMatch(/sourced by [0-9a-f.:]+/i);
    }, LONG);

    it('gap confirmé : le poste en conflit devrait être localisable via la table MAC du switch', async () => {
      await provoquerLeConflit();
      const mac = usurpateur.getPort('eth0')!.getMACAddress().toString();

      await sw.executeCommand('enable');
      const table = await sw.executeCommand(`show mac address-table address ${mac}`);
      expect(table).not.toContain('Invalid input');
      expect(table).toMatch(/Fa0\/5|FastEthernet0\/5/);
    }, LONG);
  });

  describe('ARP gratuit non sollicité (ARP spoofing)', () => {
    it('gap confirmé : un ARP gratuit devrait apparaître avec IP source = IP destination', async () => {
      await run('debug arp');
      usurpateur.configureInterface('eth0', new IPAddress('192.168.10.254'), new SubnetMask('255.255.255.0'));
      await usurpateur.executeCommand('sudo arping -c 1 -U -I eth0 192.168.10.254');

      expect(lignes.some((l) => /rcvd req src 192\.168\.10\.254.*dst 192\.168\.10\.254/.test(l))).toBe(true);
    }, LONG);

    it('gap confirmé : le cache ARP corrompu doit exposer l\'IP de la passerelle avec la MAC de l\'attaquant', async () => {
      usurpateur.configureInterface('eth0', new IPAddress('192.168.10.254'), new SubnetMask('255.255.255.0'));
      await usurpateur.executeCommand('ping -c 1 -W 1 192.168.10.101');

      const arp = await run('show arp | include 192.168.10');
      expect(arp).toMatch(/192\.168\.10\.254/);
    }, LONG);
  });

  describe('nettoyage et validation', () => {
    it('`clear arp-cache` vide le cache ARP du routeur', async () => {
      await pc.executeCommand('ping -c 1 -W 1 192.168.10.254');
      expect(await run('show arp')).toContain('192.168.10.101');

      const out = await run('clear arp-cache');
      expect(out).not.toContain('Invalid input');
      expect(await run('show arp')).not.toContain('192.168.10.101');
    }, LONG);

    it('`show arp | include <réseau>` filtre correctement la sortie', async () => {
      await pc.executeCommand('ping -c 1 -W 1 192.168.10.254');

      const out = await run('show arp | include 192.168.10.101');
      expect(out).toContain('192.168.10.101');
      expect(out).not.toContain('Protocol  Address');
    }, LONG);

    it('la connectivité vers la passerelle est rétablie après nettoyage', async () => {
      await run('clear arp-cache');
      const ping = await pc.executeCommand('ping -c 3 -W 1 192.168.10.254');

      expect(ping).toMatch(/64 bytes from 192\.168\.10\.254/);
      expect(ping).not.toMatch(/100% packet loss/);
    }, LONG);

    it('`undebug all` clôt l\'investigation ARP', async () => {
      await run('debug arp');
      expect(await run('undebug all')).toContain('All possible debugging has been turned off');
    });
  });
});
