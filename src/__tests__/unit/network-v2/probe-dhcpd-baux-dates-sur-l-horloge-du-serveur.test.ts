/**
 * Les baux d'`isc-dhcp-server` se datent et expirent sur l'horloge du SERVEUR (`dhcpd` lit `time(NULL)`). Le moteur DHCP de la
 * machine Linux (`LinuxDhcpdService`) et le client DHCP de chaque poste (`EndHost`) gardaient l'horloge globale du simulateur :
 * apres `date -s`, `dhcpd.leases` datait les baux de l'heure d'avant le saut (`starts` / `ends`), et un bail de dix minutes
 * posé avant un saut d'une heure restait « actif » au lieu d'expirer. Corrige : `LinuxDhcpdService` et `EndHost` donnent
 * `getSystemClockMs()` a leur moteur DHCP, comme le faisaient deja le Router, le Switch, Windows Server et le pare-feu.
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (serveur avance de deux jours). Le TEMOIN (a l'heure, le
 * bail est ecrit dans dhcpd.leases) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const CONF = `authoritative;
default-lease-time 600;
max-lease-time 7200;
subnet 192.168.60.0 netmask 255.255.255.0 {
  range 192.168.60.100 192.168.60.150;
}
`;

async function lab(): Promise<{ srv: LinuxServer; pc: LinuxPC }> {
  const srv = new LinuxServer('linux-server', 'SRV-DHCP');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(pc.getPorts()[0], sw.getPorts()[1]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.60.1'), new SubnetMask('255.255.255.0'));
  srv.powerOn();
  pc.powerOn();
  await srv.executeCommand(`printf '%b' ${JSON.stringify(CONF)} > /etc/dhcp/dhcpd.conf`);
  await srv.executeCommand('sudo systemctl start isc-dhcp-server');
  return { srv, pc };
}

describe('les baux dhcpd sont dates sur l horloge du serveur', () => {
  it('TEMOIN — a l heure, le bail est ecrit dans dhcpd.leases', async () => {
    const { srv, pc } = await lab();
    await pc.executeCommand('dhclient eth0');
    expect(await srv.executeCommand('cat /var/lib/dhcp/dhcpd.leases')).toMatch(/starts \d \d{4}\/\d{2}\/\d{2}/);
  });

  it('un serveur avance de deux jours date le bail de sa propre horloge', async () => {
    const { srv, pc } = await lab();
    await srv.executeCommand('date -s "2027-05-20 14:00:00"');
    await pc.executeCommand('dhclient eth0');
    expect(await srv.executeCommand('cat /var/lib/dhcp/dhcpd.leases')).toContain('starts 4 2027/05/20 14:00:');
  });
});
