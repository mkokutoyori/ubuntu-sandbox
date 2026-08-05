import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import type { Router } from '@/network/devices/Router';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function router(...setup: string[]): Promise<Router> {
  const r = createDevice('router-cisco') as Router;
  await r.executeCommand('enable');
  for (const c of setup) await r.executeCommand(c);
  return r;
}

const entries = (help: string): Array<{ keyword: string; description: string }> =>
  help.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => {
      const idx = l.search(/\s{2,}/);
      return idx < 0
        ? { keyword: l, description: '' }
        : { keyword: l.slice(0, idx), description: l.slice(idx).trim() };
    });

const keywords = (help: string): string[] => entries(help).map(e => e.keyword);

describe('describeArgs no longer hides the keyword it describes', () => {
  it('encapsulation ? lists dot1q, which the handler accepts', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    expect(keywords(r.cliHelp('encapsulation '))).toContain('dot1q');
  });

  it('dot1q keeps a real description', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    const dot1q = entries(r.cliHelp('encapsulation ')).find(e => e.keyword === 'dot1q');
    expect(dot1q?.description).toBe('IEEE 802.1Q Virtual LAN');
  });

  it('prefix help reaches it too', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    expect(keywords(r.cliHelp('encapsulation dot'))).toEqual(['dot1q']);
  });

  it('Tab completes it', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    expect(r.cliTabCandidates('encapsulation dot')).toContain('encapsulation dot1q');
  });

  it('its own argument is still described', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    expect(keywords(r.cliHelp('encapsulation dot1q '))).toEqual(['<1-4094>']);
  });

  it('and executing it still goes through the greedy parent', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    expect(await r.executeCommand('encapsulation dot1q 100')).toBe('');
  });
});

describe('? describes the grammar, never the live device', () => {
  const liveValueCases: Array<[string[], string]> = [
    [['configure terminal'], 'ip route '],
    [['configure terminal'], 'ip dhcp excluded-address '],
    [['configure terminal'], 'ntp server '],
    [['configure terminal'], 'ip name-server '],
    [['configure terminal', 'interface GigabitEthernet0/1'], 'ip address '],
    [['configure terminal', 'router ospf 1'], 'router-id '],
  ];

  for (const [setup, query] of liveValueCases) {
    it(`${query.trim()} ? offers A.B.C.D, not a configured address`, async () => {
      const r = await router('configure terminal', 'interface GigabitEthernet0/0',
        'ip address 10.0.0.1 255.255.255.0', 'end', ...setup);
      const help = r.cliHelp(query);
      expect(keywords(help)).toContain('A.B.C.D');
      expect(help).not.toContain('10.0.0.1');
    });
  }

  it('interface ? lists types, not the ports of this chassis', async () => {
    const r = await router('configure terminal');
    const help = r.cliHelp('interface ');
    expect(keywords(help)).toContain('GigabitEthernet');
    expect(help).not.toContain('GigabitEthernet0/0');
  });

  it('Tab keeps knowing the ports', async () => {
    const r = await router('configure terminal');
    expect(r.cliTabCandidates('interface GigabitEthernet0/'))
      .toContain('interface GigabitEthernet0/0');
  });
});

describe('an argument declared on the wrong trie is not declared', () => {
  it('network ? under router ospf offers the network number', async () => {
    const r = await router('configure terminal', 'router ospf 1');
    expect(keywords(r.cliHelp('network '))).toContain('A.B.C.D');
  });

  it('and still offers area once the address and wildcard are given', async () => {
    const r = await router('configure terminal', 'router ospf 1');
    expect(keywords(r.cliHelp('network 10.0.0.0 0.0.0.255 '))).toContain('area');
  });
});
