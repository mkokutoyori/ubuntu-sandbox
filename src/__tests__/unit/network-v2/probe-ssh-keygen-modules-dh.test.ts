/*
 * `ssh-keygen -M generate|screen` : fabrication des modules Diffie-Hellman
 * (/etc/ssh/moduli), Linux et Windows.
 *
 * L'AUTORITE : OpenSSH 8.9p1, `ssh-keygen.c` (do_moduli_gen, do_moduli_screen)
 * et `moduli.c` (gen_candidates, sieve_large, prime_test, qfileout) :
 * - generation : options memory= (8..127 Mo), start= (hexa), bits= (512..65536,
 *   3072 par defaut) ; erreurs « Too few bits: 100 < 512 », « Invalid memory
 *   amount (min 8, max 127) », « Option "x" is unsupported for moduli
 *   generation », puis « modulus candidate generation failed » ; le crible
 *   (TinySieve, SmallSieve, sieve_large) ecarte les q et les p = 2q + 1 qui ont
 *   un petit facteur ; chaque survivant est ecrit « AAAAMMJJhhmmss 4 2 <essais>
 *   <bits-2> 0 <q en hexa> » (type Sophie-Germain, test de crible) ; journal
 *   « Sieve next … plus … -bit », « Sieved with … small primes in … seconds »,
 *   « Found … candidates » sur la sortie d'erreur ;
 * - criblage : lit stdin ou -f, options lines= start-line= checkpoint=
 *   generator= prime-tests= (4 au minimum, 100 par defaut), Miller-Rabin sur
 *   q puis p puis q, ecrit « … 2 <tests|4> <essais> <taille> <generateur> <p> »
 *   a la suite du fichier, « Found N safe primes of M candidates in S
 *   seconds » ; le generateur est devine : 2 si p mod 24 = 11, 5 si p mod 10
 *   vaut 3 ou 7.
 * - une machine simulee borne la fenetre de crible (2 Mo de bits) et les
 *   petits premiers (< 2^20) : le resultat est un sous-ensemble valide des
 *   candidats, ce que le criblage confirme.
 *
 * Ecrite contre ces sources, avant l'implantation. Les 12 cas tombent avant
 * (-M etait refuse comme « DH moduli are not simulated ») : aucun temoin ne
 * passe des deux cotes, la sonde ne contient que des refus qui n'existaient
 * pas et des sorties qui n'existaient pas, et son garde-fou est independant :
 * le criblage est verifie par isProbablePrime sur p et sur (p - 1) / 2.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { isProbablePrime } from '@/crypto/rsa';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const LINE = /^(\d{14}) (\d+) (\d+) (\d+) (\d+) ([0-9a-f]+) ([0-9A-F]+)$/;

function machine(kind: 'linux' | 'windows'): LinuxPC | WindowsPC {
  const device = kind === 'linux' ? new LinuxPC('linux-pc', 'PC1', 0, 0) : new WindowsPC('windows-pc', 'WIN');
  device.powerOn();
  return device;
}

async function read(pc: LinuxPC | WindowsPC, path: string): Promise<string[]> {
  const text = await pc.executeCommand(pc instanceof WindowsPC ? `type ${path}` : `cat ${path}`);
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

for (const kind of ['linux', 'windows'] as const) {
  const candidates = kind === 'linux' ? '/tmp/candidates' : 'C:\\candidates';
  const moduli = kind === 'linux' ? '/tmp/moduli' : 'C:\\moduli';
  describe(kind, () => {
    it('une valeur -M inconnue est refusee', async () => {
      expect(await machine(kind).executeCommand('ssh-keygen -M bogus x')).toContain('Unsupported moduli option bogus');
    }, 120_000);

    it('la generation ecrit des candidats Sophie-Germain de la bonne taille', async () => {
      const pc = machine(kind);
      const out = await pc.executeCommand(`ssh-keygen -M generate -O bits=512 ${candidates}`);
      expect(out).toMatch(/Sieve next \d+ plus 511-bit/);
      expect(out).toMatch(/Sieved with \d+ small primes in \d+ seconds/);
      const found = Number(/Found (\d+) candidates/.exec(out)?.[1]);
      const lines = await read(pc, candidates);
      expect(found).toBeGreaterThan(100);
      expect(lines).toHaveLength(found);
      for (const line of lines.slice(0, 50)) {
        const parsed = LINE.exec(line);
        expect(parsed).not.toBeNull();
        const [, , type, tests, , size, generator, modulus] = parsed!;
        expect([type, tests, size, generator]).toEqual(['4', '2', '510', '0']);
        expect(BigInt(`0x${modulus}`).toString(2)).toHaveLength(511);
        expect(BigInt(`0x${modulus}`) % 2n).toBe(1n);
      }
    }, 120_000);

    it('le criblage ne garde que de vrais premiers surs', async () => {
      const pc = machine(kind);
      await pc.executeCommand(`ssh-keygen -M generate -O bits=512 ${candidates}`);
      const out = await pc.executeCommand(`ssh-keygen -M screen -f ${candidates} -O prime-tests=6 ${moduli}`);
      const reported = /Found (\d+) safe primes of (\d+) candidates in \d+ seconds/.exec(out);
      expect(reported).not.toBeNull();
      const lines = await read(pc, moduli);
      expect(lines).toHaveLength(Number(reported![1]));
      expect(lines.length).toBeGreaterThan(5);
      for (const line of lines.slice(0, 5)) {
        const [, , type, tests, , size, generator, modulus] = LINE.exec(line)!;
        const p = BigInt(`0x${modulus}`);
        expect([type, tests, size]).toEqual(['2', '6', '511']);
        expect(['2', '5']).toContain(generator);
        expect(isProbablePrime(p, 30)).toBe(true);
        expect(isProbablePrime((p - 1n) / 2n, 30)).toBe(true);
      }
    }, 280_000);
  });
}

describe('options et erreurs (Linux)', () => {
  const pc = () => machine('linux');

  it('trop peu de bits', async () => {
    const out = await pc().executeCommand('ssh-keygen -M generate -O bits=100 /tmp/c');
    expect(out).toContain('Too few bits: 100 < 512');
    expect(out).toContain('modulus candidate generation failed');
  }, 60_000);

  it('memoire hors bornes', async () => {
    const out = await pc().executeCommand('ssh-keygen -M generate -O bits=512 -O memory=3 /tmp/c');
    expect(out).toContain('Invalid memory amount (min 8, max 127)');
  }, 60_000);

  it('option inconnue', async () => {
    expect(await pc().executeCommand('ssh-keygen -M generate -O weird=1 /tmp/c')).toContain('Option "weird=1" is unsupported for moduli generation');
    expect(await pc().executeCommand('ssh-keygen -M screen -O weird=1 /tmp/c')).toContain('Option "weird=1" is unsupported for moduli screening');
  }, 60_000);

  it('fichier de sortie : zero ou deux', async () => {
    expect(await pc().executeCommand('ssh-keygen -M generate')).toContain('No output file specified');
    expect(await pc().executeCommand('ssh-keygen -M generate a b')).toContain('Too many output files specified');
  }, 60_000);

  it('un point de depart donne les memes candidats', async () => {
    const machineA = pc();
    const start = 'F'.repeat(120);
    await machineA.executeCommand(`ssh-keygen -M generate -O bits=512 -O start=${start} /tmp/a`);
    await machineA.executeCommand(`ssh-keygen -M generate -O bits=512 -O start=${start} /tmp/b`);
    const strip = (lines: string[]) => lines.map((line) => line.split(' ').slice(1).join(' '));
    expect(strip(await read(machineA, '/tmp/a')).length).toBeGreaterThan(50);
    expect(strip(await read(machineA, '/tmp/a'))).toEqual(strip(await read(machineA, '/tmp/b')));
  }, 120_000);

  it('criblage : essais minimum, fichier introuvable, lignes et generateur', async () => {
    const machineA = pc();
    expect(await machineA.executeCommand('ssh-keygen -M screen -O prime-tests=3 /tmp/m'))
      .toContain('Minimum primality trials is 4');
    expect(await machineA.executeCommand('ssh-keygen -M screen -f /tmp/absent /tmp/m'))
      .toContain('Couldn\'t open modulus candidate file "/tmp/absent": No such file or directory');
    await machineA.executeCommand('ssh-keygen -M generate -O bits=512 /tmp/cand');
    const out = await machineA.executeCommand('ssh-keygen -M screen -f /tmp/cand -O lines=300 -O generator=2 -O prime-tests=4 -O checkpoint=/tmp/cp /tmp/m');
    expect(out).toMatch(/Found \d+ safe primes of \d+ candidates in \d+ seconds/);
    for (const line of await read(machineA, '/tmp/m')) expect(LINE.exec(line)![6]).toBe('2');
    expect(await machineA.executeCommand('ls /tmp/cp')).toContain('No such file');
  }, 280_000);
});
