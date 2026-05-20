/**
 * Unit tests — Phase G Windows commands.
 *
 * net use ↔ LanmanWorkstation, net share ↔ LanmanServer,
 * schtasks ↔ Schedule, print ↔ Spooler. All four were previously
 * either stubbed or ungated.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';

describe('Phase G — net use / net share / schtasks / print', () => {
  let pc: WindowsPC;

  beforeEach(() => {
    pc = new WindowsPC('windows-pc', 'win-pc', 0, 0);
    pc.setCurrentUser('Administrator');
  });

  // ─── net use ───────────────────────────────────────────────────────

  it('net use lists current mappings (header even when empty)', async () => {
    const out = await pc.executeCommand('net use');
    expect(out).toContain('Status');
    expect(out).toContain('Local');
    expect(out).toContain('Remote');
  });

  it('net use Z: \\\\server\\share — adds a mapping', async () => {
    const add = await pc.executeCommand('net use Z: \\\\server\\share');
    expect(add).toContain('command completed successfully');
    const list = await pc.executeCommand('net use');
    expect(list).toContain('Z:');
    expect(list).toContain('\\\\server\\share');
  });

  it('net use Z: /delete — removes the mapping', async () => {
    await pc.executeCommand('net use Z: \\\\server\\share');
    const del = await pc.executeCommand('net use Z: /delete');
    expect(del).toMatch(/deleted successfully|removed/i);
    expect(await pc.executeCommand('net use')).not.toContain('Z:');
  });

  it('refuses every form when LanmanWorkstation is stopped', async () => {
    await pc.executeCommand('net stop LanmanWorkstation');
    const list = await pc.executeCommand('net use');
    expect(list).toMatch(/Workstation service has not been started/i);
    const add = await pc.executeCommand('net use Z: \\\\server\\share');
    expect(add).toMatch(/Workstation service has not been started/i);
  });

  // ─── net share ─────────────────────────────────────────────────────

  it('net share lists default shares (ADMIN$, C$, IPC$)', async () => {
    const out = await pc.executeCommand('net share');
    expect(out).toContain('ADMIN$');
    expect(out).toContain('C$');
    expect(out).toContain('IPC$');
  });

  it('net share Docs=C:\\Users — adds a share', async () => {
    const add = await pc.executeCommand('net share Docs=C:\\Users');
    expect(add).toMatch(/shared successfully|Docs was shared/i);
    expect(await pc.executeCommand('net share')).toContain('Docs');
  });

  it('net share Docs /delete — removes a share', async () => {
    await pc.executeCommand('net share Docs=C:\\Users');
    const del = await pc.executeCommand('net share Docs /delete');
    expect(del).toMatch(/was deleted successfully/i);
    expect(await pc.executeCommand('net share')).not.toMatch(/\bDocs\b/);
  });

  it('refuses when LanmanServer is stopped', async () => {
    await pc.executeCommand('net stop LanmanServer');
    expect(await pc.executeCommand('net share')).toMatch(/Server service is not started/i);
  });

  // ─── schtasks ↔ Schedule ────────────────────────────────────────────

  it('schtasks /query refuses when Schedule is stopped', async () => {
    await pc.executeCommand('net stop Schedule');
    const out = await pc.executeCommand('schtasks /query');
    expect(out).toMatch(/Task Scheduler service is not running/i);
  });

  it('schtasks /query works when Schedule is running', async () => {
    const out = await pc.executeCommand('schtasks /query');
    expect(out).toMatch(/TaskName|Folder/i);
  });

  // ─── print ↔ Spooler ────────────────────────────────────────────────

  it('print refuses when Spooler is stopped', async () => {
    await pc.executeCommand('net stop Spooler');
    const out = await pc.executeCommand('print C:\\Users\\test.txt');
    expect(out).toMatch(/Print Spooler service is not running/i);
  });

  it('print queues a document when Spooler is running', async () => {
    const out = await pc.executeCommand('print C:\\Users\\test.txt');
    expect(out).toMatch(/printed|queued/i);
  });
});
