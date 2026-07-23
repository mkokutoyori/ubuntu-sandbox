/**
 * Typed-vs-scripted dispatch parity for curl/ifconfig/tcpdump —
 * audit 05, constat A8 (CRITIQUE, "double dispatch").
 *
 * `LinuxCommandExecutor` has two independent ways to run a network
 * command: the async `networkRunner` bridge (used when a command is
 * typed directly, or appears with shell composition at the top level)
 * always calls the registry implementation; the synchronous switch in
 * `dispatch()` — reached whenever a script file is executed via
 * `bash script.sh`/`sh script.sh`, since that nested path never goes
 * through the async pipeline — used to have its own explicit
 * `case 'curl'`/`case 'ifconfig'`/`case 'tcpdump'` calling a second,
 * independently-drifted legacy implementation. For curl and ifconfig
 * that legacy path ignored the real topology / silently no-op'd on
 * arguments; removing those two `case`s lets the switch's own
 * `default:` branch (`_registryCommandHook`) reach the same registry
 * command that the typed path already used — one implementation,
 * both call sites.
 *
 * `tcpdump`'s registry implementation is genuinely asynchronous (real
 * capture-window delays), so it cannot be served by the synchronous
 * `_registryCommandHook` — its switch `case` is intentionally kept to
 * avoid turning a working (if divergently-worded) scripted `tcpdump`
 * into "command not found". Its only fixed divergence is the banner
 * wording bug identified by the audit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('curl: typed vs scripted must agree (real topology, no hardcoded host)', () => {
  it('a scripted curl to an unresolvable target matches the typed error exactly', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);

    const typed = await pc1.executeCommand('curl http://10.0.0.99/');

    await pc1.executeCommand(
      `bash -c 'echo "curl http://10.0.0.99/" > /tmp/__dispatch_test.sh'`,
    );
    const scripted = await pc1.executeCommand('bash /tmp/__dispatch_test.sh');

    expect(scripted.trim()).toBe(typed.trim());
    // The legacy switch path hardcoded this message regardless of the
    // real topology; a real dial against an unreachable/refusing peer
    // must not say that.
    expect(scripted).not.toContain('(6) Could not resolve host');
  });
});

describe('ifconfig: scripted assignment must actually configure the interface', () => {
  it('a scripted "ifconfig eth0 <ip> netmask <mask>" takes effect', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);

    await pc1.executeCommand(
      `bash -c 'echo "ifconfig eth0 192.168.70.5 netmask 255.255.255.0" > /tmp/__dispatch_test.sh'`,
    );
    await pc1.executeCommand('bash /tmp/__dispatch_test.sh');

    const status = await pc1.executeCommand('ifconfig eth0');
    expect(status).toContain('192.168.70.5');
  });

  it('typed and scripted assignment produce the same resulting interface state', async () => {
    const pcTyped = new LinuxPC('PCT', 0, 0);
    const pcScripted = new LinuxPC('PCS', 100, 0);

    await pcTyped.executeCommand('ifconfig eth0 192.168.80.9 netmask 255.255.255.0');
    await pcScripted.executeCommand(
      `bash -c 'echo "ifconfig eth0 192.168.80.9 netmask 255.255.255.0" > /tmp/__dispatch_test.sh'`,
    );
    await pcScripted.executeCommand('bash /tmp/__dispatch_test.sh');

    const typedStatus = await pcTyped.executeCommand('ifconfig eth0');
    const scriptedStatus = await pcScripted.executeCommand('ifconfig eth0');
    const addrLine = (s: string) => s.split('\n').find(l => l.includes('inet '))?.trim();
    expect(addrLine(scriptedStatus)).toBe(addrLine(typedStatus));
    expect(scriptedStatus).toContain('192.168.80.9');
  });
});

describe('tcpdump: scripted invocation keeps working and uses conformant wording', () => {
  it('does not regress into "command not found" when run from a script', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    await pc1.executeCommand(
      `bash -c 'echo "tcpdump -c 1 -i eth0" > /tmp/__dispatch_test.sh'`,
    );
    const out = await pc1.executeCommand('bash /tmp/__dispatch_test.sh');
    expect(out).not.toContain('command not found');
  });

  it('the banner says "snapshot length", matching real tcpdump, whether typed or scripted', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);

    const typed = await pc1.executeCommand('tcpdump -c 1 -i eth0');
    expect(typed).toContain('snapshot length');
    expect(typed).not.toContain('capture size');

    await pc1.executeCommand(
      `bash -c 'echo "tcpdump -c 1 -i eth0" > /tmp/__dispatch_test.sh'`,
    );
    const scripted = await pc1.executeCommand('bash /tmp/__dispatch_test.sh');
    expect(scripted).toContain('snapshot length');
    expect(scripted).not.toContain('capture size');
  });
});
