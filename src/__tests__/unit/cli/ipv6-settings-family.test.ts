import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

type Cli = {
  cliHelp(input: string): string;
  executeCommand(line: string): Promise<string>;
  isIPv6RoutingEnabled(): boolean;
};

let serial = 0;

async function inGlobalConfig(): Promise<Cli> {
  const router = new CiscoRouter(`R${serial++}`) as unknown as Cli;
  await router.executeCommand('enable');
  await router.executeCommand('configure terminal');
  return router;
}

async function onInterface(): Promise<Cli> {
  const router = await inGlobalConfig();
  await router.executeCommand('interface GigabitEthernet0/0');
  return router;
}

function offeredKeywords(help: string): string[] {
  return help.split('\n')
    .map(line => /^\s\s(\S+)/.exec(line)?.[1])
    .filter((word): word is string => word !== undefined);
}

describe('`no ipv6 unicast-routing` stops the routing it names', () => {
  it('the positive form starts it — the witness', async () => {
    const router = await inGlobalConfig();
    await router.executeCommand('ipv6 unicast-routing');

    expect(router.isIPv6RoutingEnabled()).toBe(true);
  });

  it('and the negation really stops it, instead of noting it elsewhere', async () => {
    const router = await inGlobalConfig();
    await router.executeCommand('ipv6 unicast-routing');
    await router.executeCommand('no ipv6 unicast-routing');

    expect(router.isIPv6RoutingEnabled()).toBe(false);
  });

  it('the rendered configuration carries it, so a reload keeps routing', async () => {
    const router = await inGlobalConfig();
    await router.executeCommand('ipv6 unicast-routing');

    expect(await router.executeCommand('do show running-config'))
      .toContain('ipv6 unicast-routing');
  });
});

describe('`ipv6 mtu` enforces the bound its help announces', () => {
  it('below the IPv6 minimum of 1280 the value is refused where it was typed', async () => {
    const router = await onInterface();

    expect(await router.executeCommand('ipv6 mtu 99')).toContain('Invalid input');
    expect(await router.executeCommand('ipv6 mtu 1279')).toContain('Invalid input');
  });

  it('a legal value is accepted and rendered', async () => {
    const router = await onInterface();

    expect(await router.executeCommand('ipv6 mtu 1500')).toBe('');
    expect(await router.executeCommand('do show running-config')).toContain('ipv6 mtu 1500');
  });

  it('`no ipv6 mtu` needs no value and removes the line', async () => {
    const router = await onInterface();
    await router.executeCommand('ipv6 mtu 1500');

    expect(await router.executeCommand('no ipv6 mtu')).toBe('');
    expect(await router.executeCommand('do show running-config')).not.toContain('ipv6 mtu');
  });

  it('and `?` announces the same bound the machine applies', async () => {
    const router = await onInterface();

    expect(offeredKeywords(router.cliHelp('ipv6 mtu '))).toEqual(['<1280-9216>']);
  });
});

describe('`ipv6 traffic-filter` reads the direction it is given', () => {
  it('a direction that is not one is refused, not replaced by `in`', async () => {
    const router = await onInterface();

    expect(await router.executeCommand('ipv6 traffic-filter FOO zorglub'))
      .toContain('Invalid input');
    expect(await router.executeCommand('do show running-config'))
      .not.toContain('ipv6 traffic-filter');
  });

  it('`out` stays `out` in the configuration', async () => {
    const router = await onInterface();
    await router.executeCommand('ipv6 traffic-filter FOO out');

    expect(await router.executeCommand('do show running-config'))
      .toContain('ipv6 traffic-filter FOO out');
  });

  it('`?` names the two directions after the list', async () => {
    const router = await onInterface();

    expect(offeredKeywords(router.cliHelp('ipv6 traffic-filter FOO '))).toEqual(['in', 'out']);
  });

  it('`no ipv6 traffic-filter` removes it without naming the list again', async () => {
    const router = await onInterface();
    await router.executeCommand('ipv6 traffic-filter FOO out');

    expect(await router.executeCommand('no ipv6 traffic-filter')).toBe('');
    expect(await router.executeCommand('do show running-config'))
      .not.toContain('ipv6 traffic-filter');
  });
});

describe('a flag takes no argument, and says so', () => {
  it('`ipv6 cef zorglub` is refused rather than swallowed', async () => {
    const router = await inGlobalConfig();

    expect(await router.executeCommand('ipv6 cef zorglub')).toContain('Invalid input');
    expect(await router.executeCommand('ipv6 cef')).toBe('');
  });

  it('`ipv6 enable` survives its own negation when an address holds it', async () => {
    const router = await onInterface();
    await router.executeCommand('ipv6 address 2001:db8::1/64');

    await router.executeCommand('no ipv6 enable');

    expect(await router.executeCommand('do show running-config'))
      .toContain('ipv6 address 2001:db8::1/64');
  });
});
