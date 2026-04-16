/**
 * TDD tests for LinuxCommand.options — declarative option specs with
 * auto-generated --help / man output and argument validation.
 *
 * Section 3 of the LinuxCommand enrichment.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { renderHelp, renderManPage } from '@/network/devices/linux/commands/LinuxCommandHelp';
import type { LinuxCommand } from '@/network/devices/linux/commands/LinuxCommand';
import { pingCommand } from '@/network/devices/linux/commands/net/Ping';
import { dhclientCommand } from '@/network/devices/linux/commands/dhcp/Dhclient';
import { arpCommand } from '@/network/devices/linux/commands/net/Arp';

// ═══════════════════════════════════════════════════════════════════
// Declarative options on LinuxCommand
// ═══════════════════════════════════════════════════════════════════

describe('LinuxCommand — declarative options', () => {
  it('ping declares its -c, -t, -W options', () => {
    expect(pingCommand.options).toBeDefined();
    const flags = (pingCommand.options ?? []).map(o => o.flag);
    expect(flags).toContain('-c');
    expect(flags).toContain('-t');
    expect(flags).toContain('-W');
  });

  it('dhclient declares its -v, -d, -r, -x, -w, -s, -t options', () => {
    expect(dhclientCommand.options).toBeDefined();
    const flags = (dhclientCommand.options ?? []).map(o => o.flag);
    expect(flags).toEqual(expect.arrayContaining(['-v', '-d', '-r', '-x', '-w', '-s', '-t']));
  });

  it('arp declares its -a, -d, -s, -i options', () => {
    expect(arpCommand.options).toBeDefined();
    const flags = (arpCommand.options ?? []).map(o => o.flag);
    expect(flags).toEqual(expect.arrayContaining(['-a', '-d', '-s', '-i']));
  });

  it('each option has a description', () => {
    const opts = pingCommand.options ?? [];
    for (const o of opts) {
      expect(o.description).toBeTruthy();
      expect(typeof o.description).toBe('string');
    }
  });

  it('options with arguments declare argName and takesArg', () => {
    const opts = pingCommand.options ?? [];
    const cOpt = opts.find(o => o.flag === '-c');
    expect(cOpt).toBeDefined();
    expect(cOpt!.takesArg).toBe(true);
    expect(cOpt!.argName).toBeTruthy();
  });

  it('boolean flags have takesArg=false', () => {
    const opts = dhclientCommand.options ?? [];
    const vOpt = opts.find(o => o.flag === '-v');
    expect(vOpt).toBeDefined();
    expect(vOpt!.takesArg).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// renderHelp / renderManPage helpers
// ═══════════════════════════════════════════════════════════════════

describe('renderHelp / renderManPage', () => {
  it('renderHelp includes Usage line', () => {
    const out = renderHelp(pingCommand);
    expect(out).toContain('Usage:');
    expect(out).toContain('ping');
  });

  it('renderHelp lists each option', () => {
    const out = renderHelp(pingCommand);
    expect(out).toContain('-c');
    expect(out).toContain('-t');
    expect(out).toContain('-W');
  });

  it('renderHelp includes option descriptions', () => {
    const out = renderHelp(pingCommand);
    expect(out).toMatch(/-c.*count/i);
  });

  it('renderManPage produces a man-style document', () => {
    const out = renderManPage(pingCommand);
    expect(out).toContain('PING(8)');
    expect(out).toContain('NAME');
    expect(out).toContain('SYNOPSIS');
    expect(out).toContain('DESCRIPTION');
  });

  it('renderManPage includes every option in the OPTIONS section', () => {
    const out = renderManPage(pingCommand);
    expect(out).toContain('OPTIONS');
    expect(out).toContain('-c');
    expect(out).toContain('-t');
  });

  it('renderHelp works for a command without options', () => {
    const dummy: LinuxCommand = {
      name: 'dummy',
      needsNetworkContext: false,
      usage: 'dummy <arg>',
      help: 'A dummy command.',
      run: () => '',
    };
    const out = renderHelp(dummy);
    expect(out).toContain('Usage:');
    expect(out).toContain('dummy');
  });
});

// ═══════════════════════════════════════════════════════════════════
// --help uses the auto-generated help text
// ═══════════════════════════════════════════════════════════════════

describe('auto-generated --help output', () => {
  let pc: LinuxPC;

  beforeEach(() => {
    pc = new LinuxPC('linux-pc', 'PC1');
  });

  it('ping --help lists the -c, -t, -W options', async () => {
    const out = await pc.executeCommand('ping --help');
    expect(out).toContain('-c');
    expect(out).toContain('-t');
    expect(out).toContain('-W');
  });

  it('dhclient --help lists the -v, -r, -x options', async () => {
    const out = await pc.executeCommand('dhclient --help');
    expect(out).toContain('-v');
    expect(out).toContain('-r');
    expect(out).toContain('-x');
  });

  it('man ping includes an OPTIONS section', async () => {
    const out = await pc.executeCommand('man ping');
    expect(out).toContain('OPTIONS');
    expect(out).toContain('-c');
  });
});
