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

async function configuredRouter(): Promise<CiscoRouter> {
  const router = new CiscoRouter('R1');
  for (const command of [
    'enable', 'configure terminal',
    'hostname R-TEST',
    'enable secret cisco123',
    'username admin secret adminpass',
    'ip domain-name lab.local',
    'crypto key generate rsa modulus 2048',
    'interface GigabitEthernet0/0',
    'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/3', 'shutdown', 'exit',
    'router eigrp 100', 'network 192.168.10.0', 'exit',
    'router ospf 1', 'network 192.168.10.0 0.0.0.255 area 0', 'exit',
    'line console 0', 'password conspass', 'exit',
    'end',
  ]) await router.executeCommand(command);
  return router;
}

function indexOfLine(config: string, pattern: RegExp): number {
  return config.split('\n').findIndex((line) => pattern.test(line));
}

describe('What has no business in a configuration', () => {
  it('an EXEC command is not persisted', async () => {
    const router = await configuredRouter();
    const config = await router.executeCommand('show running-config');
    expect(config).not.toContain('crypto key generate');
  });

  it('a default is not serialized', async () => {
    const router = await configuredRouter();
    const config = await router.executeCommand('show running-config');
    expect(config).not.toMatch(/^service dhcp$/m);
    expect(config).not.toMatch(/^ip routing$/m);
  });
});

describe('Nothing is lost', () => {
  it('router eigrp survives serialization', async () => {
    const router = await configuredRouter();
    const config = await router.executeCommand('show running-config');
    expect(config).toContain('router eigrp 100');
    expect(config).toMatch(/^ network 192\.168\.10\.0$/m);
  });

  it('router ospf too, and both coexist', async () => {
    const router = await configuredRouter();
    const config = await router.executeCommand('show running-config');
    expect(config).toContain('router ospf 1');
    expect(config).toContain('router eigrp 100');
  });

  it('router bgp and router rip are rendered', async () => {
    const router = new CiscoRouter('R1');
    for (const command of [
      'enable', 'configure terminal',
      'router bgp 65001', 'neighbor 10.0.0.2 remote-as 65002', 'network 10.1.0.0', 'exit',
      'router rip', 'version 2', 'network 10.0.0.0', 'no auto-summary', 'exit',
      'end',
    ]) await router.executeCommand(command);

    const config = await router.executeCommand('show running-config');
    expect(config).toContain('router bgp 65001');
    expect(config).toContain(' neighbor 10.0.0.2 remote-as 65002');
    expect(config).toContain('router rip');
    expect(config).toContain(' version 2');
    expect(config).toContain(' no auto-summary');
  });

  it('an interface with no address renders no ip address', async () => {
    const router = await configuredRouter();
    const config = await router.executeCommand('show running-config');
    const block = config.slice(config.indexOf('interface GigabitEthernet0/3'));
    expect(block).toMatch(/^ no ip address$/m);
    expect(block).toMatch(/^ shutdown$/m);
  });

  it('the configuration lets an interface admin state be rebuilt', async () => {
    const router = await configuredRouter();
    const config = await router.executeCommand('show running-config');
    const gi0 = config.slice(config.indexOf('interface GigabitEthernet0/0'),
      config.indexOf('interface GigabitEthernet0/1'));
    const gi3 = config.slice(config.indexOf('interface GigabitEthernet0/3'));

    expect(gi0).not.toMatch(/^ shutdown$/m);
    expect(gi3).toMatch(/^ shutdown$/m);
  });
});

describe('The order is the one IOS uses', () => {
  it('hostname, secrets, identity, interfaces, routing, lines', async () => {
    const router = await configuredRouter();
    const config = await router.executeCommand('show running-config');

    const hostname = indexOfLine(config, /^hostname /);
    const secret = indexOfLine(config, /^enable secret /);
    const username = indexOfLine(config, /^username /);
    const iface = indexOfLine(config, /^interface /);
    const routing = indexOfLine(config, /^router /);
    const line = indexOfLine(config, /^line /);

    expect(hostname).toBeGreaterThan(-1);
    expect(secret).toBeGreaterThan(hostname);
    expect(username).toBeGreaterThan(secret);
    expect(iface).toBeGreaterThan(username);
    expect(routing).toBeGreaterThan(iface);
    expect(line).toBeGreaterThan(routing);
  });

  it('interfaces keep the chassis order', async () => {
    const router = await configuredRouter();
    const config = await router.executeCommand('show running-config');
    const order = config.split('\n')
      .filter((l) => /^interface /.test(l))
      .map((l) => l.replace('interface ', ''));
    expect(order).toEqual([...order].sort());
  });
});

describe('Secrets do not share their salt', () => {
  it('two distinct secrets carry two distinct salts', async () => {
    const router = await configuredRouter();
    const config = await router.executeCommand('show running-config');
    const salts = [...config.matchAll(/\$1\$([^$]+)\$/g)].map((m) => m[1]);
    expect(salts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(salts).size).toBe(salts.length);
  });
});

describe('show startup-config reads NVRAM', () => {
  it('its header announces usage, not Building configuration', async () => {
    const router = await configuredRouter();
    await router.executeCommand('write memory');
    const startup = await router.executeCommand('show startup-config');

    expect(startup).toMatch(/^Using \d+ out of 262136 bytes$/m);
    expect(startup).not.toContain('Building configuration');
    expect(startup).not.toMatch(/^Current configuration :/m);
  });

  it('show running-config keeps its own header', async () => {
    const router = await configuredRouter();
    const running = await router.executeCommand('show running-config');
    expect(running).toContain('Building configuration...');
    expect(running).toMatch(/^Current configuration : \d+ bytes$/m);
    expect(running).not.toMatch(/^Using \d+ out of/m);
  });

  it('with no save, NVRAM is empty', async () => {
    const router = new CiscoRouter('R1');
    await router.executeCommand('enable');
    expect(await router.executeCommand('show startup-config'))
      .toContain('startup-config is not present');
  });
});
