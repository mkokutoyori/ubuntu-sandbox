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

describe('an enumerated argument renders as its values, not as one literal', () => {
  it('speed ? offers the four real speeds, each described', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    const listed = entries(r.cliHelp('speed ')).filter(e => e.keyword !== '<cr>');
    expect(listed.map(e => e.keyword)).toEqual(['10', '100', '1000', 'auto']);
    expect(listed.every(e => e.description.length > 0)).toBe(true);
  });

  it('duplex ? offers auto, full and half', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    expect(keywords(r.cliHelp('duplex ')).filter(k => k !== '<cr>'))
      .toEqual(['auto', 'full', 'half']);
  });

  it('a partial value narrows the list', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    expect(keywords(r.cliHelp('speed 1'))).toEqual(['10', '100', '1000']);
  });

  it('Tab completes an enumerated value', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    expect(r.cliTabCandidates('speed 1')).toEqual(['speed 10', 'speed 100', 'speed 1000']);
  });

  it('and the values still execute', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/1');
    expect(await r.executeCommand('speed 100')).toBe('');
    expect(await r.executeCommand('speed auto')).toBe('');
    expect(await r.executeCommand('duplex full')).toBe('');
  });
});

describe('every keyword offered by ? carries a description', () => {
  const cases: Array<[string[], string]> = [
    [['configure terminal'], 'ip nat '],
    [['configure terminal'], 'ip dhcp '],
    [['configure terminal'], 'logging '],
    [['configure terminal', 'interface GigabitEthernet0/1'], 'encapsulation '],
    [['configure terminal', 'interface GigabitEthernet0/1'], 'speed '],
    [['configure terminal', 'interface GigabitEthernet0/1'], 'duplex '],
  ];

  for (const [setup, query] of cases) {
    it(`${query.trim()} ?`, async () => {
      const r = await router(...setup);
      const undescribed = entries(r.cliHelp(query))
        .filter(e => e.keyword !== '<cr>' && e.description.length === 0)
        .map(e => e.keyword);
      expect(undescribed).toEqual([]);
    });
  }
});

describe('? shows <cr> exactly when the command is executable as typed', () => {
  const cases: Array<{ setup: string[]; command: string; executable: boolean }> = [
    { setup: [], command: 'ip route', executable: false },
    { setup: [], command: 'router ospf', executable: false },
    { setup: [], command: 'interface', executable: false },
    { setup: [], command: 'ip dhcp pool', executable: false },
    { setup: [], command: 'enable secret', executable: false },
    { setup: [], command: 'access-list 10', executable: false },
    { setup: [], command: 'ip dhcp excluded-address', executable: false },
    { setup: [], command: 'logging', executable: false },
    { setup: [], command: 'ntp server', executable: false },
    { setup: [], command: 'snmp-server community', executable: false },
    { setup: [], command: 'ip ssh time-out', executable: false },
    { setup: ['interface GigabitEthernet0/1'], command: 'ip address', executable: false },
    { setup: ['interface GigabitEthernet0/1'], command: 'mtu', executable: false },
    { setup: ['interface GigabitEthernet0/1'], command: 'bandwidth', executable: false },
    { setup: ['interface GigabitEthernet0/1'], command: 'description', executable: false },
    { setup: ['interface GigabitEthernet0/1'], command: 'speed', executable: false },
    { setup: ['interface GigabitEthernet0/1'], command: 'duplex', executable: false },
    { setup: ['interface GigabitEthernet0/1'], command: 'encapsulation', executable: false },
    { setup: ['interface GigabitEthernet0/1'], command: 'encapsulation dot1q', executable: false },
    { setup: ['interface GigabitEthernet0/1'], command: 'shutdown', executable: true },
    { setup: ['interface GigabitEthernet0/1'], command: 'no shutdown', executable: true },
    { setup: ['router ospf 1'], command: 'router-id', executable: false },
    { setup: ['router ospf 1'], command: 'network', executable: false },
    { setup: ['ip dhcp pool P1'], command: 'lease', executable: false },
    { setup: ['ip dhcp pool P1'], command: 'network', executable: false },
  ];

  for (const { setup, command, executable } of cases) {
    it(`${setup[0] ?? 'config'} → ${command}`, async () => {
      const help = await router('configure terminal', ...setup)
        .then(r => r.cliHelp(`${command} `));
      const outcome = await router('configure terminal', ...setup)
        .then(r => r.executeCommand(command));

      expect(help.includes('<cr>')).toBe(executable);
      expect(String(outcome ?? '').includes('% Incomplete command.')).toBe(!executable);
    });
  }
});

describe('every view reports the same interface state', () => {
  const IF = 'GigabitEthernet0/1';

  async function views(r: Router): Promise<Record<string, string>> {
    const line = (out: string, needle: string): string =>
      out.split('\n').find(l => l.includes(needle)) ?? '';
    return {
      brief: line(String(await r.executeCommand('show ip interface brief')), IF),
      description: line(String(await r.executeCommand('show interfaces description')), IF),
      interfaces: String(await r.executeCommand(`show interfaces ${IF}`)).split('\n')[0],
      controllers: String(await r.executeCommand('show controllers'))
        .split(`${IF} -`)[1]?.split('\n')[2] ?? '',
    };
  }

  it('an interface never brought up reads administratively down everywhere', async () => {
    const r = await router('configure terminal', `interface ${IF}`, 'shutdown', 'end');
    const v = await views(r);

    expect(v.brief).toContain('administratively down');
    expect(v.brief.trim().endsWith('down')).toBe(true);
    expect(v.description).toContain('admin down');
    expect(v.interfaces).toContain(`${IF} is administratively down, line protocol is down`);
    expect(v.controllers).toContain('Administrative state: administratively down');
  });

  it('an uncabled interface reads down, never administratively down', async () => {
    const r = await router('configure terminal', `interface ${IF}`, 'no shutdown', 'end');
    const v = await views(r);

    expect(v.brief).toContain('down');
    expect(v.brief).not.toContain('administratively');
    expect(v.description).not.toContain('admin down');
    expect(v.interfaces).toContain(`${IF} is down, line protocol is down`);
    expect(v.controllers).toContain('Administrative state: up');
  });

  it('the routing table follows the interfaces, not its own rule', async () => {
    const r = await router(
      'configure terminal', `interface ${IF}`,
      'ip address 10.9.9.1 255.255.255.0', 'no shutdown', 'end',
    );
    const brief = String(await r.executeCommand('show ip interface brief'));
    const route = String(await r.executeCommand('show ip route'));

    const ifaceUp = !/GigabitEthernet0\/1\s+\S+\s+YES\s+\S+\s+up/.test(brief);
    expect(ifaceUp).toBe(true);
    expect(route).not.toContain('10.9.9.0/24 is directly connected');
    expect(route).not.toContain('10.9.9.1/32 is directly connected');
  });

  it('a loopback is up in every view without any cable', async () => {
    const r = await router(
      'configure terminal', 'interface Loopback0',
      'ip address 1.1.1.1 255.255.255.255', 'end',
    );
    const brief = String(await r.executeCommand('show ip interface brief'));
    const loop = brief.split('\n').find(l => l.includes('Loopback0')) ?? '';

    expect(loop).toContain('up');
    expect(loop).not.toContain('administratively');
    expect(String(await r.executeCommand('show controllers'))).not.toContain('Loopback0');
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
