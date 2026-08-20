/**
 * `?` contextual help completeness on network equipment
 * (audit AUDIT-COHERENCE-CMD-PS-UX-HELP.md §4).
 *
 * A subcommand the handler actually accepts must be listed by `?`, with a
 * real description — never rendered as the bare keyword doubled
 * ("dhcp dhcp") and never hidden behind a generic WORD placeholder when
 * the dispatch keywords are known.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import type { Router } from '@/network/devices/Router';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function priv(): Router {
  const dev = createDevice('router-cisco') as Router;
  dev.executeCommand('enable');
  return dev;
}

const helpOf = (dev: Router, input: string): string =>
  (dev as unknown as { shell: { getHelp: (s: string, d: Router) => string } }).shell.getHelp(input, dev);

// ═══════════════════════════════════════════════════════════════════
// Delegated greedy handlers expose their real subcommands
// ═══════════════════════════════════════════════════════════════════

describe('show cdp ? lists the subcommands showCdp implements', () => {
  it('offers neighbors, entry, interface, traffic', () => {
    const help = helpOf(priv(), 'show cdp ');
    expect(help).toContain('neighbors');
    expect(help).toContain('entry');
    expect(help).toContain('interface');
    expect(help).toContain('traffic');
  });
});

describe('show lldp ? lists the subcommands showLldp implements', () => {
  it('offers neighbors and interface', () => {
    const help = helpOf(priv(), 'show lldp ');
    expect(help).toContain('neighbors');
    expect(help).toContain('interface');
  });
});

describe('show ntp ? lists both implemented subcommands', () => {
  it('offers status and associations', () => {
    const help = helpOf(priv(), 'show ntp ');
    expect(help).toContain('status');
    expect(help).toContain('associations');
  });
});

describe('show tcp ? lists brief', () => {
  it('offers brief', () => {
    const help = helpOf(priv(), 'show tcp ');
    expect(help).toContain('brief');
  });
});

describe('terminal ? lists the terminal parameters', () => {
  it('offers length, monitor and width', () => {
    const help = helpOf(priv(), 'terminal ');
    expect(help).toContain('length');
    expect(help).toContain('monitor');
    expect(help).toContain('width');
  });
});

// ═══════════════════════════════════════════════════════════════════
// No "keyword keyword" rendering — every listed keyword carries a
// description that is not just the keyword itself
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse "  kw   description" help lines into [keyword, description] pairs.
 */
function helpEntries(help: string): Array<[string, string]> {
  return help
    .split('\n')
    .map((l) => /^\s{2}(\S+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1], m[2].trim()]);
}

describe('help never renders a keyword as its own description', () => {
  for (const input of ['show ip ', 'clear ip ', 'crypto ', 'ip ']) {
    it(`"${input}?" has no doubled keyword entries`, () => {
      const dev = priv();
      if (input === 'crypto ' || input === 'ip ') {
        dev.executeCommand('configure terminal');
      }
      const help = helpOf(dev, input);
      for (const [kw, desc] of helpEntries(help)) {
        if (kw === '<cr>') continue;
        expect(desc, `keyword "${kw}" in "${input}?" is rendered as its own description`)
          .not.toBe(kw);
      }
    });
  }
});
