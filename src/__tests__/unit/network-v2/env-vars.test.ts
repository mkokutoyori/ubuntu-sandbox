/**
 * Environment-variable management — Linux + Windows enhancements.
 *
 * Covers:
 *   EV-01  Linux `printenv` (whole environment / specific names)
 *   EV-02  Linux login shells export the standard interactive variables
 *   EV-03  Windows PowerShell `$env:` is device-backed, never the host env
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════════
// EV-01 — Linux printenv
// ═══════════════════════════════════════════════════════════════════════

describe('EV-01 — Linux printenv', () => {
  it('prints the whole environment when given no arguments', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('printenv');
    expect(out).toMatch(/^PATH=/m);
    expect(out).toMatch(/^HOME=/m);
  });

  it('prints a single variable value with no name prefix', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('printenv SHELL');
    expect(out.trim()).toBe('/bin/bash');
  });

  it('reflects an exported variable', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('export MYTOKEN=abc123; printenv MYTOKEN');
    expect(out).toContain('abc123');
  });

  it('exits non-zero and prints nothing for an unset variable', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('printenv NOSUCHVAR');
    expect(out.trim()).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EV-02 — Linux standard interactive environment
// ═══════════════════════════════════════════════════════════════════════

describe('EV-02 — Linux login shell exports standard variables', () => {
  it('exposes HOSTNAME, TERM and MAIL', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('printenv');
    expect(out).toMatch(/^HOSTNAME=linux-pc$/m);
    expect(out).toMatch(/^TERM=/m);
    expect(out).toMatch(/^MAIL=\/var\/mail\//m);
  });

  it('$HOSTNAME expands to the configured hostname', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.setHostname('builder-01');
    const out = await pc.executeCommand('echo "host is $HOSTNAME"');
    expect(out).toContain('builder-01');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EV-03 — Windows PowerShell $env: is device-backed
// ═══════════════════════════════════════════════════════════════════════

describe('EV-03 — Windows $env: never leaks the Node host environment', () => {
  let hadProbe: string | undefined;
  beforeEach(() => {
    hadProbe = process.env.EV_HOST_LEAK_PROBE;
    process.env.EV_HOST_LEAK_PROBE = 'leaked-host-value';
  });
  afterEach(() => {
    if (hadProbe === undefined) delete process.env.EV_HOST_LEAK_PROBE;
    else process.env.EV_HOST_LEAK_PROBE = hadProbe;
  });

  async function ps(line: string): Promise<string> {
    const pc = new WindowsPC('windows-pc', 'WIN-EV');
    const { subShell } = PowerShellSubShell.create(pc);
    const r = await subShell.processLine(line);
    return typeof r === 'string' ? r : (r?.output ?? '');
  }

  it('an env var present only in the host process resolves to empty', async () => {
    const out = await ps('"value=[$env:EV_HOST_LEAK_PROBE]"');
    expect(out).toContain('value=[]');
    expect(out).not.toContain('leaked-host-value');
  });

  it('a device env var still resolves through the provider', async () => {
    const out = await ps('$env:COMPUTERNAME');
    expect(out).toContain('WIN-EV');
  });

  it('a value set via $env: is readable back from the device', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-EV');
    const { subShell } = PowerShellSubShell.create(pc);
    await subShell.processLine('$env:DEPLOY_STAGE = "prod"');
    const out = await subShell.processLine('"stage=$env:DEPLOY_STAGE"');
    const text = typeof out === 'string' ? out : (out?.output ?? '');
    expect(text).toContain('stage=prod');
  });
});
