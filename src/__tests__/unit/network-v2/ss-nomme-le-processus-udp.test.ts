import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const CONF = `
authoritative;
subnet 192.168.60.0 netmask 255.255.255.0 {
  range 192.168.60.100 192.168.60.150;
  option routers 192.168.60.254;
}
`;

async function serveur() {
  const srv = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(srv.getPorts()[0], sw.getPorts()[0]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.60.1'), new SubnetMask('255.255.255.0'));
  srv.powerOn();
  await srv.executeCommand(`printf '%s' ${JSON.stringify(CONF)} > /etc/dhcp/dhcpd.conf`);
  return srv;
}

function ligneDuPort(sortie: string, port: number): string {
  return sortie.split('\n').find(l => new RegExp(`:${port}\\b`).test(l)) ?? '';
}

describe('`ss -lunp` nomme le processus derriere une socket UDP', () => {
  it('un demon demarre est nomme, avec son PID', async () => {
    const srv = await serveur();
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    const vu = ligneDuPort(await srv.executeCommand('ss -lunp'), 67);

    expect(vu).toMatch(/users:\(\("dhcpd",pid=\d+,fd=\d+\)\)/);
  });

  it('le PID affiche est celui que systemd tient pour cette unite', async () => {
    const srv = await serveur();
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    const attendu = /MainPID=(\d+)/
      .exec(await srv.executeCommand('systemctl show isc-dhcp-server -p MainPID'))?.[1];
    expect(attendu).toBeDefined();
    expect(Number(attendu)).toBeGreaterThan(0);

    const vu = ligneDuPort(await srv.executeCommand('ss -lunp'), 67);
    expect(vu).toContain(`pid=${attendu}`);
  });

  it('le service arrete, la ligne disparait', async () => {
    const srv = await serveur();
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');
    await srv.executeCommand('sudo systemctl stop isc-dhcp-server');

    expect(ligneDuPort(await srv.executeCommand('ss -lunp'), 67)).toBe('');
  });

  it('`netstat -anup` nomme le meme processus et le meme PID', async () => {
    const srv = await serveur();
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    const pid = /pid=(\d+)/
      .exec(ligneDuPort(await srv.executeCommand('ss -lunp'), 67))?.[1];
    expect(pid).toBeDefined();

    const vu = ligneDuPort(await srv.executeCommand('netstat -anup'), 67);
    expect(vu).toContain(`${pid}/dhcpd`);
  });

  it('les autres demons UDP de la machine sont nommes eux aussi', async () => {
    const srv = await serveur();

    const vu = await srv.executeCommand('ss -lunp');

    expect(ligneDuPort(vu, 53)).toMatch(/users:\(\("systemd-resolved",pid=\d+/);
    expect(ligneDuPort(vu, 1812)).toMatch(/users:\(\("freeradius",pid=\d+/);
  });

  it('une socket sans processus derriere elle n en invente pas', async () => {
    const srv = await serveur();
    srv.udpBind(56789, () => undefined, 'zorglub');

    const vu = ligneDuPort(await srv.executeCommand('ss -lunp'), 56789);

    expect(vu).not.toContain('users:');
    expect(vu).toMatch(/:56789/);
  });

  it('sans -p, aucune colonne de processus n est rendue', async () => {
    const srv = await serveur();
    await srv.executeCommand('sudo systemctl start isc-dhcp-server');

    const vu = await srv.executeCommand('ss -lun');

    expect(vu).not.toContain('users:');
    expect(vu).toMatch(/:67\b/);
  });

  it('les sockets TCP gardent le PID qu elles portaient deja', async () => {
    const srv = await serveur();

    const vu = await srv.executeCommand('ss -ltnp');

    expect(ligneDuPort(vu, 22)).toMatch(/users:\(\("sshd",pid=\d+/);
  });
});
