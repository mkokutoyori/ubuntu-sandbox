import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CiscoTerminalSession } from '@/terminal/sessions';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); EquipmentRegistry.resetInstance(); Logger.clear(); });
const k = (key: string): KeyEvent => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const tick = () => new Promise<void>((r) => setTimeout(r, 15));
async function t(s: CiscoTerminalSession, c: string) { s.setInput(c); s.handleKey(k('Enter')); await tick(); }
async function txt(s: CiscoTerminalSession, v: string) { s.setInputBuf(v); s.handleKey(k('Enter')); await tick(); }
async function pw(s: CiscoTerminalSession, v: string) { s.setPasswordBuf(v); s.handleKey(k('Enter')); await tick(); }
async function dire(s: CiscoTerminalSession, c: string) {
  const a = s.lines.length; await t(s, c);
  return s.lines.slice(a).map(l => l.text).join(' | ');
}
describe('p', () => {
  it('x', async () => {
    const d = new CiscoRouter('Router1', 0, 0); d.powerOn();
    const s = new CiscoTerminalSession('t1', d);
    await s.init();
    for (let i = 0; i < 40; i++) { if (!s.isBooting) break; await tick(); }
    for (const c of ['enable', 'configure terminal',
      'username mandeng privilege 1 secret x', 'line console 0', 'login local', 'end']) await t(s, c);
    await t(s, 'exit'); await t(s, '');
    await txt(s, 'mandeng'); await pw(s, 'x');
    console.log('APRES LOGIN =', JSON.stringify(s.getPrompt()));
    console.log('ENABLE =', await dire(s, 'enable'));
    console.log('PROMPT =', JSON.stringify(s.getPrompt()));
    console.log('SHOW PRIV =', await dire(s, 'show privilege'));
    expect(1).toBe(1);
  }, 30000);
});
