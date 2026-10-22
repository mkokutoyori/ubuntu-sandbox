/**
 * Probe — the ratelimit() object of rsyslog 8.2608.0 (runtime/ratelimit.c, runtime/rsconf.c initFunc_ratelimit,
 * runtime/action.c actionCheckOutputRatelimit, runtime/rswatch.c): the YAML policy file (interval, burst, severity,
 * scope, mode, perSource with keyTemplate / maxStates / topN / default / overrides), the legacy perSource* parameters,
 * input and output scope, drop and pace, reload on HUP and by policyWatch, and the counters it exposes
 * (ratelimit.<name>.per_source, ratelimit.allowed / dropped / paced / paced_usec of the action).
 *
 * Measured against the base commit (git stash of src/network): 46 of the 48 cases fall - "policy" was accepted and
 * ignored, the other parameters were refused as unknown and action.ratelimit.name was stored and never evaluated. The 2
 * that pass in both states are the WITNESS (an inline interval and burst limit a listener) and the refusal of a
 * negative interval or burst, which the previous object already did (non-regression).
 * Time moves with LabHost.advance(); the policy files are rewritten with LabHost.rewrite(), which also raises the file
 * event the simulated host offers to policyWatch.
 */
import { describe, expect, it } from 'vitest';
import { mixedHash } from '@/network/rsyslog/engine/HashTable';
import { LabHost, LabNetwork, lines, startRsyslog, type LabEngine } from './_helpers/rsyslogLab';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const MSG = (text: string, hostname = 'ubuntu', priority = 13): string => `<${priority}>Oct 19 12:00:01 ${hostname} alice: ${text}`;
const STATS_FILE = '/var/log/stats.log';
const STATS = `module(load="impstats" interval="60" log.syslog="off" log.file="${STATS_FILE}")\n`;
const TEMPLATE = 'template(name="probe" type="string" string="%hostname%|%msg%\\n")\n';
const INPUT = 'module(load="imudp")\ninput(type="imudp" port="514" ratelimit.name="r")\n';
const FILE_ACTION = '*.* action(type="omfile" file="/var/log/in.log" template="probe")\n';
const PER_IP = 'template(name="PerSourceIP" type="string" string="%fromhost-ip%")\n';

interface Rig {
  readonly net: LabNetwork;
  readonly server: LabHost;
  readonly srv: LabEngine;
  clients: LabHost[];
}

function rig(config: string, files: Record<string, string> = {}, options: { watchUnavailable?: boolean } = {}): Rig {
  const net = new LabNetwork();
  const server = new LabHost('10.0.0.2', net);
  server.watchUnavailable = options.watchUnavailable === true;
  const clients = ['10.0.0.1', '10.0.0.3', '10.0.0.4'].map((address) => new LabHost(address, net));
  return { net, server, srv: startRsyslog(server, config, { files }), clients };
}

const send = (r: Rig, text: string, client = 0): void => {
  r.clients[client].network.sendDatagram('10.0.0.2', 514, encode(text));
};
const filed = (r: Rig): string[] => lines(r.server.fileSystem.get('/var/log/in.log') ?? null);
const internal = (r: Rig): string => r.srv.internalMessages.map((entry) => entry.text).join('\n');
const diagnostics = (r: Rig): string => `${r.srv.loader.log.lines().join('\n')}\n${internal(r)}`;
const statsLines = (r: Rig): string[] => lines(r.server.fileSystem.get(STATS_FILE) ?? null).map((line) => line.replace(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ [\d:]+ \d+: /, ''));
const statsOf = (r: Rig, name: string): string[] => statsLines(r).filter((line) => line.startsWith(`${name}: `));

const POLICY = '/etc/rl.yaml';
const base = (policy: string, extra = ''): string => `${TEMPLATE}${PER_IP}${STATS}ratelimit(name="r" policy="${POLICY}"${extra})\n${INPUT}${FILE_ACTION}`;
const perSourcePolicy = (body = '  default:\n    max: 2\n    window: 10s\n', head = '  enabled: true\n  keyTemplate: "PerSourceIP"\n'): string => `perSource:\n${head}${body}`;

