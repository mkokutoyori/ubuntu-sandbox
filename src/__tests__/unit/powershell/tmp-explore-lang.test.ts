import { it } from 'vitest';
import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
it('explore', async () => {
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  win.setCurrentUser('Administrator');
  const sub = PowerShellSubShell.create(win).subShell;
  writeFileSync('/tmp/lang_out.txt', '');
  const lines = readFileSync('/tmp/snips.txt', 'utf8').split('\n').filter(l => l.trim() !== '');
  for (const code of lines) {
    let out: string;
    try { out = (await sub.processLine(code)).output.join('\n'); } catch (e) { out = 'THROW ' + String(e); }
    appendFileSync('/tmp/lang_out.txt', `>>> ${code}\n${out}\n`);
  }
}, 300000);
