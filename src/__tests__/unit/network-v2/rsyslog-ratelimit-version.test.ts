/**
 * Probe — what rsyslog 8.2112.0, the version the machine reports, does and does not know about rate limiting.
 * Verified in that source tree: there is no ratelimit() configuration object (grammar/lexer.l lists main_queue, timezone,
 * parser, global, template, ruleset, property, constant, input, module, lookup_table, dyn_stats, percentile_stats,
 * include, action), no "ratelimit.name" / "syssock.ratelimit.name" parameter on any module or action (it appears in 8.2608
 * only), no ratelimit parameter at all on omusrmsg, and no "action.ratelimit.name" in action.c. What does exist, and is
 * kept: ratelimit.interval / ratelimit.burst on imudp, imtcp and omfwd, ratelimit.interval / burst / severity on imuxsock
 * and syssock.*, ratelimitinterval / ratelimitburst on imklog.
 *
 * Also covered: cnfDoObj (runtime/rsconf.c) calls nvlstChkUnused after loading a module, so a module(...) parameter the
 * module did not consume is reported; the eight setModuleConfig functions marked every entry used and said nothing.
 *
 * Measured against the base commit (git stash of src/network): 10 of the 11 cases fall - the engine, ported from 8.2610,
 * accepted the object and the parameters (and stored action.ratelimit.name without ever reading it). The one that passes in
 * both states is the witness: imudp's ratelimit.interval / burst still limits.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog } from './_helpers/rsyslogLab';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const unknown = (name: string): string => `parameter '${name}' not known`;

function diagnostics(config: string): string {
  const host = new LabHost('10.0.0.2', new LabNetwork());
  return startRsyslog(host, config).loader.log.lines().join('\n');
}

describe('rate limiting as 8.2112.0 knows it', () => {
  it('witness: imudp ratelimit.interval and ratelimit.burst still limit what a sender may submit', () => {
    const net = new LabNetwork();
    const client = new LabHost('10.0.0.1', net);
    const server = new LabHost('10.0.0.2', net);
    startRsyslog(server, 'module(load="imudp")\ninput(type="imudp" port="514" ratelimit.interval="5" ratelimit.burst="2")\n*.* /var/log/in.log');
    for (let count = 0; count < 4; count++) client.network.sendDatagram('10.0.0.2', 514, encode(`<13>Oct 19 12:00:00 ubuntu alice: m${count}`));
    expect(lines(server.fileSystem.get('/var/log/in.log') ?? null).filter((line) => line.includes('alice:'))).toHaveLength(2);
  });

  it('has no ratelimit() object: the declaration is not accepted', () => {
    expect(diagnostics('ratelimit(name="r" interval="1" burst="2")\n*.* /var/log/x.log')).not.toBe('');
  });

  it.each([
    ['imudp', 'module(load="imudp")\ninput(type="imudp" port="514" ratelimit.name="r")\n*.* /var/log/x.log', 'ratelimit.name'],
    ['imtcp', 'module(load="imtcp")\ninput(type="imtcp" port="514" ratelimit.name="r")\n*.* /var/log/x.log', 'ratelimit.name'],
    ['imuxsock input', 'module(load="imuxsock")\ninput(type="imuxsock" socket="/run/x.sock" ratelimit.name="r")\n*.* /var/log/x.log', 'ratelimit.name'],
    ['imuxsock syssock', 'module(load="imuxsock" syssock.ratelimit.name="r")\n*.* /var/log/x.log', 'syssock.ratelimit.name'],
    ['imklog', 'module(load="imklog" ratelimit.name="r")\n*.* /var/log/x.log', 'ratelimit.name'],
    ['omfwd', '*.* action(type="omfwd" target="10.0.0.9" ratelimit.name="r")', 'ratelimit.name'],
    ['action', '*.* action(type="omfile" file="/var/log/x.log" action.ratelimit.name="r")', 'action.ratelimit.name'],
  ])('%s does not know the ratelimit.name parameter', (_label, config, parameter) => {
    expect(diagnostics(config).toLowerCase()).toContain(unknown(parameter).toLowerCase());
  });

  it('reports any parameter of module(...) that the module did not consume, as cnfDoObj does after loading it', () => {
    for (const name of ['imudp', 'imtcp', 'imuxsock', 'imklog', 'immark']) {
      expect(diagnostics(`module(load="${name}" bogus="1")\n*.* /var/log/x.log`).toLowerCase()).toContain(unknown('bogus'));
    }
    expect(diagnostics('module(load="imudp" threads="2")\n*.* /var/log/x.log')).not.toContain('not known');
  });

  it('omusrmsg has no ratelimit parameter at all', () => {
    expect(diagnostics('*.* action(type="omusrmsg" users="*" ratelimit.interval="1")').toLowerCase()).toContain(unknown('ratelimit.interval'));
  });
});
