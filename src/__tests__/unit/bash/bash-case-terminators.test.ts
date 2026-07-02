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

describe('case terminators ;& and ;;&', () => {
  it(';; stops after the first matching item', () => {
    const out = run('case x in x) echo one ;; *) echo two ;; esac');
    expect(out).toContain('one');
    expect(out).not.toContain('two');
  });

  it(';& falls through to the next body without testing its pattern', () => {
    const out = run('case x in x) echo one ;& zzz) echo two ;; *) echo three ;; esac');
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).not.toContain('three');
  });

  it(';;& keeps testing the remaining patterns', () => {
    const out = run('case abc in a*) echo starts-a ;;& *c) echo ends-c ;; *) echo fallback ;; esac');
    expect(out).toContain('starts-a');
    expect(out).toContain('ends-c');
    expect(out).not.toContain('fallback');
  });

  it(';;& skips items whose pattern does not match', () => {
    const out = run('case abc in a*) echo starts-a ;;& z*) echo starts-z ;; *b*) echo has-b ;; esac');
    expect(out).toContain('starts-a');
    expect(out).not.toContain('starts-z');
    expect(out).toContain('has-b');
  });

  it('chained ;& cascades through several bodies', () => {
    const out = run('case 1 in 1) echo a ;& 2) echo b ;& 3) echo c ;; esac');
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('c');
  });

  it('mixing the three terminators behaves per item', () => {
    const out = run('case abc in abc) echo m1 ;;& a*) echo m2 ;& zz) echo m3 ;; *) echo m4 ;; esac');
    expect(out).toContain('m1');
    expect(out).toContain('m2');
    expect(out).toContain('m3');
    expect(out).not.toContain('m4');
  });
});
