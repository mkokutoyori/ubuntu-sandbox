import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

interface Lab {
  sw: CiscoSwitch;
  srv: LinuxServer;
  win: WindowsPC;
}

async function buildLab(): Promise<Lab> {
  const sw = new CiscoSwitch('cisco-sw', 'Switch1', 24, 0, 0);
  const srv = new LinuxServer('Linux-SRV');
  const win = new WindowsPC('Win-Client');
  new Cable('c1').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  await srv.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
  win.configureInterface('eth0', new IPAddress('192.168.1.20'), new SubnetMask('255.255.255.0'));
  return { sw, srv, win };
}

const pktLine = (out: string) => out.split('\n').find(l => l.includes('packets transmitted')) ?? '';

describe('Switch reference scenarios — USER EXEC', () => {
  it('1. "?" lists the user-EXEC command set without requiring privileges', async () => {
    const { sw } = await buildLab();
    const help = await sw.executeCommand('?');
    for (const kw of ['enable', 'show', 'ping', 'terminal', 'ssh', 'telnet']) {
      expect(help).toContain(kw);
    }
    expect(help).not.toContain('configure');
  });

  it('2. "enable" elevates privilege (prompt > → #) and "enable ?" offers <cr>', async () => {
    const { sw } = await buildLab();
    expect(sw.getPrompt()).toBe('Switch1>');
    expect(await sw.executeCommand('enable ?')).toContain('<cr>');
    await sw.executeCommand('enable');
    expect(sw.getPrompt()).toBe('Switch1#');
  });

  it('2b. "enable secret" is stored in the running configuration', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    expect(await sw.executeCommand('enable secret cisco123')).toBe('');
    await sw.executeCommand('end');
    expect(await sw.executeCommand('show running-config')).toMatch(/enable secret/);
  });

  it('3. "show mac address-table" reflects the CAM entry learned from Linux-SRV on Fa0/1', async () => {
    const { sw, srv } = await buildLab();
    await srv.executeCommand('ping -c 2 192.168.1.20');
    await sw.executeCommand('enable');
    const table = await sw.executeCommand('show mac address-table');
    const srvMac = srv.getPort('eth0')!.getMAC().toString().toLowerCase();
    expect(table.toLowerCase()).toContain(srvMac);
    expect(table).toContain('FastEthernet0/1');
    expect(table).toContain('DYNAMIC');
  });

  it('4. "terminal length 0" is accepted (pagination disabled for the session)', async () => {
    const { sw } = await buildLab();
    expect(await sw.executeCommand('terminal length 0')).toBe('');
  });

  it('8. "debug spanning-tree events" arms STP tracing and "undebug all" clears it', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    expect((await sw.executeCommand('debug spanning-tree events')).toLowerCase()).toContain('debugging is on');
    expect((await sw.executeCommand('undebug all')).toLowerCase()).toContain('turned off');
  });

  it('9. "no debug all" turns every debug flag off', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    await sw.executeCommand('debug spanning-tree events');
    expect((await sw.executeCommand('no debug all')).toLowerCase()).toContain('turned off');
  });
});

