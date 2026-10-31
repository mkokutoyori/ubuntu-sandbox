/**
 * bash 5.2 : « exec 3> f » et « exec 5< f » tiennent des descripteurs que /proc/$$/fd montre (3 -> chemin, 5 -> chemin) et « exec 3>&- » retire le 3 ; sorties relevées sur le bash réel de cette machine.
 * Mesure de départ : /proc/<pid>/fd du shell lancé par « bash -c » n'existait pas. les 4 cas tombent avant, le témoin compris, parce que /proc/<pid> du shell n'était pas encore matérialisé ; aucun ne passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('descripteurs ouverts par exec', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = new LinuxPC('linux-pc', 'PC1'); });
  const run = (script: string): Promise<string> => pc.executeCommand(`cd /tmp; bash -c '${script}'`);

  it('exec 3> apparaît dans /proc/$$/fd', async () => {
    const out = await run('exec 3> a.out; ls -l /proc/$$/fd');
    expect(out).toMatch(/ 3 -> \/tmp\/a\.out/);
  });
  it('exec 5< apparaît aussi', async () => {
    const out = await run('echo x > b.in; exec 5< b.in; ls -l /proc/$$/fd');
    expect(out).toMatch(/ 5 -> \/tmp\/b\.in/);
  });
  it('exec 3>&- le retire et laisse le 5', async () => {
    const out = await run('exec 3> a.out; exec 5< a.out; exec 3>&-; ls /proc/$$/fd | tr "\\n" " "');
    expect(out.trim()).toBe('0 1 2 5');
  });
  it('témoin : 0, 1 et 2 sont toujours là', async () => {
    const out = await run('ls /proc/$$/fd | tr "\\n" " "');
    expect(out.trim()).toMatch(/^0 1 2/);
  });
});
