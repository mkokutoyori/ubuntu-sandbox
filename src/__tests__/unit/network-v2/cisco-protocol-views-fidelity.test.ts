import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab(...extra: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    ...extra, 'end']) await r.executeCommand(c);
  return r;
}

describe('show ip protocols reports every process that runs', () => {
  it('OSPF is there at all, which it was not', async () => {
    const r = await lab('router ospf 1', 'network 192.168.10.0 0.0.0.255 area 0', 'exit');
    const out = String(await r.executeCommand('show ip protocols'));

    expect(out).toContain('Routing Protocol is "ospf 1"');
    expect(out).toContain('Router ID 192.168.10.1');
    expect(out).toContain('Number of areas in this router is 1.');
    expect(out).toContain('    192.168.10.0 0.0.0.255 area 0');
    expect(out).toContain('Distance: (default is 110)');
  });

  it('EIGRP carries its AS, weights, distances and paths', async () => {
    const r = await lab('router eigrp 100', 'network 192.168.10.0', 'exit');
    const out = String(await r.executeCommand('show ip protocols'));

    expect(out).toContain('EIGRP-IPv4 Protocol for AS(100)');
    expect(out).toContain('Metric weight K1=1, K2=0, K3=1, K4=0, K5=0');
    expect(out).toContain('Distance: internal 90 external 170');
    expect(out).toContain('Maximum path: 4');
    expect(out).toContain('Routing Information Sources:');
  });

  it('and the two coexist', async () => {
    const r = await lab(
      'router ospf 1', 'network 192.168.10.0 0.0.0.255 area 0', 'exit',
      'router eigrp 100', 'network 192.168.10.0', 'exit');
    const out = String(await r.executeCommand('show ip protocols'));

    expect(out).toContain('Routing Protocol is "ospf 1"');
    expect(out).toContain('Routing Protocol is "eigrp 100"');
  });
});

describe('show ip dhcp pool uses the IOS layout', () => {
  it('the utilization marks, the subnet size and the per-subnet table', async () => {
    const r = await lab('ip dhcp excluded-address 192.168.10.1 192.168.10.10',
      'ip dhcp pool LAN', 'network 192.168.10.0 255.255.255.0', 'exit');
    const out = String(await r.executeCommand('show ip dhcp pool'));

    expect(out).toContain('Utilization mark (high/low)');
    expect(out).toContain('Subnet size (first/next)');
    expect(out).toContain('1 subnet is currently in the pool :');
    expect(out).toContain('Current index        IP address range');
    expect(out).toContain('Leased/Excluded/Total');
  });

  it('the range spans the subnet and the exclusions are counted beside it', async () => {
    const r = await lab('ip dhcp excluded-address 192.168.10.1 192.168.10.10',
      'ip dhcp pool LAN', 'network 192.168.10.0 255.255.255.0', 'exit');
    const out = String(await r.executeCommand('show ip dhcp pool'));

    expect(out).toContain('192.168.10.1     - 192.168.10.254');
    expect(out).toContain('Total addresses                : 254');
    expect(out).toContain('Excluded addresses             : 10');
  });
});

describe('show ip ospf interface brief fits its columns', () => {
  it('the interface name is abbreviated the way IOS abbreviates it', async () => {
    const r = await lab('router ospf 1', 'network 192.168.10.0 0.0.0.255 area 0', 'exit');
    const rows = String(await r.executeCommand('show ip ospf interface brief')).split('\n');
    const row = rows.find(l => l.startsWith('Gi0/0')) ?? '';

    expect(row).not.toBe('');
    expect(rows[0].indexOf('PID')).toBe(row.indexOf('1', 5));
  });
});

describe('an RSA key pair names itself after the router', () => {
  it('the key name is the fully qualified identity, not "default"', async () => {
    const r = await lab('ip domain-name lab.local', 'crypto key generate rsa modulus 1024');
    const out = String(await r.executeCommand('show crypto key mypubkey rsa'));

    expect(out).toContain('Key name: R1.lab.local');
    expect(out).not.toContain('Key name: default');
  });

  it('and it is a general purpose key, as the command produces', async () => {
    const r = await lab('ip domain-name lab.local', 'crypto key generate rsa modulus 1024');
    expect(String(await r.executeCommand('show crypto key mypubkey rsa')))
      .toContain('Usage: General Purpose Key');
  });

  it('the generation date is written the way IOS writes it', async () => {
    const r = await lab('ip domain-name lab.local', 'crypto key generate rsa modulus 1024');
    expect(String(await r.executeCommand('show crypto key mypubkey rsa')))
      .toMatch(/% Key pair was generated at: \d{2}:\d{2}:\d{2} UTC [A-Z][a-z]{2} \d{1,2} \d{4}/);
  });
});