describe('Switch reference scenarios — PRIVILEGED EXEC', () => {
  it('10. "configure terminal" enters global config and a VLAN split severs L2 reachability', async () => {
    const { sw, srv } = await buildLab();
    expect(pktLine(await srv.executeCommand('ping -c 2 192.168.1.20'))).toContain('2 received');

    await sw.executeCommand('enable');
    expect(await sw.executeCommand('configure terminal')).toBeDefined();
    expect(sw.getPrompt()).toBe('Switch1(config)#');
    await sw.executeCommand('vlan 10'); await sw.executeCommand('exit');
    await sw.executeCommand('vlan 20'); await sw.executeCommand('exit');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('exit');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport access vlan 20');
    await sw.executeCommand('end');

    expect(pktLine(await srv.executeCommand('ping -c 2 192.168.1.20'))).toContain('0 received');
  });

  it('11. "disable" returns the session to user EXEC (prompt # → >)', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    expect(sw.getPrompt()).toBe('Switch1#');
    await sw.executeCommand('disable');
    expect(sw.getPrompt()).toBe('Switch1>');
  });

  it('12. "write memory" persists running-config to NVRAM ([OK])', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    expect(await sw.executeCommand('write memory')).toContain('[OK]');
  });

  it('13. "erase startup-config" warns then erases NVRAM ([OK])', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('erase startup-config');
    expect(out).toContain('Continue? [confirm]');
    expect(out).toContain('[OK]');
  });

  it('14. "reload" restarts the device and it comes back powered on', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    expect(await sw.executeCommand('reload')).toContain('System restarting');
    expect(sw.getIsPoweredOn()).toBe(true);
  });

  it('15. "clear mac address-table dynamic" empties the CAM; traffic then re-learns it', async () => {
    const { sw, srv } = await buildLab();
    await srv.executeCommand('ping -c 2 192.168.1.20');
    await sw.executeCommand('enable');
    expect(sw.getMACTable().length).toBeGreaterThan(0);
    expect(await sw.executeCommand('clear mac address-table dynamic')).toBe('');
    expect(sw.getMACTable().filter(e => e.type === 'dynamic')).toHaveLength(0);
    await srv.executeCommand('ping -c 2 192.168.1.20');
    expect(sw.getMACTable().length).toBeGreaterThan(0);
  });

  it('15b. "clear mac address-table dynamic" keeps administrator static entries', async () => {
    const { sw } = await buildLab();
    const table = (sw as unknown as { macTable: Map<string, { mac: string; vlan: number; port: string; type: string; age: number; timestamp: number }> }).macTable;
    table.set('1:0000.0000.00aa', { mac: '0000.0000.00aa', vlan: 1, port: 'FastEthernet0/1', type: 'dynamic', age: 300, timestamp: Date.now() });
    table.set('1:0000.0000.00bb', { mac: '0000.0000.00bb', vlan: 1, port: 'FastEthernet0/2', type: 'static', age: 0, timestamp: Date.now() });
    await sw.executeCommand('enable');
    await sw.executeCommand('clear mac address-table dynamic');
    const remaining = sw.getMACTable();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].type).toBe('static');
  });
});

describe('Switch reference scenarios — management SVI (pending Vlan1 IP stack)', () => {
  it.skip('5. "copy startup-config tftp:" performs a real ARP+UDP/69 transfer to Linux-SRV', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface vlan 1');
    await sw.executeCommand('ip address 192.168.1.254 255.255.255.0');
    await sw.executeCommand('no shutdown');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('copy startup-config tftp:');
    expect(out).toContain('!');
  });

  it.skip('6. "ssh -l sysadmin 192.168.1.10" opens a TCP/22 session sourced from the SVI', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface vlan 1');
    await sw.executeCommand('ip address 192.168.1.254 255.255.255.0');
    await sw.executeCommand('no shutdown');
    await sw.executeCommand('end');
    expect(await sw.executeCommand('ssh -l sysadmin 192.168.1.10')).not.toContain('No usable interface IP');
  });

  it.skip('7. "ping 192.168.1.10" succeeds from the switch SVI (Linux-SRV replies)', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface vlan 1');
    await sw.executeCommand('ip address 192.168.1.254 255.255.255.0');
    await sw.executeCommand('no shutdown');
    await sw.executeCommand('end');
    expect(await sw.executeCommand('ping 192.168.1.10')).toContain('Success rate is 100 percent');
  });

  it.skip('16. "sntp server 192.168.1.10" actually synchronises the clock from Linux-SRV', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface vlan 1');
    await sw.executeCommand('ip address 192.168.1.254 255.255.255.0');
    await sw.executeCommand('no shutdown');
    expect(await sw.executeCommand('sntp server 192.168.1.10')).toBe('');
  });
});