describe('ratelimit(): global limits', () => {
  it('witness: inline interval and burst limit a listener', () => {
    const r = rig(`${TEMPLATE}ratelimit(name="r" interval="5" burst="2")\n${INPUT}${FILE_ACTION}`);
    for (let count = 0; count < 5; count++) send(r, MSG(`m${count}`));
    expect(filed(r)).toHaveLength(2);
  });

  it('interval and burst come from the YAML policy file', () => {
    const r = rig(base(''), { [POLICY]: 'interval: 5\nburst: 2\n' });
    for (let count = 0; count < 5; count++) send(r, MSG(`m${count}`));
    expect(filed(r)).toHaveLength(2);
  });

  it('a value in the policy file replaces the same inline value', () => {
    const r = rig(base('', ' interval="1" burst="100"'), { [POLICY]: 'interval: 5\nburst: 2\n' });
    for (let count = 0; count < 5; count++) send(r, MSG(`m${count}`));
    expect(filed(r)).toHaveLength(2);
  });

  it('severity limits only the messages at or above that numeric threshold', () => {
    const r = rig(base(''), { [POLICY]: 'interval: 5\nburst: 1\nseverity: warning\n' });
    for (let count = 0; count < 3; count++) send(r, MSG(`err${count}`, 'ubuntu', 11));
    for (let count = 0; count < 3; count++) send(r, MSG(`notice${count}`, 'ubuntu', 13));
    expect(filed(r)).toHaveLength(4);
  });

  it('HUP reloads the policy file and says so', () => {
    const r = rig(base(''), { [POLICY]: 'interval: 5\nburst: 2\n' });
    r.server.rewrite(POLICY, 'interval: 5\nburst: 4\n');
    r.srv.engine.hup();
    expect(internal(r)).toContain("ratelimit: HUP reloaded policy 'r' from file '/etc/rl.yaml'");
    for (let count = 0; count < 6; count++) send(r, MSG(`m${count}`));
    expect(filed(r)).toHaveLength(4);
  });

  it('a reload that fails keeps the old values and names the file', () => {
    const r = rig(base(''), { [POLICY]: 'interval: 5\nburst: 2\n' });
    r.server.rewrite(POLICY, 'interval: 5\nburst: oops\n');
    r.srv.engine.hup();
    expect(internal(r)).toContain("ratelimit: invalid burst value 'oops' in /etc/rl.yaml");
    expect(internal(r)).toContain("ratelimit: HUP failed to reload policy 'r' from file '/etc/rl.yaml', keeping old values");
    for (let count = 0; count < 5; count++) send(r, MSG(`m${count}`));
    expect(filed(r)).toHaveLength(2);
  });

  it('a reload may not change the scope of the policy', () => {
    const r = rig(base(''), { [POLICY]: 'interval: 5\nburst: 2\n' });
    r.server.rewrite(POLICY, 'scope: output\nmode: drop\ninterval: 5\nburst: 2\n');
    r.srv.engine.hup();
    expect(internal(r)).toContain("ratelimit: HUP reload of policy 'r' from file '/etc/rl.yaml' rejected because scope changed");
  });

  it.each([
    ['interval: x\n', "ratelimit: invalid interval value 'x' in /etc/rl.yaml"],
    ['burst: -1\n', "ratelimit: invalid burst value '-1' in /etc/rl.yaml"],
    ['severity: loud\n', "ratelimit: invalid severity value 'loud' in /etc/rl.yaml"],
    ['scope: sideways\n', "ratelimit: invalid scope value 'sideways' in /etc/rl.yaml"],
    ['mode: maybe\n', "ratelimit: invalid mode value 'maybe' in /etc/rl.yaml"],
    ['a: b: c\n', 'ratelimit: yaml parser error in policy file /etc/rl.yaml: mapping values are not allowed in this context'],
  ])('refuses the policy file %j at load', (content, message) => {
    const r = rig(base(''), { [POLICY]: content });
    expect(diagnostics(r)).toContain(message);
    expect(diagnostics(r)).toContain("ratelimit config 'r' not found");
  });

  it('refuses a policy file that does not exist', () => {
    const r = rig(base(''));
    expect(diagnostics(r)).toContain('ratelimit: error opening policy file /etc/rl.yaml: No such file or directory');
  });

  it('refuses two objects with one name', () => {
    const r = rig(`ratelimit(name="r" interval="5" burst="2")\nratelimit(name="r" interval="1" burst="1")\n${INPUT}${FILE_ACTION}`);
    expect(diagnostics(r)).toContain("ratelimit: duplicate name 'r' in current config set");
  });

  it('refuses a negative interval or burst', () => {
    expect(diagnostics(rig('ratelimit(name="r" interval="-1")\n*.* /var/log/x.log'))).toContain("ratelimit: interval must be >= 0 for 'r'");
    expect(diagnostics(rig('ratelimit(name="r" burst="-1")\n*.* /var/log/x.log'))).toContain("ratelimit: burst must be >= 0 for 'r'");
  });
});

