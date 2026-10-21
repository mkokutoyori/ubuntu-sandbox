/**
 * Probe — what rsyslog 8.2608.0 changed in runtime/perctile_stats.c: a percentile value outside the integer range
 * 0..100 (or not an integer) refuses the whole object with "perctile: percentile value '%s' is invalid - must be an
 * integer between 0 and 100" (8.2112.0 took atoi() and wrapped it to a byte), and the three "statname ... truncated"
 * messages now print the name, the delimiter and the buffer length the source computes.
 *
 * Measured against the base commit (git stash of src/network): 7 of the 8 cases fall (each refused value is a case). The one
 * that passes in both states is the WITNESS (an in-range percentile list creates the bucket).
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, startRsyslog, submitLocal } from './_helpers/rsyslogLab';

const STATS = 'module(load="impstats" interval="60" log.syslog="off" log.file="/var/log/stats.log")\n';
const MSG = '<13>Oct 19 12:00:01 ubuntu x: x';

function start(percentiles: string, key = 's', delimiter = '|'): ReturnType<typeof startRsyslog> {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  return startRsyslog(host, `${STATS}percentile_stats(name="b" percentiles=[${percentiles}] windowsize="8" delimiter="${delimiter}")\nset $!r = percentile_observe("b", "${key}", 5);\n*.* /var/log/x.log\n`);
}

const messages = (lab: ReturnType<typeof startRsyslog>): string => `${lab.loader.log.lines().join('\n')}\n${lab.internalMessages.map((entry) => entry.text).join('\n')}`;

describe('percentile_stats, 8.2608.0 changes', () => {
  it('witness: percentiles inside 0..100, bounds included, create the bucket', () => {
    const lab = start('"0", "100"');
    expect(lab.loader.log.lines().join('\n')).not.toContain('percentile value');
    expect(lab.config.percentileStats.find('b')).toBeDefined();
  });

  it.each(['"101"', '"-1"', '"abc"', '"5x"', '"95.5"'])('refuses the value %s and creates no bucket', (value) => {
    const lab = start(`"50", ${value}`);
    expect(lab.loader.log.lines().join('\n')).toContain(`perctile: percentile value ${value.replace(/"/g, "'")} is invalid - must be an integer between 0 and 100`);
    expect(lab.config.percentileStats.find('b')).toBeUndefined();
  });

  it('prints the statname, delimiter and length it computed when the name or the delimiter overflow the buffer', () => {
    const long = start('"50"', 'k'.repeat(130));
    submitLocal(long, MSG);
    expect(messages(long)).toContain(`statname '${'k'.repeat(130)}' truncated - too long for buffer size: 130`);
    const delimited = start('"50"', 'k'.repeat(120), '>'.repeat(10));
    submitLocal(delimited, MSG);
    expect(messages(delimited)).toContain(`statname '${'k'.repeat(120)}' delim '${'>'.repeat(10)}' truncated - too long for buffer size: 130`);
  });

  it('prints the suffixed name as the source wrote it into its buffer when a counter name overflows', () => {
    const lab = start('"50"', 'k'.repeat(116));
    submitLocal(lab, MSG);
    expect(messages(lab)).toContain(`statname '${'k'.repeat(116)}|window_mi' truncated - too long for buffer size: 128`);
  });
});
