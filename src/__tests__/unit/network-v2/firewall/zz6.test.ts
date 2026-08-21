import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const lan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const dmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

  new Cable('lan').connect(lan.getPort('eth0')!, fgt.getPort('port1')!);
  new Cable('dmz').connect(dmz.getPort('eth0')!, fgt.getPort('port2')!);

  await taper(fgt, [
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config firewall policy',
    'edit 1', 'set name "LAN-vers-DMZ-web"',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "HTTP" "PING"',
    'set action accept', 'next',
    'edit 2', 'set name "Jamais-utilisee"',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'next', 'end',
  ]);

  await taper(lan, [
    'ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(dmz, [
    'ip link set eth0 up', 'ip addr add 192.168.20.10/24 dev eth0',
    'ip route add default via 192.168.20.1',
  ]);
  await dmz.executeCommand('systemctl start nginx');

  return { fgt, lan, dmz };
}

async function journalisation(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config log memory setting', 'set status enable', 'end',
    'config log memory global-setting', 'set max-size 98304', 'end',
    'config log setting', 'set fwpolicy-implicit-log enable', 'end',
    'config firewall policy',
    'edit 1', 'set logtraffic all', 'set logtraffic-start enable', 'next',
    'edit 2', 'set logtraffic all', 'next', 'end',
  ]);
}


describe('dbg6', () => {
  it('deny', async () => {
    const { fgt, lan } = await laboratoire();
    const out = await journalisation(fgt);
    process.stderr.write('DBG6 journ=' + JSON.stringify(out.filter(o => o.length > 0)) + '\n');
    process.stderr.write('DBG6 logsetting=' + await fgt.executeCommand('show log setting') + '\n');
    const c = await lan.executeCommand('curl -sS -m 1 http://192.168.20.10:22/');
    process.stderr.write('DBG6 curl=' + c + '\n');
    await taper(fgt, ['execute log filter reset', 'execute log filter category 0']);
    process.stderr.write('DBG6 logs=' + await fgt.executeCommand('execute log display') + '\n');
    expect(1).toBe(1);
  });
});