describe('ratelimit(): output policies', () => {
  const OUTPUT_POLICY = 'scope: output\nmode: drop\ninterval: 5\nburst: 2\n';
  const outputConfig = (queue = '', policy = POLICY): string =>
    `${TEMPLATE}${STATS}ratelimit(name="o" policy="${policy}")\nmodule(load="imudp")\ninput(type="imudp" port="514")\n*.* action(type="omfile" name="out" file="/var/log/in.log" template="probe" action.ratelimit.name="o"${queue})\n`;

  it('drop mode discards what exceeds the burst before the output module and counts it', () => {
    const r = rig(outputConfig(), { [POLICY]: OUTPUT_POLICY });
    for (let count = 0; count < 5; count++) send(r, MSG(`m${count}`));
    expect(filed(r)).toHaveLength(2);
    r.server.advance(60_000);
    expect(statsOf(r, 'out')[0]).toBe('out: origin=core.action processed=5 batchesprocessed=5 failed=0 suspended=0 suspended.duration=0 resumed=0 ratelimit.allowed=2 ratelimit.dropped=3 ratelimit.paced=0 ratelimit.paced_usec=0 ');
  });

  it('pace mode on a queued action keeps every message and waits for the next window', () => {
    const r = rig(outputConfig(' queue.type="LinkedList"'), { [POLICY]: 'scope: output\nmode: pace\ninterval: 1\nburst: 2\n' });
    for (let count = 0; count < 5; count++) send(r, MSG(`m${count}`));
    r.server.advance(5_000);
    expect(filed(r)).toHaveLength(5);
    r.server.advance(60_000);
    const line = statsOf(r, 'out')[0];
    expect(line).toContain('ratelimit.allowed=5 ratelimit.dropped=0 ratelimit.paced=2 ratelimit.paced_usec=2000000 ');
  });

  it('pace mode is refused for a direct action, which is then not created', () => {
    const r = rig(outputConfig(), { [POLICY]: 'scope: output\nmode: pace\ninterval: 1\nburst: 2\n' });
    expect(diagnostics(r)).toContain("action 'out': action.ratelimit.name='o' uses pace mode, which requires a non-direct action queue");
    send(r, MSG('m'));
    expect(filed(r)).toEqual([]);
  });

  it('an action refuses an input policy, a listener refuses an output one, and an unknown name is reported', () => {
    const inputPolicy = rig(outputConfig('', POLICY), { [POLICY]: 'interval: 5\nburst: 2\n' });
    expect(diagnostics(inputPolicy)).toContain("ratelimit config 'o' has incompatible scope for action");
    const listener = rig(`${TEMPLATE}ratelimit(name="r" policy="${POLICY}")\n${INPUT}${FILE_ACTION}`, { [POLICY]: OUTPUT_POLICY });
    expect(diagnostics(listener)).toContain("ratelimit config 'r' has incompatible scope for imudp");
    const unknown = rig(`${TEMPLATE}module(load="imudp")\n*.* action(type="omfile" file="/var/log/in.log" action.ratelimit.name="nope")\n`);
    expect(diagnostics(unknown)).toContain("ratelimit config 'nope' not found");
  });

  it.each([
    ['scope: output\ninterval: 1\nburst: 2\n', "ratelimit: output policy 'o' must define mode in the YAML policy file"],
    ['scope: output\nmode: drop\nburst: 2\n', "ratelimit: output policy 'o' must define interval and burst in the YAML policy file"],
    ['scope: output\nmode: drop\ninterval: 1\nburst: 2\nseverity: info\n', "ratelimit: output policy 'o' does not support severity or perSource in this version"],
    ['scope: output\nmode: pace\ninterval: 1\nburst: 0\n', "ratelimit: output policy 'o' pace mode requires burst greater than zero"],
    ['mode: drop\ninterval: 1\nburst: 2\n', "ratelimit: input policy 'o' must not define output mode"],
  ])('refuses the output policy %j', (content, message) => {
    const r = rig(outputConfig(), { [POLICY]: content });
    expect(diagnostics(r)).toContain(message);
  });

  it('refuses inline limits on an output policy', () => {
    const r = rig(outputConfig().replace('policy="/etc/rl.yaml"', 'policy="/etc/rl.yaml" interval="1"'), { [POLICY]: OUTPUT_POLICY });
    expect(diagnostics(r)).toContain("ratelimit: output policy 'o' must define limits only in the YAML policy file");
  });
});

