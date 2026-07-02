import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

describe('Terminal layer no longer drives SSH through the legacy IShell shells', () => {
  it('LinuxTerminalSession does not reference CrossVendorRemoteShell', () => {
    const src = read('src/terminal/sessions/LinuxTerminalSession.ts');
    expect(src.includes('CrossVendorRemoteShell')).toBe(false);
  });

  it('WindowsTerminalSession does not reference CrossVendorRemoteShell', () => {
    const src = read('src/terminal/sessions/WindowsTerminalSession.ts');
    expect(src.includes('CrossVendorRemoteShell')).toBe(false);
  });

  it('WindowsTerminalSession does not push RemoteDeviceSubShell on ssh', () => {
    const src = read('src/terminal/sessions/WindowsTerminalSession.ts');
    expect(/new\s+RemoteDeviceSubShell\s*\(/.test(src)).toBe(false);
  });

  it('LinuxTerminalSession no longer exposes pushRemoteDeviceWithStrategy', () => {
    const src = read('src/terminal/sessions/LinuxTerminalSession.ts');
    expect(src.includes('pushRemoteDeviceWithStrategy')).toBe(false);
  });
});
