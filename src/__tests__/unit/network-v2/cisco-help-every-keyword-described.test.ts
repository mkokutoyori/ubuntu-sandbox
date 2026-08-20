import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cli {
  executeCommand(c: string): Promise<string> | string;
  cliHelp(s: string): string;
}

function entries(help: string): Array<{ keyword: string; description: string }> {
  return help.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.search(/\s{2,}/);
    return i < 0
      ? { keyword: l, description: '' }
      : { keyword: l.slice(0, i), description: l.slice(i).trim() };
  });
}

const IS_ARGUMENT = /^[<A-Z]/;
const DEPTH = 3;

async function undescribed(dev: Cli, mode: string[]): Promise<string[]> {
  const found: string[] = [];
  const visit = async (prefix: string, left: number): Promise<void> => {
    if (left === 0) return;
    await dev.executeCommand('end');
    for (const c of mode) await dev.executeCommand(c);
    const help = dev.cliHelp(prefix);
    if (help.includes('Invalid input') || help.includes('Ambiguous') || help.trim() === '') return;
    for (const e of entries(help)) {
      if (e.keyword === '<cr>' || e.keyword.startsWith('%') || IS_ARGUMENT.test(e.keyword)) continue;
      if (e.description === '') found.push(`${prefix}${e.keyword}`);
      await visit(`${prefix}${e.keyword} `, left - 1);
    }
  };
  await visit('', DEPTH);
  return found;
}

const ROUTER_MODES: Array<[string, string[]]> = [
  ['privileged EXEC', []],
  ['global config', ['configure terminal']],
  ['config-if', ['configure terminal', 'interface GigabitEthernet0/0']],
  ['config-line', ['configure terminal', 'line vty 0 4']],
  ['config-router (RIP)', ['configure terminal', 'router rip']],
  ['config-router (OSPF)', ['configure terminal', 'router ospf 1']],
  ['config-dhcp', ['configure terminal', 'ip dhcp pool P']],
  ['standard named ACL', ['configure terminal', 'ip access-list standard S']],
  ['extended named ACL', ['configure terminal', 'ip access-list extended E']],
];

const SWITCH_MODES: Array<[string, string[]]> = [
  ['global config', ['configure terminal']],
  ['config-if', ['configure terminal', 'interface FastEthernet0/1']],
  ['config-vlan', ['configure terminal', 'vlan 10']],
];

describe('every keyword ? offers on a Cisco router carries a description', () => {
  for (const [label, mode] of ROUTER_MODES) {
    it(label, async () => {
      const r = new CiscoRouter('R1') as unknown as Cli;
      await r.executeCommand('enable');
      expect(await undescribed(r, mode)).toEqual([]);
    }, 60000);
  }
});

describe('and the same holds on a Cisco switch', () => {
  for (const [label, mode] of SWITCH_MODES) {
    it(label, async () => {
      const sw = new CiscoSwitch('switch-cisco', 'SW1', 8) as unknown as Cli;
      await sw.executeCommand('enable');
      expect(await undescribed(sw, mode)).toEqual([]);
    }, 60000);
  }
});

describe('a description is a description, not the keyword repeated', () => {
  it('no entry describes itself', async () => {
    const r = new CiscoRouter('R1') as unknown as Cli;
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');

    const doubles = entries(r.cliHelp(''))
      .filter(e => e.keyword.toLowerCase() === e.description.toLowerCase())
      .map(e => e.keyword);
    expect(doubles).toEqual([]);
  });
});