describe('ratelimit(): per-source limits', () => {
  it('limits each source on its own, keyed by the template the policy names', () => {
    const r = rig(base(''), { [POLICY]: perSourcePolicy() });
    for (let count = 0; count < 5; count++) send(r, MSG(`a${count}`), 0);
    send(r, MSG('b0'), 1);
    expect(filed(r)).toHaveLength(3);
    r.server.advance(60_000);
    expect(statsOf(r, 'ratelimit.r.per_source')[0]).toBe('ratelimit.r.per_source: origin=ratelimit per_source_allowed=3 per_source_dropped=3 per_source_evicted=0 per_source_key_tpl_evals=0 per_source_key_parse_evals=0 ');
  });

  it('evaluates a template that is not one of the plain sender properties, once per message', () => {
    const template = 'template(name="PerIpProgram" type="string" string="%fromhost-ip%|%programname%")\n';
    const r = rig(`${template}${base('')}`, { [POLICY]: perSourcePolicy('  default:\n    max: 1\n    window: 10s\n', '  enabled: true\n  keyTemplate: "PerIpProgram"\n') });
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: a');
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: b');
    send(r, '<13>Oct 19 12:00:01 ubuntu bob: c');
    expect(filed(r)).toHaveLength(2);
    r.server.advance(60_000);
    expect(statsOf(r, 'ratelimit.r.per_source')[0]).toContain('per_source_key_tpl_evals=3 ');
  });

  it('keys by hostname when the policy names no template', () => {
    const r = rig(base(''), { [POLICY]: perSourcePolicy('  default:\n    max: 2\n    window: 10s\n', '  enabled: true\n') });
    for (let count = 0; count < 3; count++) send(r, MSG(`a${count}`, 'ubuntu'));
    for (let count = 0; count < 3; count++) send(r, MSG(`b${count}`, 'other'));
    expect(filed(r)).toHaveLength(4);
  });

  it('a key may override the default maximum', () => {
    const body = '  default:\n    max: 2\n    window: 10s\n  overrides:\n    - key: "10.0.0.3"\n      max: 1\n';
    const r = rig(base(''), { [POLICY]: perSourcePolicy(body) });
    for (let count = 0; count < 3; count++) send(r, MSG(`a${count}`), 1);
    for (let count = 0; count < 3; count++) send(r, MSG(`b${count}`), 0);
    expect(filed(r).map((line) => line.split('|')[1].trim())).toEqual(['a0', 'b0', 'b1']);
  });

  it('opens a new window when the previous one has elapsed', () => {
    const r = rig(base(''), { [POLICY]: perSourcePolicy() });
    for (let count = 0; count < 3; count++) send(r, MSG(`a${count}`));
    r.server.advance(11_000);
    for (let count = 0; count < 3; count++) send(r, MSG(`c${count}`));
    expect(filed(r)).toHaveLength(4);
  });

  it('keeps at most maxStates sources per internal shard and counts the evictions', () => {
    const keys = ['10.0.0.1', '10.0.0.3', '10.0.0.4'];
    const shards = keys.map((key) => mixedHash(key) % 32);
    const r = rig(base(''), { [POLICY]: perSourcePolicy('  default:\n    max: 1\n    window: 10s\n', '  enabled: true\n  keyTemplate: "PerSourceIP"\n  maxStates: 1\n') });
    keys.forEach((_, index) => send(r, MSG(`x${index}`), index));
    r.server.advance(60_000);
    const sameShard = new Set(shards).size < keys.length;
    const evicted = Number(/per_source_evicted=(\d+)/.exec(statsOf(r, 'ratelimit.r.per_source')[0])?.[1]);
    expect(evicted).toBe(sameShard ? keys.length - new Set(shards).size : 0);
  });

  it('publishes the sources with the most drops one report after they appear', () => {
    const r = rig(base(''), { [POLICY]: perSourcePolicy('  default:\n    max: 1\n    window: 100s\n', '  enabled: true\n  keyTemplate: "PerSourceIP"\n  topN: 2\n') });
    for (let count = 0; count < 4; count++) send(r, MSG(`a${count}`), 0);
    for (let count = 0; count < 2; count++) send(r, MSG(`b${count}`), 1);
    r.server.advance(60_000);
    expect(statsOf(r, 'ratelimit.r.per_source')[0]).not.toContain('per_source_drop_');
    r.server.advance(60_000);
    expect(statsOf(r, 'ratelimit.r.per_source')[1]).toMatch(/per_source_key_parse_evals=0 per_source_drop_1_10_0_0_1=3 per_source_drop_2_10_0_0_3=1 $/);
  });

  it('the legacy parameters take a separate policy file and a key template', () => {
    const config = `${TEMPLATE}${PER_IP}ratelimit(name="r" perSource="on" perSourcePolicy="/etc/ps.yaml" perSourceKeyTpl="PerSourceIP")\n${INPUT}${FILE_ACTION}`;
    const r = rig(config, { '/etc/ps.yaml': 'default:\n  max: 2\n  window: 10s\n' });
    for (let count = 0; count < 5; count++) send(r, MSG(`a${count}`));
    expect(filed(r)).toHaveLength(2);
  });

  it('HUP reloads the legacy per-source file', () => {
    const config = `${TEMPLATE}${PER_IP}ratelimit(name="r" perSourcePolicy="/etc/ps.yaml" perSourceKeyTpl="PerSourceIP")\n${INPUT}${FILE_ACTION}`;
    const r = rig(config, { '/etc/ps.yaml': 'default:\n  max: 1\n  window: 10s\n' });
    r.server.rewrite('/etc/ps.yaml', 'default:\n  max: 3\n  window: 10s\n');
    r.srv.engine.hup();
    expect(internal(r)).toContain("ratelimit: HUP reloaded per-source policy 'r' from file '/etc/ps.yaml'");
    for (let count = 0; count < 5; count++) send(r, MSG(`a${count}`));
    expect(filed(r)).toHaveLength(3);
  });

  it('HUP applies a changed perSource section of the main policy and can switch it off', () => {
    const r = rig(base(''), { [POLICY]: perSourcePolicy() });
    r.server.rewrite(POLICY, perSourcePolicy('  default:\n    max: 4\n    window: 10s\n'));
    r.srv.engine.hup();
    for (let count = 0; count < 6; count++) send(r, MSG(`a${count}`));
    expect(filed(r)).toHaveLength(4);
    r.server.rewrite(POLICY, 'interval: 0\n');
    r.srv.engine.hup();
    for (let count = 0; count < 3; count++) send(r, MSG(`d${count}`));
    expect(filed(r)).toHaveLength(7);
  });

  it.each([
    [perSourcePolicy('  default:\n    max: 2\n', '  enabled: true\n'), 'ratelimit: policy file /etc/rl.yaml perSource section missing default.max or default.window'],
    [perSourcePolicy('  default:\n    max: x\n    window: 1s\n'), "ratelimit: invalid perSource.default.max value 'x' in /etc/rl.yaml"],
    [perSourcePolicy('  default:\n    max: 1\n    window: 1500ms\n'), "ratelimit: invalid perSource.default.window value '1500ms' in /etc/rl.yaml"],
    [perSourcePolicy('  default:\n    max: 1\n    window: 1s\n  overrides:\n    - max: 3\n'), 'ratelimit: per-source override missing key in /etc/rl.yaml'],
    [perSourcePolicy('  default:\n    max: 1\n    window: 1s\n', '  enabled: maybe\n'), "ratelimit: invalid perSource.enabled value 'maybe' in /etc/rl.yaml"],
    [perSourcePolicy('  default:\n    max: 1\n    window: 1s\n', '  keyTemplate: "Nope"\n'), "ratelimit: perSourceKeyTpl 'Nope' not found for 'r'"],
  ])('refuses the perSource section %j', (content, message) => {
    const r = rig(base(''), { [POLICY]: content });
    expect(diagnostics(r)).toContain(message);
  });

  it('refuses a perSource section mixed with the legacy parameters, and a legacy flag without a policy file', () => {
    const mixed = rig(base('', ' perSourceMaxStates="5"'), { [POLICY]: perSourcePolicy() });
    expect(diagnostics(mixed)).toContain("ratelimit: policy file '/etc/rl.yaml' contains perSource for 'r'; do not mix it with legacy perSource/perSourcePolicy/perSourceKeyTpl/maxStates/topN parameters");
    const missing = rig(`ratelimit(name="r" perSource="on")\n${INPUT}${FILE_ACTION}`);
    expect(diagnostics(missing)).toContain("ratelimit: per-source rate limiting enabled but perSourcePolicy is missing for 'r'");
  });

  it('refuses a legacy per-source file without default.max and default.window', () => {
    const r = rig(`ratelimit(name="r" perSourcePolicy="/etc/ps.yaml")\n${INPUT}${FILE_ACTION}`, { '/etc/ps.yaml': 'overrides:\n  - key: a\n    max: 1\n' });
    expect(diagnostics(r)).toContain('ratelimit: per-source policy file /etc/ps.yaml missing default.max or default.window');
  });
});

