/**
 * `cmd 2> file &`, `2>> file &` and `2>&1 &` on a background network command, measured against netcat-openbsd 1.226-1ubuntu2 in a
 * fresh network and pid namespace (`unshare -n -p -f --mount-proc bash`), the same script typed here:
 *
 *   nc -lv 127.0.0.1 9101 2> e.txt &                       e.txt = "Listening on localhost 9101"
 *   nc -l  127.0.0.1 9102 2> e2.txt &                      e2.txt exists, 0 bytes
 *   echo old > e3.txt; nc -lv ... 2> e3.txt &              e3.txt truncated: "Listening on localhost 9103"
 *   echo old > e4.txt; nc -lv ... 2>> e4.txt &             "old" then "Listening on localhost 9104"
 *   nc -lv ... > f.txt 2> g.txt &  + one client            f = "hi"; g = "Listening ..." then "Connection received on localhost 40005"
 *   nc -lv ... > both.txt 2>&1 &   + one client            Listening, Connection received, hi (one file offset, in order)
 *   nc -lv ... 2>&1 > only.txt &   + one client            only = "hi": the order of the redirections decides, stderr stays on the terminal
 *
 * The runner of a backgrounded network command only knew `>` and `<`: the `2>` file was never created, and the verbose messages of
 * `nc -v` (written on stderr by the real tool) went nowhere. Measured with the sources at HEAD: 6 of the 7 cases fall. The one that
 * passes either way is `2>&1 > f`: before, the messages were dropped, after, the order of the redirections leaves them on the
 * terminal, so the file holds only the data both times; it is the witness that the lab itself is sound and that the data path was not
 * disturbed, and the stdout half of `> f 2> g` is asserted inside the case that falls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;

async function run(line: string): Promise<string> {
  return pc.executeCommand(`cd /tmp; ${line}`);
}

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
});

describe('stderr of a background network command', () => {
  it('2> file receives the verbose listen message', async () => {
    expect(await run('nc -lv 127.0.0.1 9101 2> e.txt & sleep 0.3; cat e.txt')).toBe('Listening on localhost 9101');
  });

  it('2> file is created and stays empty when the command says nothing', async () => {
    expect(await run('nc -l 127.0.0.1 9102 2> e2.txt & sleep 0.3; ls e2.txt; wc -c < e2.txt')).toBe('e2.txt\n0');
  });

  it('2> truncates what the file held', async () => {
    expect(await run('echo old > e3.txt; nc -lv 127.0.0.1 9103 2> e3.txt & sleep 0.3; cat e3.txt')).toBe('Listening on localhost 9103');
  });

  it('2>> appends after what the file held', async () => {
    expect(await run('echo old > e4.txt; nc -lv 127.0.0.1 9104 2>> e4.txt & sleep 0.3; cat e4.txt')).toBe('old\nListening on localhost 9104');
  });

  it('> f 2> g splits the data from the messages', async () => {
    const out = await run('nc -lv 127.0.0.1 9105 > f.txt 2> g.txt & sleep 0.3; echo hi | nc -N -p 40005 127.0.0.1 9105; sleep 0.3; echo F; cat f.txt; echo G; cat g.txt');
    expect(out).toBe('F\nhi\nG\nListening on localhost 9105\nConnection received on localhost 40005');
  });

  it('> f 2>&1 sends both streams to the file in the order they happen', async () => {
    const out = await run('nc -lv 127.0.0.1 9106 > both.txt 2>&1 & sleep 0.3; echo hi | nc -N -p 40006 127.0.0.1 9106; sleep 0.3; cat both.txt');
    expect(out).toBe('Listening on localhost 9106\nConnection received on localhost 40006\nhi');
  });

  it('2>&1 > f leaves the messages on the terminal and only the data in the file', async () => {
    const out = await run('nc -lv 127.0.0.1 9107 2>&1 > only.txt & sleep 0.3; echo hi | nc -N -p 40007 127.0.0.1 9107; sleep 0.3; echo O; cat only.txt');
    expect(out).toBe('O\nhi');
  });
});
