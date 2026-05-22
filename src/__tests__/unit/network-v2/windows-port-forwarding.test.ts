/**
 * Windows port forwarding — `netsh interface portproxy`.
 *
 * Covers:
 *   PP-01  add / show a v4tov4 rule
 *   PP-02  the rule's listener surfaces in `netstat` (reactive coherence)
 *   PP-03  delete removes the rule and its socket
 *   PP-04  reset clears every rule
 *   PP-05  show v4tov4 / address-family sections
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════════
// PP-01 — add / show
// ═══════════════════════════════════════════════════════════════════════

describe('PP-01 — netsh interface portproxy add / show', () => {
  it('an added v4tov4 rule appears in `show all`', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    await pc.executeCommand(
      'netsh interface portproxy add v4tov4 listenport=8080 connectport=80 connectaddress=10.0.0.5',
    );
    const out = await pc.executeCommand('netsh interface portproxy show all');
    expect(out).toMatch(/Listen on ipv4/);
    expect(out).toMatch(/0\.0\.0\.0\s+8080\s+10\.0\.0\.5\s+80/);
  });

  it('listenaddress is honoured when supplied', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    await pc.executeCommand(
      'netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=9000 connectport=22 connectaddress=10.0.0.9',
    );
    const out = await pc.executeCommand('netsh interface portproxy show all');
    expect(out).toMatch(/127\.0\.0\.1\s+9000\s+10\.0\.0\.9\s+22/);
  });

  it('a missing listenport is rejected', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    const out = await pc.executeCommand(
      'netsh interface portproxy add v4tov4 connectport=80 connectaddress=10.0.0.5',
    );
    expect(out).toMatch(/parameter is incorrect/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PP-02 — socket-table coherence
// ═══════════════════════════════════════════════════════════════════════

describe('PP-02 — portproxy listener surfaces in netstat', () => {
  it('the listen port shows as LISTENING after add', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    await pc.executeCommand(
      'netsh interface portproxy add v4tov4 listenport=8080 connectport=80 connectaddress=10.0.0.5',
    );
    const out = await pc.executeCommand('netstat -an');
    expect(out).toMatch(/0\.0\.0\.0:8080\s+0\.0\.0\.0:0\s+LISTENING/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PP-03 / PP-04 — delete and reset
// ═══════════════════════════════════════════════════════════════════════

describe('PP-03 — delete removes the rule and its socket', () => {
  it('delete drops the rule from `show` and the port from `netstat`', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    await pc.executeCommand(
      'netsh interface portproxy add v4tov4 listenport=8080 connectport=80 connectaddress=10.0.0.5',
    );
    await pc.executeCommand('netsh interface portproxy delete v4tov4 listenport=8080');
    const show = await pc.executeCommand('netsh interface portproxy show all');
    expect(show.trim()).toBe('');
    const netstat = await pc.executeCommand('netstat -an');
    expect(netstat).not.toMatch(/0\.0\.0\.0:8080\s/);
  });

  it('deleting an unknown rule reports it cannot be found', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    const out = await pc.executeCommand('netsh interface portproxy delete v4tov4 listenport=1234');
    expect(out).toMatch(/cannot find/i);
  });
});

describe('PP-04 — reset clears every rule', () => {
  it('reset empties the table', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    await pc.executeCommand('netsh interface portproxy add v4tov4 listenport=8080 connectport=80 connectaddress=10.0.0.5');
    await pc.executeCommand('netsh interface portproxy add v4tov4 listenport=9090 connectport=90 connectaddress=10.0.0.6');
    await pc.executeCommand('netsh interface portproxy reset');
    const out = await pc.executeCommand('netsh interface portproxy show all');
    expect(out.trim()).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PP-05 — per-family show
// ═══════════════════════════════════════════════════════════════════════

describe('PP-05 — show by address family', () => {
  it('show v4tov4 lists only v4tov4 rules', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    await pc.executeCommand('netsh interface portproxy add v4tov4 listenport=8080 connectport=80 connectaddress=10.0.0.5');
    const out = await pc.executeCommand('netsh interface portproxy show v4tov4');
    expect(out).toMatch(/Listen on ipv4/);
    expect(out).toMatch(/8080/);
  });
});
