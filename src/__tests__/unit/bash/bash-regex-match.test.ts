import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => {
  exec = new LinuxCommandExecutor(false);
  exec.userMgr.currentUser = 'root';
  exec.userMgr.currentUid = 0;
  exec.userMgr.currentGid = 0;
});
function run(cmd: string): string { return exec.execute(cmd); }

describe('[[ =~ ]] full ERE support', () => {
  it('matches a plain pattern without groups', () => {
    expect(run('[[ hello =~ ell ]] && echo yes')).toContain('yes');
  });

  it('accepts capture groups in the pattern', () => {
    expect(run('[[ abc123 =~ ([a-z]+)([0-9]+) ]] && echo matched')).toContain('matched');
  });

  it('fails with status 1 when the pattern does not match', () => {
    expect(run('[[ abc =~ ^[0-9]+$ ]]; echo rc=$?')).toContain('rc=1');
  });

  it('supports alternation', () => {
    expect(run('[[ cat =~ ^(cat|dog)$ ]] && echo animal')).toContain('animal');
  });

  it('supports quantifiers and anchors', () => {
    expect(run('[[ 192.168.1.1 =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$ ]] && echo ip')).toContain('ip');
  });

  it('matches against an expanded variable on the left', () => {
    expect(run('v=user42; [[ $v =~ ^user([0-9]+)$ ]] && echo ok')).toContain('ok');
  });

  it('expands variables inside the pattern', () => {
    expect(run('p="^ab"; [[ abcd =~ ${p}c ]] && echo varpat')).toContain('varpat');
  });

  it('treats a quoted pattern as a literal string', () => {
    expect(run('[[ a.c =~ "a.c" ]] && echo lit1')).toContain('lit1');
    expect(run('[[ abc =~ "a.c" ]]; echo rc=$?')).toContain('rc=1');
  });
});

describe('BASH_REMATCH', () => {
  it('stores the full match at index 0', () => {
    expect(run('[[ abc123 =~ [0-9]+ ]] && echo "${BASH_REMATCH[0]}"')).toContain('123');
  });

  it('stores capture groups at indices 1..n', () => {
    const out = run('[[ abc123 =~ ([a-z]+)([0-9]+) ]] && echo "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}"');
    expect(out).toContain('abc-123');
  });

  it('keeps working inside an if body', () => {
    const out = run('if [[ "user=alice" =~ ^user=(.+)$ ]]; then echo "who:${BASH_REMATCH[1]}"; fi');
    expect(out).toContain('who:alice');
  });

  it('an unmatched optional group yields the empty string', () => {
    const out = run('[[ ab =~ ^(a)(x)?(b)$ ]] && echo "g2=[${BASH_REMATCH[2]}] g3=${BASH_REMATCH[3]}"');
    expect(out).toContain('g2=[] g3=b');
  });
});
