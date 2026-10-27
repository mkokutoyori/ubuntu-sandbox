/**
 * Probe - runtime/dynstats.c (writeStateFile) and plugins/impstats/impstats.c (runInput, log.file.overwrite) of rsyslog
 * 8.2610: the dyn_stats state file is written to "<file>.tmp" and renamed over the state, the impstats file in overwrite
 * mode to "<file>.tmp.XXXXXX" (six random characters, mkstemp) and renamed over the log, so a reader never sees a half-written
 * file; a rename that fails is reported with the temporary name and the temporary file is removed.
 *
 * Measured against the preceding commit (git stash push -- src/network): 4 of the 5 cases fall (both files were written in
 * place, without a temporary name, and the host offered no rename). The one that passes either way is the WITNESS: the final
 * contents of both files are the same, atomic or not.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

const STATE = '/var/spool/rsyslog/dynstats-state:msgs';

function rig(config: string): { host: LabHost; engine: LabEngine; renames: Array<[string, string]> } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  host.directories.add('/var/spool/rsyslog');
  const renames: Array<[string, string]> = [];
  const original = host.files.rename;
  host.files.rename = (from: string, to: string): boolean => {
    renames.push([from, to]);
    return original(from, to);
  };
  return { host, engine: startRsyslog(host, config), renames };
}

const dynstats = 'module(load="impstats" interval="3600" log.syslog="off" log.file="/var/log/stats.log")\nglobal(workDirectory="/var/spool/rsyslog")\ndyn_stats(name="msgs" persistStateInterval="100" resettable="off")\nset $!r = dyn_inc("msgs", $programname);\n*.* /var/log/x.log\n';
const overwrite = 'module(load="impstats" interval="60" log.file="/var/log/stats.log" log.file.overwrite="on" log.syslog="off")\n';

describe('atomic state files', () => {
  it('witness: the dyn_stats state ends up complete', () => {
    const { host, engine } = rig(dynstats);
    submitLocal(engine, '<13>Oct 19 12:00:01 ubuntu alice: x');
    engine.engine.stop();
    expect(host.fileSystem.get(STATE)).toBe('{"name":"msgs","values":{"alice":1}}');
  });

  it('the dyn_stats state goes through <file>.tmp and a rename', () => {
    const { host, engine, renames } = rig(dynstats);
    submitLocal(engine, '<13>Oct 19 12:00:01 ubuntu alice: x');
    engine.engine.stop();
    expect(renames).toEqual([[`${STATE}.tmp`, STATE]]);
    expect(host.fileSystem.has(`${STATE}.tmp`)).toBe(false);
  });

  it('the impstats overwrite file goes through <file>.tmp.XXXXXX and a rename', () => {
    const { host, renames } = rig(overwrite);
    host.advance(60_000);
    expect(renames).toHaveLength(1);
    expect(renames[0][0]).toMatch(/^\/var\/log\/stats\.log\.tmp\.[A-Za-z0-9]{6}$/);
    expect(renames[0][1]).toBe('/var/log/stats.log');
    expect(host.fileSystem.get('/var/log/stats.log')).toContain('resource-usage');
    expect([...host.fileSystem.keys()].some((path) => path.includes('.tmp.'))).toBe(false);
  });

  it('a failed rename of the impstats file is reported with the temporary name and cleans up', () => {
    const { host, engine } = rig(overwrite);
    host.files.rename = (): boolean => false;
    host.advance(60_000);
    const text = engine.internalMessages.map((entry) => entry.text).join('\n');
    expect(text).toMatch(/impstats: error renaming temp stats file \/var\/log\/stats\.log\.tmp\.[A-Za-z0-9]{6} to \/var\/log\/stats\.log/);
    expect([...host.fileSystem.keys()].some((path) => path.includes('.tmp.'))).toBe(false);
  });

  it('a failed rename of the dyn_stats state is reported and the temporary file removed', () => {
    const { host, engine } = rig(dynstats);
    host.files.rename = (): boolean => false;
    submitLocal(engine, '<13>Oct 19 12:00:01 ubuntu alice: x');
    engine.engine.stop();
    const text = engine.internalMessages.map((entry) => entry.text).join('\n');
    expect(text).toContain(`dynstats: rename failed from '${STATE}.tmp' to '${STATE}'`);
    expect(host.fileSystem.has(`${STATE}.tmp`)).toBe(false);
  });
});
