/**
 * Probe — global(operatingStateFile) of rsyslog 8.2608.0 (runtime/operatingstate.c): at start the previous file is
 * checked for a last line "CLEAN CLOSE"; if it is not there it is kept as <file>.previous with an error and an info
 * line; the new file gets "STATE INITIALIZING <version>", a MSG line for every message rsyslogd itself logs, and
 * "STATE CLEAN CLOSE" at a normal stop.
 *
 * Measured against the preceding commit (git stash of src/network): 4 of the 5 cases fall - the parameter was stored and
 * never read. The one that passes in both states is the WITNESS (no parameter, no file).
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog } from './_helpers/rsyslogLab';

const FILE = '/var/log/rsyslog.state';
const CONFIG = `global(operatingStateFile="${FILE}")\n*.* /var/log/x.log\n`;
const state = (host: LabHost, path = FILE): string[] => lines(host.fileSystem.get(path) ?? null);

describe('operatingStateFile', () => {
  it('witness: without the parameter no file is written', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    startRsyslog(host, '*.* /var/log/x.log\n');
    expect(host.fileSystem.has(FILE)).toBe(false);
  });

  it('starts the file with the INITIALIZING state and ends it with CLEAN CLOSE at a normal stop', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    const lab = startRsyslog(host, CONFIG);
    expect(state(host)[0]).toMatch(/^\d{8}-\d{6}: STATE INITIALIZING 8\.2610\.0$/);
    lab.engine.stop();
    expect(state(host).at(-1)).toMatch(/^\d{8}-\d{6}: STATE CLEAN CLOSE$/);
  });

  it('records the messages rsyslogd logs as MSG lines without the version suffix', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    const lab = startRsyslog(host, `${CONFIG}module(load="imtcp")\ninput(type="imtcp" port="514" ratelimit.name="nope")\n`);
    lab.engine.stop();
    expect(state(host).some((line) => /: MSG   ratelimit config 'nope' not found$/.test(line))).toBe(true);
  });

  it('keeps a file that does not end cleanly as .previous and says so', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    host.fileSystem.set(FILE, '20261019-120000: STATE INITIALIZING 8.2610.0\n');
    const lab = startRsyslog(host, CONFIG);
    expect(state(host, `${FILE}.previous`)).toEqual(['20261019-120000: STATE INITIALIZING 8.2610.0']);
    const text = lab.internalMessages.map((entry) => entry.text).join('\n');
    expect(text).toContain(`existing operatingStateFile '${FILE}' does not end with 'CLEAN CLOSE, instead it has`);
    expect(text).toContain(`existing state file '${FILE}' renamed to '${FILE}.previous' - you may want to review it`);
  });

  it('leaves a cleanly closed file alone and appends to it', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    startRsyslog(host, CONFIG).engine.stop();
    const second = startRsyslog(host, CONFIG);
    expect(host.fileSystem.has(`${FILE}.previous`)).toBe(false);
    expect(state(host).filter((line) => line.includes('INITIALIZING'))).toHaveLength(2);
    second.engine.stop();
  });
});
