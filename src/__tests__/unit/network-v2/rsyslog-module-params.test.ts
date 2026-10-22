/**
 * Probe — cnfDoObj (runtime/rsconf.c) calls nvlstChkUnused after a module(...) has been loaded, so a parameter the module did
 * not consume is reported "parameter 'x' not known -- typo in config file". The eight setModuleConfig functions marked every
 * entry used and said nothing.
 *
 * Measured against the base commit (git stash of src/network): 5 of the 6 cases fall; the one that passes either way is the
 * witness (a parameter the module does know loads without a diagnostic).
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, startRsyslog } from './_helpers/rsyslogLab';

const diagnostics = (config: string): string =>
  startRsyslog(new LabHost('10.0.0.2', new LabNetwork()), config).loader.log.lines().join('\n').toLowerCase();

describe('unknown parameters of module(...)', () => {
  it.each(['imudp', 'imtcp', 'imuxsock', 'imklog', 'immark'])('%s reports a parameter it did not consume', (name) => {
    expect(diagnostics(`module(load="${name}" bogus="1")\n*.* /var/log/x.log`)).toContain("parameter 'bogus' not known");
  });

  it('witness: a parameter the module knows loads without that diagnostic', () => {
    expect(diagnostics('module(load="imudp" threads="2")\n*.* /var/log/x.log')).not.toContain('not known');
  });
});
