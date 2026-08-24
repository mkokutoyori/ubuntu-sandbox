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

async function inConfig(): Promise<CiscoRouter> {
  const router = new CiscoRouter('R1');
  await router.executeCommand('enable');
  await router.executeCommand('configure terminal');
  return router;
}

async function inInterface(): Promise<CiscoRouter> {
  const router = await inConfig();
  await router.executeCommand('interface GigabitEthernet0/0');
  return router;
}

describe('A consumed argument no longer breaks help', () => {
  it.each([
    'ip address 192.168.10.1 ?',
    'mtu ?',
    'bandwidth ?',
  ])('%s answers something', async (command) => {
    const router = await inInterface();
    const help = await router.executeCommand(command);
    expect(help).not.toContain('Unrecognized');
    expect(help.trim().length).toBeGreaterThan(0);
  });

  it.each([
    'access-list 10 ?',
    'ntp server ?',
    'snmp-server community ?',
    'ip route ?',
    'router ospf ?',
    'ip dhcp excluded-address ?',
    'ip ssh time-out ?',
  ])('%s answers something', async (command) => {
    const router = await inConfig();
    const help = await router.executeCommand(command);
    expect(help).not.toContain('Unrecognized');
    expect(help.trim().length).toBeGreaterThan(0);
  });

  it('the Cisco CLI no longer emits % Unrecognized command', async () => {
    const router = await inInterface();
    const probes = [
      'ip address 192.168.10.1 ?',
      'ip address 192.168.10.1 255.255.255.0 ?',
      'encapsulation dot1Q ?',
      'nimportequoi ?',
      'show nimportequoi ?',
    ];
    for (const probe of probes) {
      expect(await router.executeCommand(probe)).not.toContain('Unrecognized');
    }
  });

  it('an unmatched input returns the IOS refusal', async () => {
    const router = await inConfig();
    expect(await router.executeCommand('zzzz ?'))
      .toMatch(/% Invalid input detected at '\^' marker\./);
  });
});

describe('L\'help annonce le TYPE de l\'argument, comme IOS', () => {
  it('ip address <address> ? announces the mask', async () => {
    const router = await inInterface();
    const help = await router.executeCommand('ip address 192.168.10.1 ?');
    expect(help).toContain('A.B.C.D');
    expect(help).toContain('IP subnet mask');

    expect(help).not.toContain('dhcp');
  });

  it('encapsulation dot1Q ? announces the VLAN range', async () => {
    const router = await inInterface();
    expect(await router.executeCommand('encapsulation dot1Q ?')).toContain('<1-4094>');
  });

  it('mtu ? and bandwidth ? announce their ranges', async () => {
    const router = await inInterface();
    expect(await router.executeCommand('mtu ?')).toContain('<68-9216>');
    expect(await router.executeCommand('bandwidth ?')).toContain('<1-10000000>');
  });

  it.each([
    ['ntp server ?', 'A.B.C.D'],
    ['ip route ?', 'A.B.C.D'],
    ['ip dhcp excluded-address ?', 'A.B.C.D'],
    ['router ospf ?', '<1-65535>'],
    ['ip ssh time-out ?', '<1-120>'],
  ])('%s announces %s', async (command, expected) => {
    const router = await inConfig();
    expect(await router.executeCommand(command)).toContain(expected);
  });

  it('access-list ? announces the four IOS ranges, not one made-up span', async () => {
    const router = await inConfig();

    expect((await router.executeCommand('access-list ?')).split('\n')).toEqual([
      '  <1-99>       IP standard access list',
      '  <100-199>    IP extended access list',
      '  <1300-1999>  IP standard access list (expanded range)',
      '  <2000-2699>  IP extended access list (expanded range)',
    ]);
  });

  it('snmp-server community ? announces WORD and its description', async () => {
    const router = await inConfig();
    const help = await router.executeCommand('snmp-server community ?');
    expect(help).toContain('WORD');
    expect(help).toContain('SNMP community string');
  });

  it('a keyword FOLLOWING the argument is still offered', async () => {
    const router = await inConfig();

    const help = await router.executeCommand('access-list 10 ?');
    expect(help).toContain('permit');
    expect(help).toContain('deny');
  });
});

describe('Execution is unchanged', () => {
  it('commands whose help was declared still execute', async () => {
    const router = await inInterface();
    expect(await router.executeCommand('ip address 192.168.10.1 255.255.255.0')).toBe('');
    expect(await router.executeCommand('mtu 1400')).toBe('');
    await router.executeCommand('exit');
    expect(await router.executeCommand('ip route 10.0.0.0 255.0.0.0 192.168.10.2')).toBe('');
    expect(await router.executeCommand('ntp server 192.168.10.9')).toBe('');
    expect(router.getPort('GigabitEthernet0/0')!.getIPAddress()!.toString())
      .toBe('192.168.10.1');
  });

  it('a hint-only node does not become executable', async () => {
    const router = await inInterface();

    expect(await router.executeCommand('encapsulation dot1Q 10')).not.toMatch(/Invalid input/);
  });
});

describe('L\'help n\'invente pas de commandes', () => {
  it('a hint-only node is not offered as a command', async () => {
    const router = await inInterface();
    const help = await router.executeCommand('?');

    expect(help).not.toMatch(/^\s+helper-address\b/m);
    expect(help).not.toMatch(/^\s+cost\b/m);
  });

  it('no offered keyword lacks a description', async () => {
    const router = await inInterface();
    await router.executeCommand('exit');
    await router.executeCommand('line vty 0 4');
    const help = await router.executeCommand('password ?');

    const undescribed = help.split('\n')
      .filter((l) => l.trim().length > 0 && !l.includes('<cr>'))
      .filter((l) => /^\s+\S+\s*$/.test(l));
    expect(undescribed).toEqual([]);
  });

  it('but a real keyword the handler accepts is still offered', async () => {
    const router = await inConfig();
    const help = await router.executeCommand('access-list 10 ?');
    expect(help).toContain('permit');
    expect(help).toContain('deny');
    expect(help).toMatch(/permit\s+\S+/);
  });
});
