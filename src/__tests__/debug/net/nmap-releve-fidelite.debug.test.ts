/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * `nmap` existe deja (`src/network/scan/nmap/`, 18 fichiers). Ce banc
 * mesure ce qui MANQUE encore par rapport au source amont cloné
 * (`github.com/nmap/nmap`) : les options de decouverte, la verbosite, le
 * balayage de liste, les lignes d'identification de service et d'OS, et
 * les codes de sortie.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';

const note = (l: string) => { console.log(l); };

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'web', 0, 0);
  pc.powerOn();
  srv.powerOn();
  new Cable('c1').connect(pc.getPort('eth0') as never, srv.getPort('eth0') as never);
  for (const cmd of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) {
    await pc.executeCommand(cmd);
  }
  for (const cmd of [
    'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0',
    'systemctl start nginx', 'systemctl start sshd',
  ]) {
    await srv.executeCommand(cmd);
  }
  return { pc, srv };
}

describe('nmap : ce qui manque encore au regard du source amont', () => {
  it('releve', async () => {
    const { pc } = await lab();

    note('[A] options de DECOUVERTE : -PS/-PA/-PU/-PE/-PP/-PM/-PO');
    note(`[A0] -sL        -> ${JSON.stringify((await pc.executeCommand('nmap -sL 10.0.0.1-3')).split('\n'))}`);
    note(`[A0] -PS80 --reason -> ${JSON.stringify((await pc.executeCommand('nmap -PS80 --reason -p 80 10.0.0.2')).split('\n').slice(0, 5))}`);
    note(`[A0] -PA80 --reason -> ${JSON.stringify((await pc.executeCommand('nmap -PA80 --reason -p 80 10.0.0.2')).split('\n').slice(0, 5))}`);
    note(`[A0] -PU53 --reason -> ${JSON.stringify((await pc.executeCommand('nmap -PU53 --reason -p 80 10.0.0.2')).split('\n').slice(0, 5))}`);
    note(`[A0] -PE --reason   -> ${JSON.stringify((await pc.executeCommand('nmap -PE --reason -p 80 10.0.0.2')).split('\n').slice(0, 5))}`);
    note(`[A0] -PO --reason   -> ${JSON.stringify((await pc.executeCommand('nmap -PO --reason -p 80 10.0.0.2')).split('\n').slice(0, 5))}`);
    note(`[A0] -PZ            -> ${(await pc.executeCommand('nmap -PZ 10.0.0.2')).split('\n')[0]}`);
    note(`[A0] -PM            -> ${(await pc.executeCommand('nmap -PM 10.0.0.2')).split('\n')[0]}`);
    note(`[A0] -PS x2         -> ${(await pc.executeCommand('nmap -PS22 -PS80 10.0.0.2')).split('\n')[0]}`);
    for (const cmd of [
      'nmap -PS22 10.0.0.2', 'nmap -PA80 10.0.0.2', 'nmap -PU53 10.0.0.2',
      'nmap -PE 10.0.0.2', 'nmap -PP 10.0.0.2', 'nmap -PO 10.0.0.2',
    ]) {
      const out = await pc.executeCommand(cmd);
      note(`[A] ${cmd.padEnd(24)} -> ${(out.split('\n')[0] ?? '').slice(0, 74)}`);
    }

    note('');
    note('[B] VERBOSITE et deboguage : -v, -vv, -d');
    for (const cmd of ['nmap -v -p 80 10.0.0.2', 'nmap -vv -p 80 10.0.0.2', 'nmap -d -p 80 10.0.0.2']) {
      const out = await pc.executeCommand(cmd);
      note(`[B] ${cmd.padEnd(24)} -> ${(out.split('\n')[0] ?? '').slice(0, 74)}`);
    }

    note('');
    note('[C] balayage de LISTE (-sL) : nmap liste sans emettre');
    const sl = await pc.executeCommand('nmap -sL 10.0.0.1-3');
    note(`[C] ${JSON.stringify(sl.split('\n').slice(0, 7))}`);

    note('');
    note('[D] identification : -sV doit poser Service Info, -O ses lignes');
    const sv = await pc.executeCommand('nmap -sV -p 22,80 10.0.0.2');
    for (const l of sv.split('\n')) note(`[D] ${l}`);
    note('      amont : `Service Info: OS: Linux; CPE: cpe:/o:linux:linux_kernel`');

    note('');
    note('[E] -O : Device type / Running / OS CPE / OS details / Network Distance');
    const os = await pc.executeCommand('nmap -O -p 80 10.0.0.2');
    for (const l of os.split('\n')) note(`[E] ${l}`);

    note('');
    note('[F] -sU : un port UDP muet est open|filtered, pas closed');
    const udp = await pc.executeCommand('nmap -sU -p 53,161 10.0.0.2');
    for (const l of udp.split('\n')) note(`[F] ${l}`);

    note('');
    note('[G] options connues de nmap et refusees ici');
    for (const cmd of [
      'nmap -sC 10.0.0.2', 'nmap --script default 10.0.0.2',
      'nmap --osscan-guess -O 10.0.0.2', 'nmap -sO 10.0.0.2',
      'nmap --max-retries 2 10.0.0.2', 'nmap -T4 -p 80 10.0.0.2',
    ]) {
      const out = await pc.executeCommand(cmd);
      note(`[G] ${cmd.padEnd(32)} -> ${(out.split('\n')[0] ?? '').slice(0, 70)}`);
    }

    note('');
    note('[H] la ligne de FIN et la banniere');
    const plain = await pc.executeCommand('nmap -p 22,80 10.0.0.2');
    for (const l of plain.split('\n')) note(`[H] ${l}`);

    expect(true).toBe(true);
  }, 120000);
});
