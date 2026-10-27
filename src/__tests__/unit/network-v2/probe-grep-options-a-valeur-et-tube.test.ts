/*
 * Sonde — `grep -A 3 motif` et `grep -A1 motif` derriere un tube.
 *
 * Mesure AVANT, sur `printf 'a\ntime exceeded x\nb\nc\nd\n' | grep -A 3 'time exceeded'` : rien (la valeur de -A comptait pour un
 * operande, donc grep se croyait pourvu d'un fichier et ne lisait pas le tube) ; avec `-A1` collé : la seule ligne trouvee, sans
 * contexte (le drapeau etait ignore). L'autorite est le grep GNU de la machine d'enregistrement : les sorties attendues ci-dessous
 * en sont copiees.
 *
 * SIX cas sur huit tombent avant la correction. Les deux autres sont NOMMES : le temoin `grep motif` sur un tube, et la
 * non-regression `grep motif fichier` qui lit bien le fichier et pas le tube.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

const INPUT = "printf 'a\\ntime exceeded x\\nb\\nc\\nd\\n'";

async function run(command: string): Promise<string> {
  const pc = new LinuxPC('linux-pc', 'A', 0, 0);
  return (await pc.executeCommand(command)).replace(/\n$/, '');
}

describe('grep : options a valeur et tube sur l\'entree', () => {
  it('temoin : grep motif sur un tube', async () => {
    expect(await run(`${INPUT} | grep exceeded`)).toBe('time exceeded x');
  });
  it('-A 3 motif lit le tube', async () => {
    expect(await run(`${INPUT} | grep -A 3 'time exceeded'`)).toBe('time exceeded x\nb\nc\nd');
  });
  it('-A1 colle donne une ligne de contexte', async () => {
    expect(await run(`${INPUT} | grep -A1 exceeded`)).toBe('time exceeded x\nb');
  });
  it('-B 1 motif', async () => {
    expect(await run(`${INPUT} | grep -B 1 exceeded`)).toBe('a\ntime exceeded x');
  });
  it('-C1 colle', async () => {
    expect(await run(`${INPUT} | grep -C1 exceeded`)).toBe('a\ntime exceeded x\nb');
  });
  it('-1 est le raccourci de -C 1', async () => {
    expect(await run(`${INPUT} | grep -1 exceeded`)).toBe('a\ntime exceeded x\nb');
  });
  it('-e motif -e motif lit le tube', async () => {
    expect(await run(`${INPUT} | grep -e a -e d`)).toBe('a\ntime exceeded x\nd');
  });
  it('non-regression : grep motif fichier lit le fichier et pas le tube', async () => {
    expect(await run(`printf 'zz\\n' > /tmp/f; ${INPUT} | grep zz /tmp/f`)).toBe('zz');
  });
});
