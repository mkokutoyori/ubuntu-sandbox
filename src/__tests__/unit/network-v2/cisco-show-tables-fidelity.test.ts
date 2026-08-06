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

async function router(...setup: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  for (const c of setup) await r.executeCommand(c);
  return r;
}

describe('show line numbers its lines the way the chassis does', () => {
  it('the outbound access-class column is a letter O, not a zero', async () => {
    const r = await router();
    expect(String(await r.executeCommand('show line'))).toContain('AccO AccI');
  });

  it('console 0, auxiliary 1, then the virtual terminals', async () => {
    const r = await router();
    const rows = String(await r.executeCommand('show line')).split('\n').slice(1);
    expect(rows[0]).toContain('CTY');
    expect(rows[1]).toContain('AUX');
    expect(rows[2]).toContain('VTY');
    expect(rows[2].trimStart().startsWith('2')).toBe(true);
  });
});

describe('a standard access list names its wildcard', () => {
  it('show access-lists spells "wildcard bits", the configuration does not', async () => {
    const r = await router('configure terminal',
      'access-list 10 permit 192.168.10.0 0.0.0.255', 'end');

    expect(String(await r.executeCommand('show access-lists')))
      .toContain('permit 192.168.10.0, wildcard bits 0.0.0.255');
    expect(String(await r.executeCommand('show running-config')))
      .toContain('access-list 10 permit 192.168.10.0 0.0.0.255');
  });

  it('a counter that counted nothing is not printed', async () => {
    const r = await router('configure terminal',
      'access-list 10 permit any', 'end');
    expect(String(await r.executeCommand('show access-lists'))).not.toContain('(0 matches)');
  });
});

describe('a sequence number appears in the configuration only if it was typed', () => {
  it('an implicit one stays implicit', async () => {
    const r = await router('configure terminal', 'ip access-list standard NOMMEE',
      'permit 10.0.0.0 0.0.0.255', 'end');

    const cfg = String(await r.executeCommand('show running-config'));
    expect(cfg).toContain(' permit 10.0.0.0 0.0.0.255');
    expect(cfg).not.toContain(' 10 permit 10.0.0.0');
  });

  it('an explicit one is kept', async () => {
    const r = await router('configure terminal', 'ip access-list standard NOMMEE',
      '30 permit 10.1.0.0 0.0.0.255', 'end');
    expect(String(await r.executeCommand('show running-config')))
      .toContain(' 30 permit 10.1.0.0 0.0.0.255');
  });

  it('but show access-lists numbers every entry, typed or not', async () => {
    const r = await router('configure terminal', 'ip access-list standard NOMMEE',
      'permit 10.0.0.0 0.0.0.255', 'end');
    expect(String(await r.executeCommand('show access-lists')))
      .toContain('    10 permit 10.0.0.0, wildcard bits 0.0.0.255');
  });
});

describe('show ntp associations puts its legend where IOS puts it', () => {
  it('after the table, not before it', async () => {
    const r = await router('configure terminal', 'ntp server 10.0.0.9', 'end');
    const lines = String(await r.executeCommand('show ntp associations')).split('\n');

    expect(lines[0]).toContain('address');
    expect(lines.at(-1)).toContain('sys.peer');
    expect(lines.findIndex(l => l.includes('10.0.0.9')))
      .toBeLessThan(lines.length - 1);
  });

  it('an association that never answered is not a candidate', async () => {
    const r = await router('configure terminal', 'ntp server 10.0.0.9 prefer', 'end');
    const row = String(await r.executeCommand('show ntp associations'))
      .split('\n').find(l => l.includes('10.0.0.9')) ?? '';

    expect(row).toContain('000');
    expect(row.startsWith('+')).toBe(false);
  });
});

describe('show running-config interface announces a size', () => {
  it('its header counts bytes, it does not repeat the interface name', async () => {
    const r = await router('configure terminal', 'interface GigabitEthernet0/0',
      'ip address 192.168.10.1 255.255.255.0', 'end');
    const out = String(await r.executeCommand('show running-config interface GigabitEthernet0/0'));

    expect(out).toMatch(/Current configuration : \d+ bytes/);
    expect(out).not.toContain('Current configuration : interface');
  });
});

describe('the help of an access list describes what it accepts', () => {
  it('reload offers at, cancel and in', async () => {
    const r = await router();
    const help = r.cliHelp('reload ');
    for (const k of ['at', 'cancel', 'in']) expect(help).toContain(k);
  });

  it('permit tcp offers the source forms, each once', async () => {
    const r = await router('configure terminal', 'ip access-list extended EXT');
    const help = r.cliHelp('permit tcp ');

    for (const k of ['A.B.C.D', 'any', 'host', 'object-group']) expect(help).toContain(k);
    expect(help.split('\n').filter(l => l.trim().startsWith('any')).length).toBe(1);
  });

  it('eq offers a port range and the well-known names', async () => {
    const r = await router('configure terminal', 'ip access-list extended EXT');
    const help = r.cliHelp('permit tcp any any eq ');

    expect(help).toContain('<0-65535>');
    expect(help).toContain('www');
    expect(help).toContain('ftp');
  });
});
