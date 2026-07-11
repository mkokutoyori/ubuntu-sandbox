import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => {
  exec = new LinuxCommandExecutor(false);
  exec.userMgr.currentUser = 'root';
  exec.userMgr.currentUid = 0;
  exec.userMgr.currentGid = 0;
});
async function run(cmd: string): Promise<string> { return await exec.execute(cmd); }

describe('[[ =~ ]] full ERE support', () => {
  it('matches a plain pattern without groups', async () => {
    expect(await run('[[ hello =~ ell ]] && echo yes')).toContain('yes');
  });

  it('accepts capture groups in the pattern', async () => {
    expect(await run('[[ abc123 =~ ([a-z]+)([0-9]+) ]] && echo matched')).toContain('matched');
  });

  it('fails with status 1 when the pattern does not match', async () => {
    expect(await run('[[ abc =~ ^[0-9]+$ ]]; echo rc=$?')).toContain('rc=1');
  });

  it('supports alternation', async () => {
    expect(await run('[[ cat =~ ^(cat|dog)$ ]] && echo animal')).toContain('animal');
  });

  it('supports quantifiers and anchors', async () => {
    expect(await run('[[ 192.168.1.1 =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$ ]] && echo ip')).toContain('ip');
  });

  it('matches against an expanded variable on the left', async () => {
    expect(await run('v=user42; [[ $v =~ ^user([0-9]+)$ ]] && echo ok')).toContain('ok');
  });

  it('expands variables inside the pattern', async () => {
    expect(await run('p="^ab"; [[ abcd =~ ${p}c ]] && echo varpat')).toContain('varpat');
  });

  it('treats a quoted pattern as a literal string', async () => {
    expect(await run('[[ a.c =~ "a.c" ]] && echo lit1')).toContain('lit1');
    expect(await run('[[ abc =~ "a.c" ]]; echo rc=$?')).toContain('rc=1');
  });
});

describe('BASH_REMATCH', () => {
  it('stores the full match at index 0', async () => {
    expect(await run('[[ abc123 =~ [0-9]+ ]] && echo "${BASH_REMATCH[0]}"')).toContain('123');
  });

  it('stores capture groups at indices 1..n', async () => {
    const out = await run('[[ abc123 =~ ([a-z]+)([0-9]+) ]] && echo "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}"');
    expect(out).toContain('abc-123');
  });

  it('keeps working inside an if body', async () => {
    const out = await run('if [[ "user=alice" =~ ^user=(.+)$ ]]; then echo "who:${BASH_REMATCH[1]}"; fi');
    expect(out).toContain('who:alice');
  });

  it('an unmatched optional group yields the empty string', async () => {
    const out = await run('[[ ab =~ ^(a)(x)?(b)$ ]] && echo "g2=[${BASH_REMATCH[2]}] g3=${BASH_REMATCH[3]}"');
    expect(out).toContain('g2=[] g3=b');
  });
});
