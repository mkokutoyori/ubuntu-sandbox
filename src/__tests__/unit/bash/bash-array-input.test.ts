import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => {
  exec = new LinuxCommandExecutor(false);
  exec.userMgr.currentUser = 'root';
  exec.userMgr.currentUid = 0;
  exec.userMgr.currentGid = 0;
  exec.vfs.writeFile('/tmp/lines.txt', 'alpha\nbeta\ngamma\n', 0, 0, 0o022);
});
async function run(cmd: string): Promise<string> { return await exec.execute(cmd); }

describe('$(< file) fast command substitution', () => {
  it('expands to the file content', async () => {
    expect(await run('echo $(< /tmp/lines.txt)')).toContain('alpha beta gamma');
  });

  it('preserves content when quoted', async () => {
    const out = await run('v="$(< /tmp/lines.txt)"; echo "${v}"');
    expect(out).toContain('alpha\nbeta\ngamma');
  });

  it('yields an error for a missing file', async () => {
    const out = await run('echo "$(< /tmp/absent.txt)"; echo rc=$?');
    expect(out).toMatch(/No such file|rc=/);
  });
});

describe('mapfile / readarray', () => {
  it('mapfile -t loads lines without terminators', async () => {
    const out = await run('mapfile -t arr < /tmp/lines.txt; echo "${arr[1]}"');
    expect(out).toContain('beta');
  });

  it('readarray is an exact alias', async () => {
    const out = await run('readarray -t arr < /tmp/lines.txt; echo "${arr[2]}"');
    expect(out).toContain('gamma');
  });

  it('reports the element count through ${#arr[@]}', async () => {
    const out = await run('mapfile -t arr < /tmp/lines.txt; echo count=${#arr[@]}');
    expect(out).toContain('count=3');
  });

  it('defaults to the MAPFILE array', async () => {
    const out = await run('mapfile -t < /tmp/lines.txt; echo "${MAPFILE[0]}"');
    expect(out).toContain('alpha');
  });

  it('reads from a process substitution', async () => {
    const out = await run('mapfile -t arr < <(printf "x\\ny\\n"); echo "${arr[1]}"');
    expect(out).toContain('y');
  });
});

describe('read -a', () => {
  it('splits a herestring into an indexed array', async () => {
    const out = await run('read -a words <<< "one two three"; echo "${words[2]}"');
    expect(out).toContain('three');
  });

  it('populates every element', async () => {
    const out = await run('read -a words <<< "a b c"; echo n=${#words[@]}');
    expect(out).toContain('n=3');
  });
});