describe('ratelimit(): policyWatch', () => {
  const watched = (extra = ''): string => base('', ` policyWatch="on" policyWatchDebounce="500ms"${extra}`);

  it('reloads the file once, after the quiet period, however many events came before it', () => {
    const r = rig(watched(), { [POLICY]: 'interval: 5\nburst: 2\n' });
    r.server.rewrite(POLICY, 'interval: 5\nburst: 3\n');
    r.server.advance(100);
    r.server.rewrite(POLICY, 'interval: 5\nburst: 4\n');
    r.server.advance(400);
    expect(internal(r)).not.toContain('reloaded policy');
    r.server.advance(200);
    expect(internal(r).match(/ratelimit: policy watch reloaded policy 'r' from file '\/etc\/rl\.yaml'/g)).toHaveLength(1);
    for (let count = 0; count < 6; count++) send(r, MSG(`m${count}`));
    expect(filed(r)).toHaveLength(4);
  });

  it('falls back to HUP-only reload when the host cannot watch', () => {
    const r = rig(watched(), { [POLICY]: 'interval: 5\nburst: 2\n' }, { watchUnavailable: true });
    expect(diagnostics(r)).toContain("ratelimit: policyWatch requested for 'r' but automatic reload unavailable for policy '/etc/rl.yaml'; using HUP-only reload");
  });

  it('warns when there is nothing to watch', () => {
    const r = rig(`ratelimit(name="r" interval="5" policyWatch="on")\n${INPUT}${FILE_ACTION}`);
    expect(diagnostics(r)).toContain("ratelimit: policyWatch enabled for 'r' but no policy file is configured; using HUP-only reload");
  });

  it('refuses an unreadable debounce, which leaves the object undefined', () => {
    const r = rig(`ratelimit(name="r" interval="5" policyWatchDebounce="soon")\n${INPUT}${FILE_ACTION}`);
    expect(diagnostics(r)).toContain("ratelimit config 'r' not found");
  });
});
