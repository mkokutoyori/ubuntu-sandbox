/*
 * Probe: SD-WAN health checks over TCP. `protocol tcp-connect` opens a real TCP connection from the member
 * interface to the server's port, `protocol http` also sends a GET (`http-get`) and counts only a status below 400
 * (FortiOS CLI Reference 7.4.12, system sdwan > health-check). Measured before: `http` was refused ("only ping
 * probes the server in this build") and `tcp-connect` did not exist. The probe pins the connection to the member's
 * interface (the TCP stack takes an `iface`), so a member whose link leads nowhere is dead even when another member
 * reaches the server. `dns` stays refused in the unit's own words.
 * Discriminated with git stash on src/network: 4 of 7 fall before the fix. Three pass either way and are
 * named: the witness, « a member whose link leads nowhere is dead » (vacuous while the protocol is refused) and the
 * `dns` refusal, which already existed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllDevicePlatforms } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { LabWorkbench } from '@/labs/LabWorkbench';

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); EquipmentRegistry.resetInstance(); Logger.reset();
  await loadAllDevicePlatforms();
  useNetworkStore.getState().clearAll();
});

async function lab(protocol: string, extra: string[] = [], serve = true) {
  const bench = new LabWorkbench();
  const fgt = bench.place('firewall-fortinet', 'F', 0, 0);
  const web = bench.place('linux-server', 'WEB', 0, 0);
  const dead = bench.place('linux-pc', 'DEAD', 0, 0);
  bench.connect(fgt, 'port2', web, 'eth0');
  bench.connect(fgt, 'port3', dead, 'eth0');
  const typed = await bench.shell(fgt,
    'config system interface', 'edit port2', 'set mode static', 'set ip 10.2.0.1 255.255.255.0', 'next',
    'edit port3', 'set mode static', 'set ip 10.3.0.1 255.255.255.0', 'next', 'end',
    'config system sdwan', 'set status enable',
    'config members', 'edit 1', 'set interface "port2"', 'set gateway 10.2.0.10', 'next', 'edit 2', 'set interface "port3"', 'set gateway 10.3.0.10', 'next', 'end',
    'config health-check', 'edit "hc"', 'set server "10.2.0.10"', `set protocol ${protocol}`, ...extra, 'set members 1 2', 'next', 'end', 'end');
  await bench.shell(web, 'ip addr add 10.2.0.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.2.0.1');
  if (serve) {
    await bench.shell(web, 'sudo apt install -y nginx', 'sudo mkdir -p /var/www/s');
    await bench.writeFile(web, '/var/www/s/index.html', 'ok');
    await bench.writeFile(web, '/etc/nginx/sites-available/s.conf', 'server {\n listen 80 default_server;\n root /var/www/s;\n index index.html;\n}');
    await bench.shell(web, 'sudo rm -f /etc/nginx/sites-enabled/default', 'sudo ln -s /etc/nginx/sites-available/s.conf /etc/nginx/sites-enabled/s.conf', 'sudo systemctl restart nginx');
  }
  await fgt.runSdwanHealthChecks();
  return { fgt, typed, view: await fgt.executeCommand('diagnose sys sdwan health-check') };
}

describe('sdwan health-check over TCP', () => {
  it('witness: with ping the member that reaches the server is alive', async () => {
    const { view } = await lab('ping', [], false);
    expect(view).toMatch(/Seq\(1 port2\): state\(alive\)/);
  });

  it('tcp-connect is accepted and a listening port makes the member alive', async () => {
    const { typed, view } = await lab('tcp-connect', ['set port 80']);
    expect(typed).not.toMatch(/Command fail/);
    expect(view).toMatch(/Seq\(1 port2\): state\(alive\)/);
  });

  it('tcp-connect to a closed port makes the member dead', async () => {
    const { view } = await lab('tcp-connect', ['set port 9999']);
    expect(view).toMatch(/Seq\(1 port2\): state\(dead\)/);
  });

  it('a member whose link leads nowhere is dead although the server answers elsewhere', async () => {
    const { view } = await lab('tcp-connect', ['set port 80']);
    expect(view).toMatch(/Seq\(2 port3\): state\(dead\)/);
  });

  it('http with a served page makes the member alive', async () => {
    const { typed, view } = await lab('http', ['set http-get "/"']);
    expect(typed).not.toMatch(/Command fail/);
    expect(view).toMatch(/Seq\(1 port2\): state\(alive\)/);
  });

  it('http on a missing page (404) makes the member dead', async () => {
    const { view } = await lab('http', ['set http-get "/absent.html"']);
    expect(view).toMatch(/Seq\(1 port2\): state\(dead\)/);
  });

  it('dns is still refused in the unit\'s own words', async () => {
    const { typed } = await lab('dns', [], false);
    expect(typed).toMatch(/DNS probe/);
  });
});
