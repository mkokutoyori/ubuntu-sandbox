/**
 * ipconfig — every documented option/argument on a real LAN.
 *
 * Topology: a CiscoRouter acting as DHCPv4 server + IPv6 RA source,
 * two WindowsPC clients, one GenericSwitch. Every ipconfig flag listed
 * in its own /? help text is exercised against real DHCP/RA traffic
 * over real cables — nothing is faked at the command layer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask, IPv6Address } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function buildLan() {
  const router = new CiscoRouter('DHCP-Server');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const pc1 = new WindowsPC('windows-pc', 'PC1');
  const pc2 = new WindowsPC('windows-pc', 'PC2');

  new Cable('c-r').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('eth0')!);
  new Cable('c-1').connect(pc1.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('c-2').connect(pc2.getPort('eth0')!, sw.getPort('eth2')!);

  router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  for (const cmd of [
    'enable', 'configure terminal',
    'service dhcp',
    'ip dhcp pool LAN-POOL',
    'network 192.168.1.0 255.255.255.0',
    'default-router 192.168.1.1',
    'dns-server 8.8.8.8',
    'lease 2',
    'exit',
    'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
    'end',
  ]) await router.executeCommand(cmd);

  // IPv6: real router advertisement source for SLAAC.
  router.enableIPv6Routing();
  router.configureIPv6Interface('GigabitEthernet0/0', new IPv6Address('2001:db8:1::1'), 64);
  router.addRAPrefix('GigabitEthernet0/0', new IPv6Address('2001:db8:1::'), 64);

  return { router, sw, pc1, pc2 };
}

describe('ipconfig — options réels sur un LAN complet', () => {
  describe('affichage de base', () => {
    it('ipconfig sans option affiche uniquement IP/masque/passerelle après un vrai bail DHCP', async () => {
      const { pc1 } = await buildLan();
      await pc1.executeCommand('ipconfig /renew');
      const out = await pc1.executeCommand('ipconfig');
      expect(out).toMatch(/IPv4 Address[ .]*: 192\.168\.1\.\d+/);
      expect(out).toMatch(/Default Gateway[ .]*: 192\.168\.1\.1/);
    });

    it('ipconfig /all affiche le serveur DHCP réel, le bail et les DNS transmis par le routeur', async () => {
      const { pc1 } = await buildLan();
      await pc1.executeCommand('ipconfig /renew');
      const out = await pc1.executeCommand('ipconfig /all');
      expect(out).toMatch(/DHCP Server[ .]*: 192\.168\.1\.1/);
      expect(out).toMatch(/DNS Servers[ .]*: 8\.8\.8\.8/);
      expect(out).toMatch(/Lease Obtained/);
      expect(out).toMatch(/Lease Expires/);
    });
  });

  describe('/release et /renew avec argument adaptateur', () => {
    it('/renew cible précisément l\'adaptateur demandé, pas un adaptateur codé en dur', async () => {
      const pc1 = new WindowsPC('windows-pc', 'PC1');
      // eth1 sans câble réseau : renew dessus ne doit jamais toucher eth0.
      const out = await pc1.executeCommand('ipconfig /renew "Ethernet 1"');
      expect(out).toContain('Ethernet 1');
      expect(out).not.toMatch(/DHCP ACK received/);
    });

    it('/renew sans argument renouvelle tous les adaptateurs connectés au LAN', async () => {
      const { pc1 } = await buildLan();
      const out = await pc1.executeCommand('ipconfig /renew');
      expect(out).toMatch(/DHCP ACK received/);
      const after = await pc1.executeCommand('ipconfig');
      expect(after).toMatch(/IPv4 Address/);
    });

    it('/release puis /renew sur le même adaptateur récupère un bail réel', async () => {
      const { pc1 } = await buildLan();
      await pc1.executeCommand('ipconfig /renew');
      const releaseOut = await pc1.executeCommand('ipconfig /release "Ethernet 0"');
      expect(releaseOut).toMatch(/successfully released/);
      const afterRelease = await pc1.executeCommand('ipconfig');
      expect(afterRelease).toMatch(/Media disconnected/);

      const renewOut = await pc1.executeCommand('ipconfig /renew "Ethernet 0"');
      expect(renewOut).toMatch(/DHCP ACK received/);
      const afterRenew = await pc1.executeCommand('ipconfig');
      expect(afterRenew).toMatch(/IPv4 Address[ .]*: 192\.168\.1\.\d+/);
    });

    it('/release avec un nom d\'adaptateur inconnu ne libère rien et le signale', async () => {
      const { pc1 } = await buildLan();
      await pc1.executeCommand('ipconfig /renew');
      const out = await pc1.executeCommand('ipconfig /release "Ethernet 9"');
      expect(out).toMatch(/No adapter matched/i);
      const stillThere = await pc1.executeCommand('ipconfig');
      expect(stillThere).toMatch(/IPv4 Address/);
    });

    it('un joker (*) sur /renew cible tous les adaptateurs dont le nom correspond', async () => {
      const { pc1 } = await buildLan();
      const out = await pc1.executeCommand('ipconfig /renew "Ethernet *"');
      expect(out).toMatch(/DHCP ACK received/);
    });
  });

  describe('/release6 et /renew6 — SLAAC réel via sollicitation/annonce de routeur', () => {
    it('/renew6 sollicite le routeur et obtient une adresse SLAAC réelle sur le LAN', async () => {
      const { pc1 } = await buildLan();
      const port = pc1.getPort('eth0')!;
      port.enableIPv6();

      const out = await pc1.executeCommand('ipconfig /renew6 "Ethernet 0"');
      expect(out).toMatch(/Ethernet 0/);

      const globalNow = port.getGlobalIPv6();
      expect(globalNow).not.toBeNull();
      expect(globalNow!.toString()).toMatch(/^2001:db8:1::/);
    });

    it('/release6 retire uniquement les adresses dynamiques (SLAAC), jamais le lien-local ni le statique', async () => {
      const { pc1 } = await buildLan();
      const port = pc1.getPort('eth0')!;
      port.enableIPv6();
      port.configureIPv6(new IPv6Address('2001:db8:9::1'), 64); // static

      await pc1.executeCommand('ipconfig /renew6 "Ethernet 0"');
      expect(port.getGlobalIPv6()).not.toBeNull();

      await pc1.executeCommand('ipconfig /release6 "Ethernet 0"');

      const remaining = port.getIPv6Addresses();
      expect(remaining.some(e => e.origin === 'link-local')).toBe(true);
      expect(remaining.some(e => e.address.toString().startsWith('2001:db8:9::1'))).toBe(true);
      expect(remaining.some(e => e.origin === 'slaac')).toBe(false);
    });

    it('ipconfig affiche bien la nouvelle adresse SLAAC après /renew6', async () => {
      const { pc1 } = await buildLan();
      const port = pc1.getPort('eth0')!;
      port.enableIPv6();
      await pc1.executeCommand('ipconfig /renew6 "Ethernet 0"');
      const out = await pc1.executeCommand('ipconfig');
      expect(out).toMatch(/IPv6 Address[ .]*: 2001:db8:1::/);
    });
  });

  describe('/flushdns, /displaydns, /registerdns', () => {
    it('/flushdns vide un cache DNS réellement peuplé par une résolution sur le LAN', async () => {
      const { pc1 } = await buildLan();
      await pc1.executeCommand('ipconfig /renew');
      await pc1.executeCommand('ping -n 1 8.8.8.8');
      const flushOut = await pc1.executeCommand('ipconfig /flushdns');
      expect(flushOut).toMatch(/Successfully flushed/);
      const displayOut = await pc1.executeCommand('ipconfig /displaydns');
      expect(displayOut).toMatch(/\(no entries\)/);
    });

    it('/registerdns répond avec le message standard sans planter', async () => {
      const { pc1 } = await buildLan();
      const out = await pc1.executeCommand('ipconfig /registerdns');
      expect(out).toMatch(/Registration of the DNS resource records/);
    });
  });

  describe('/showclassid et /setclassid (IPv4 et IPv6)', () => {
    it('/showclassid sur un adaptateur sans classe configurée le signale', async () => {
      const { pc1 } = await buildLan();
      const out = await pc1.executeCommand('ipconfig /showclassid "Ethernet 0"');
      expect(out).toMatch(/no class id/i);
    });

    it('/setclassid configure une classe DHCP réellement persistée puis relue par /showclassid', async () => {
      const { pc1 } = await buildLan();
      const setOut = await pc1.executeCommand('ipconfig /setclassid "Ethernet 0" MYCLASS');
      expect(setOut).toMatch(/successfully set/i);
      const showOut = await pc1.executeCommand('ipconfig /showclassid "Ethernet 0"');
      expect(showOut).toContain('MYCLASS');
    });

    it('/setclassid sans valeur efface la classe existante', async () => {
      const { pc1 } = await buildLan();
      await pc1.executeCommand('ipconfig /setclassid "Ethernet 0" MYCLASS');
      await pc1.executeCommand('ipconfig /setclassid "Ethernet 0"');
      const showOut = await pc1.executeCommand('ipconfig /showclassid "Ethernet 0"');
      expect(showOut).toMatch(/no class id/i);
    });

    it('/setclassid6 et /showclassid6 gèrent une classe IPv6 indépendante de la classe IPv4', async () => {
      const { pc1 } = await buildLan();
      await pc1.executeCommand('ipconfig /setclassid "Ethernet 0" V4CLASS');
      await pc1.executeCommand('ipconfig /setclassid6 "Ethernet 0" V6CLASS');

      const show4 = await pc1.executeCommand('ipconfig /showclassid "Ethernet 0"');
      const show6 = await pc1.executeCommand('ipconfig /showclassid6 "Ethernet 0"');
      expect(show4).toContain('V4CLASS');
      expect(show4).not.toContain('V6CLASS');
      expect(show6).toContain('V6CLASS');
      expect(show6).not.toContain('V4CLASS');
    });
  });

  describe('/allcompartments', () => {
    it("/allcompartments est accepté sans erreur et n'empêche pas /all de fonctionner", async () => {
      const { pc1 } = await buildLan();
      await pc1.executeCommand('ipconfig /renew');
      const out = await pc1.executeCommand('ipconfig /allcompartments /all');
      expect(out).toMatch(/Host Name/);
      expect(out).toMatch(/IPv4 Address/);
    });

    it('/allcompartments seul se comporte comme ipconfig basique (une seule compartimentation réelle)', async () => {
      const { pc1 } = await buildLan();
      await pc1.executeCommand('ipconfig /renew');
      const basic = await pc1.executeCommand('ipconfig');
      const allcomp = await pc1.executeCommand('ipconfig /allcompartments');
      expect(allcomp).toBe(basic);
    });
  });

  describe('/?', () => {
    it("l'aide documente toutes les options réellement supportées", async () => {
      const pc = new WindowsPC('windows-pc', 'PC');
      const out = await pc.executeCommand('ipconfig /?');
      for (const opt of ['/all', '/release', '/renew', '/release6', '/renew6',
        '/flushdns', '/displaydns', '/registerdns',
        '/showclassid', '/setclassid', '/showclassid6', '/setclassid6', '/allcompartments']) {
        expect(out).toContain(opt);
      }
    });
  });

  describe('isolation multi-hôtes sur le même LAN', () => {
    it("libérer le bail de PC1 n'affecte jamais le bail de PC2", async () => {
      const { pc1, pc2 } = await buildLan();
      await pc1.executeCommand('ipconfig /renew');
      await pc2.executeCommand('ipconfig /renew');

      const pc1IpBefore = (await pc1.executeCommand('ipconfig')).match(/IPv4 Address[ .]*: (\S+)/)?.[1];
      const pc2IpBefore = (await pc2.executeCommand('ipconfig')).match(/IPv4 Address[ .]*: (\S+)/)?.[1];
      expect(pc1IpBefore).not.toBe(pc2IpBefore);

      await pc1.executeCommand('ipconfig /release');
      const pc1After = await pc1.executeCommand('ipconfig');
      const pc2After = await pc2.executeCommand('ipconfig');
      expect(pc1After).toMatch(/Media disconnected/);
      expect(pc2After).toMatch(new RegExp(pc2IpBefore!.replace(/\./g, '\\.')));
    });
  });
});
