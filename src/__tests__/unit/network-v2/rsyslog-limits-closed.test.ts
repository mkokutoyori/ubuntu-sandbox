/**
 * Probe — three limits closed after the ratelimit() work: the VFS now signals a file moved into place and a mode change
 * to onEntryChange() (the IN_MOVED_TO / IN_ATTRIB of rswatch.c, which policyWatch needs for an editor's rename-over-save);
 * and imtcp, imuxsock and imklog build their named rate limiter when they start, as activateCnf does in the source, so an
 * unknown ratelimit.name refuses the input instead of showing up at the first message.
 *
 * Measured against the preceding commit (git stash of src/network): 7 of the 8 cases fall. The one that passes in both
 * states is the WITNESS (a write is signalled by onWrite, which already existed).
 */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LabHost, LabNetwork, startRsyslog } from './_helpers/rsyslogLab';

describe('VFS entry events', () => {
  const fresh = (): VirtualFileSystem => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/etc/policy.yaml', 'a', 0, 0, 0o022);
    return vfs;
  };

  it('witness: a write is signalled to onWrite', () => {
    const vfs = fresh();
    let count = 0;
    vfs.onWrite('/etc/policy.yaml', () => { count++; });
    vfs.writeFile('/etc/policy.yaml', 'b', 0, 0, 0o022);
    expect(count).toBe(1);
  });

  it('signals a file renamed over the watched path, and only that path', () => {
    const vfs = fresh();
    vfs.writeFile('/etc/new.yaml', 'n', 0, 0, 0o022);
    let count = 0;
    vfs.onEntryChange('/etc/policy.yaml', () => { count++; });
    vfs.rename('/etc/new.yaml', '/etc/other.yaml');
    expect(count).toBe(0);
    vfs.writeFile('/etc/new2.yaml', 'n', 0, 0, 0o022);
    vfs.rename('/etc/new2.yaml', '/etc/policy.yaml');
    expect(count).toBe(1);
  });

  it('signals a mode change and stops after the subscription is cancelled', () => {
    const vfs = fresh();
    let count = 0;
    const stop = vfs.onEntryChange('/etc/policy.yaml', () => { count++; });
    vfs.chmod('/etc/policy.yaml', 0o600);
    stop();
    vfs.chmod('/etc/policy.yaml', 0o644);
    expect(count).toBe(1);
  });
});

describe('named rate limiter at start', () => {
  const start = (config: string): ReturnType<typeof startRsyslog> => startRsyslog(new LabHost('10.0.0.2', new LabNetwork()), config);
  const messages = (lab: ReturnType<typeof startRsyslog>): string => lab.internalMessages.map((entry) => entry.text).join('\n');

  it('imtcp refuses to start on an unknown ratelimit.name', () => {
    const lab = start('module(load="imtcp")\ninput(type="imtcp" port="514" ratelimit.name="nope")\n*.* /var/log/x.log\n');
    expect(messages(lab)).toContain("ratelimit config 'nope' not found");
  });

  it('imuxsock refuses to start on an unknown ratelimit.name', () => {
    const lab = start('module(load="imuxsock" syssock.use="off")\ninput(type="imuxsock" socket="/dev/mylog" ratelimit.name="nope")\n*.* /var/log/x.log\n');
    expect(messages(lab)).toContain("ratelimit config 'nope' not found");
  });

  it('imklog refuses to start on an unknown ratelimit.name', () => {
    const lab = start('module(load="imklog" ratelimit.name="nope")\n*.* /var/log/x.log\n');
    expect(messages(lab)).toContain("ratelimit config 'nope' not found");
  });
});

describe('security.abortOnIDResolutionFail', () => {
  const start = (config: string): ReturnType<typeof startRsyslog> => startRsyslog(new LabHost('10.0.0.2', new LabNetwork()), config);
  const messages = (lab: ReturnType<typeof startRsyslog>): string => lab.internalMessages.map((entry) => entry.text).join('\n');

  it('by default a legacy directive naming an unknown user stops the daemon, as exit(1) does in cfsysline.c', () => {
    const lab = start('$FileOwner nosuchuser\n*.* /var/log/x.log\n');
    expect(lab.engine.isStarted).toBe(false);
    expect(messages(lab)).toContain("ID for user 'nosuchuser' could not be found or error");
  });

  it('with the parameter off the error is logged and the daemon runs on', () => {
    const lab = start('global(security.abortOnIDResolutionFail="off")\n$FileOwner nosuchuser\n*.* /var/log/x.log\n');
    expect(lab.engine.isStarted).toBe(true);
    expect(lab.loader.log.lines().join('\n')).toContain("ID for user 'nosuchuser' could not be found or error");
  });
});
