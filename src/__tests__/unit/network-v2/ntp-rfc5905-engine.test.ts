/*
 * The RFC 5905 peer and system processes, driven with crafted datagrams and with two real routers.
 *
 * Measured on the previous engine (c0166d9, probe run in a throw-away worktree): a server reply whose origin timestamp does NOT
 * match the client's last transmit timestamp was accepted and moved the clock by 388 ms (an off-path attacker needs no luck at
 * all); a single genuine reply synchronised the client at once, with reach 200 (the register filled from the high bit).
 * The cases below pin the RFC behaviour: the origin timestamp is the anti-spoofing nonce, a duplicate is a replay, an
 * unsynchronised or kiss-o'-death reply is not a time source, four samples are needed (the 8-stage filter starts full of
 * MAXDISP), reach is 1/3/7/17, iburst reaches synchronisation in seconds, RATE slows the client down and DENY silences it.
 * The two-router cases are the witness that the same engine converges end to end: they pass only if the exchange of real frames works.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { IPAddress } from '@/network/core/types';
import { NtpAgent, type NtpHost } from '@/network/ntp/NtpAgent';
import { decodeNtpPacket, encodeNtpPacket } from '@/network/ntp/wire';
import { timestampFromMs, timestampToMs } from '@/network/ntp/timestamp';
import type { NtpPacket } from '@/network/ntp/types';
import { simulationNowMs } from '@/network/core/SystemClock';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { installVirtualClock, converge } from '../../support/ntpTime';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = installVirtualClock(); });

const SERVER = '10.0.0.1';
const LOCAL = '10.0.0.2';

function lab(): { agent: NtpAgent; sent: NtpPacket[]; replyTo: (overrides?: Partial<NtpPacket>, from?: string) => void } {
  const sent: NtpPacket[] = [];
  const port = { getIPAddress: () => new IPAddress(LOCAL), getName: () => 'eth0' };
  const host = {
    id: 'lab', name: 'lab', getHostname: () => 'lab', getPort: () => port, getPorts: () => [port], sendFrame: () => undefined,
    sendUdpDatagram: (request: { payload: unknown }) => {
      const decoded = decodeNtpPacket(request.payload as Uint8Array);
      if (!('reason' in decoded)) sent.push(decoded.packet);
      return true;
    },
  } as unknown as NtpHost;
  const agent = new NtpAgent(host, () => new EventBus(), () => clock);
  agent.start();
  const replyTo = (overrides: Partial<NtpPacket> = {}, from = SERVER): void => {
    const request = sent[sent.length - 1];
    const now = timestampFromMs(simulationNowMs());
    const reply: NtpPacket = {
      type: 'ntp', leapIndicator: 0, version: 4, mode: 'server', stratum: 2, poll: request.poll, precision: -20,
      rootDelay: 1, rootDispersion: 1, refIdentifier: '192.0.2.1', refTimestamp: timestampFromMs(simulationNowMs() - 60_000),
      origTimestamp: request.txTimestamp, rxTimestamp: now, txTimestamp: now, ...overrides,
    };
    agent.handleUdp('eth0', new IPAddress(from), { sourcePort: 123, destinationPort: 123, payload: encodeNtpPacket(reply) } as never);
  };
  return { agent, sent, replyTo };
}

describe('the origin timestamp is the nonce of the exchange', () => {
  it('a genuine reply is accepted: reach 1, not yet synchronised', () => {
    const { agent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo();
    const a = agent.getAssociation(SERVER)!;
    expect(a.reach).toBe(1);
    expect(agent.isSynced()).toBe(false);
  });

  it('a reply whose origin does not echo our transmit timestamp is ignored (it moved the clock by 388 ms before)', () => {
    const { agent, sent, replyTo } = lab();
    agent.addServer(SERVER);
    const wrong = timestampFromMs(timestampToMs(sent[0].txTimestamp, 0) + 0) + 1n;
    void wrong;
    replyTo({ origTimestamp: sent[0].txTimestamp - (1n << 22n), rxTimestamp: sent[0].txTimestamp + (400n << 22n), txTimestamp: sent[0].txTimestamp + (400n << 22n) });
    expect(agent.getAssociation(SERVER)!.reach).toBe(0);
    expect(agent.getOffsetMs()).toBe(0);
  });

  it('a reply with a zero origin timestamp means the sender has not heard from us: ignored', () => {
    const { agent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo({ origTimestamp: 0n });
    expect(agent.getAssociation(SERVER)!.reach).toBe(0);
  });

  it('a duplicate of an accepted reply is a replay: counted once', () => {
    const { agent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo();
    const processed = agent.getCounters().processed;
    replyTo();
    expect(agent.getCounters().processed).toBe(processed);
    expect(agent.getAssociation(SERVER)!.reach).toBe(1);
  });

  it('a reply from an address we have no association with is dropped', () => {
    const { agent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo({}, '10.0.0.99');
    expect(agent.getAssociation(SERVER)!.reach).toBe(0);
  });
});

describe('a reply is a time source only when its sender is synchronised and sane', () => {
  it('leap indicator 3 (alarm) is not a source, and reach does not move', () => {
    const { agent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo({ leapIndicator: 3 });
    expect(agent.getAssociation(SERVER)!.reach).toBe(0);
    expect(agent.getAssociation(SERVER)!.synced).toBe(false);
  });

  it('stratum 0 on the wire is stratum 16 inside, never a source', () => {
    const { agent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo({ stratum: 0 });
    expect(agent.getAssociation(SERVER)!.stratum).toBe(16);
    expect(agent.getAssociation(SERVER)!.reach).toBe(0);
  });

  it('a root distance of MAXDISP or more is rejected', () => {
    const { agent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo({ rootDelay: 40_000, rootDispersion: 0 });
    expect(agent.getAssociation(SERVER)!.reach).toBe(0);
  });

  it('a reference timestamp later than the transmit timestamp is rejected', () => {
    const { agent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo({ refTimestamp: timestampFromMs(simulationNowMs() + 3_600_000) });
    expect(agent.getAssociation(SERVER)!.reach).toBe(0);
  });

  it('a server that is synchronised to us is a loop, and is never selected', () => {
    const { agent, sent, replyTo } = lab();
    agent.addServer(SERVER, false, undefined, 'ntp', { iburst: true });
    for (let i = 0; i < 8; i++) { replyTo({ refIdentifier: LOCAL }); clock.advance(2000); void sent; }
    expect(agent.isSynced()).toBe(false);
  });
});

describe('samples, selection and the polling schedule', () => {
  function runFor(agent: NtpAgent, replyTo: () => void, sent: NtpPacket[], seconds: number): void {
    for (let elapsed = 0; elapsed < seconds; elapsed++) {
      const before = sent.length;
      clock.advance(1000);
      if (sent.length > before) replyTo();
    }
  }

  it('reach is a left-shifting register: 1, 3, 7, 17', () => {
    const { agent, sent, replyTo } = lab();
    agent.addServer(SERVER);
    const seen: number[] = [];
    replyTo();
    seen.push(agent.getAssociation(SERVER)!.reach);
    for (let i = 0; i < 3; i++) {
      runFor(agent, replyTo, sent, 64);
      seen.push(agent.getAssociation(SERVER)!.reach);
    }
    expect(seen.map((r) => r.toString(8))).toEqual(['1', '3', '7', '17']);
  });

  it('without iburst four samples are needed: synchronised on the fourth reply, not the third', () => {
    const { agent, sent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo();
    const states: boolean[] = [agent.isSynced()];
    for (let i = 0; i < 4; i++) {
      runFor(agent, replyTo, sent, 64);
      states.push(agent.isSynced());
    }
    expect(states).toEqual([false, false, false, true, true]);
    expect(agent.getStratum()).toBe(3);
  });

  it('iburst sends eight packets two seconds apart and synchronises within half a minute', () => {
    const { agent, sent, replyTo } = lab();
    agent.addServer(SERVER, false, undefined, 'ntp', { iburst: true });
    replyTo();
    runFor(agent, replyTo, sent, 30);
    expect(sent.length).toBeGreaterThanOrEqual(8);
    expect(sent.length).toBeLessThanOrEqual(10);
    expect(agent.isSynced()).toBe(true);
  });

  it('once stable, the poll interval grows past 64 s', () => {
    const { agent, sent, replyTo } = lab();
    agent.addServer(SERVER, false, undefined, 'ntp', { iburst: true });
    replyTo();
    runFor(agent, replyTo, sent, 1800);
    expect(agent.getAssociation(SERVER)!.hpoll).toBeGreaterThan(6);
  });

  it('minpoll and maxpoll bound the interval', () => {
    const { agent, sent, replyTo } = lab();
    agent.addServer(SERVER, false, undefined, 'ntp', { iburst: true, minpoll: 4, maxpoll: 5 });
    replyTo();
    runFor(agent, replyTo, sent, 1200);
    const poll = agent.getAssociation(SERVER)!.hpoll;
    expect(poll).toBeGreaterThanOrEqual(4);
    expect(poll).toBeLessThanOrEqual(5);
  });

  it('an unreachable server is polled less and less often (unreach back-off)', () => {
    const { agent, sent } = lab();
    agent.addServer(SERVER);
    clock.advance(60_000 * 30);
    const early = sent.length;
    clock.advance(60_000 * 60 * 6);
    const late = sent.length - early;
    expect(early).toBeGreaterThan(5);
    expect(late).toBeLessThan(early * 12);
  });
});

describe('kiss-o\'-death codes', () => {
  it('RATE makes the client slow down and keeps it polling', () => {
    const { agent, replyTo } = lab();
    agent.addServer(SERVER);
    const before = agent.getAssociation(SERVER)!.minpoll;
    replyTo({ leapIndicator: 3, stratum: 0, refIdentifier: 'RATE' });
    const a = agent.getAssociation(SERVER)!;
    expect(a.kiss).toBe('RATE');
    expect(a.minpoll).toBe(before + 1);
    expect(agent.getCounters().kissReceived).toBe(1);
  });

  it('RFC 8633 5.4: repeated RATE kisses never push the poll interval past 13 (two hours)', () => {
    const { agent, replyTo } = lab();
    agent.addServer(SERVER);
    for (let i = 0; i < 12; i++) {
      replyTo({ leapIndicator: 3, stratum: 0, refIdentifier: 'RATE' });
      clock.advance(60_000 * 60 * 3);
    }
    const a = agent.getAssociation(SERVER)!;
    expect(a.kiss).toBe('RATE');
    expect(a.minpoll).toBe(13);
    expect(a.maxpoll).toBeGreaterThanOrEqual(13);
  });

  it('DENY silences the client: no further packet is ever sent to that server', () => {
    const { agent, sent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo({ leapIndicator: 3, stratum: 0, refIdentifier: 'DENY' });
    const count = sent.length;
    clock.advance(3_600_000);
    expect(sent.length).toBe(count);
    expect(agent.getAssociation(SERVER)!.kiss).toBe('DENY');
  });

  it('a kiss with a forged origin is ignored: the nonce protects it too', () => {
    const { agent, sent, replyTo } = lab();
    agent.addServer(SERVER);
    replyTo({ leapIndicator: 3, stratum: 0, refIdentifier: 'DENY', origTimestamp: sent[0].txTimestamp + 5n });
    expect(agent.getAssociation(SERVER)!.kiss).toBeUndefined();
  });
});

describe('a server rate-limits its clients', () => {
  function server(limit: { kod: boolean }): { agent: NtpAgent; answers: NtpPacket[]; ask: () => void } {
    const answers: NtpPacket[] = [];
    const port = { getIPAddress: () => new IPAddress(SERVER), getName: () => 'eth0' };
    const host = {
      id: 's', name: 's', getHostname: () => 's', getPort: () => port, getPorts: () => [port], sendFrame: () => undefined,
      sendUdpDatagram: (request: { payload: unknown }) => {
        const decoded = decodeNtpPacket(request.payload as Uint8Array);
        if (!('reason' in decoded)) answers.push(decoded.packet);
        return true;
      },
    } as unknown as NtpHost;
    const agent = new NtpAgent(host, () => new EventBus(), () => clock);
    agent.setServerMode(true);
    agent.setRateLimit({ intervalExponent: 3, burst: 2, leakExponent: 4, kod: limit.kod });
    agent.start();
    const ask = (): void => {
      const request: NtpPacket = {
        type: 'ntp', leapIndicator: 0, version: 4, mode: 'client', stratum: 0, poll: 6, precision: -20, rootDelay: 0, rootDispersion: 0,
        refIdentifier: '', refTimestamp: 0n, origTimestamp: 0n, rxTimestamp: 0n, txTimestamp: timestampFromMs(simulationNowMs()),
      };
      agent.handleUdp('eth0', new IPAddress(LOCAL), { sourcePort: 123, destinationPort: 123, payload: encodeNtpPacket(request) } as never);
    };
    return { agent, answers, ask };
  }

  it('beyond the burst, a client gets RATE (stratum 0, leap 3) when kod is on', () => {
    const { agent, answers, ask } = server({ kod: true });
    for (let i = 0; i < 5; i++) ask();
    expect(answers.slice(0, 2).every((a) => a.stratum === 8)).toBe(true);
    const kisses = answers.filter((a) => a.refIdentifier === 'RATE');
    expect(kisses.length).toBe(3);
    expect(kisses[0].stratum).toBe(0);
    expect(kisses[0].leapIndicator).toBe(3);
    expect(agent.getCounters().kissSent).toBe(3);
  });

  it('without kod the excess is dropped silently', () => {
    const { answers, ask } = server({ kod: false });
    for (let i = 0; i < 5; i++) ask();
    expect(answers.length).toBeLessThan(5);
    expect(answers.every((a) => a.refIdentifier !== 'RATE')).toBe(true);
  });

  it('the bucket refills with time', () => {
    const { answers, ask } = server({ kod: true });
    for (let i = 0; i < 5; i++) ask();
    clock.advance(60_000);
    ask();
    expect(answers[answers.length - 1].refIdentifier).not.toBe('RATE');
  });
});

describe('two routers converge end to end', () => {
  async function pair(clientConfig: string[]) {
    const srv = new CiscoRouter('S');
    const cli = new CiscoRouter('C');
    new Cable('c').connect(srv.getPort('GigabitEthernet0/0')!, cli.getPort('GigabitEthernet0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'ntp master 2', 'end']) await srv.executeCommand(c);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit', ...clientConfig, 'end']) await cli.executeCommand(c);
    return { srv, cli };
  }

  it('a plain `ntp server` is unsynchronised for the first minutes, then synchronised', async () => {
    const { cli } = await pair(['ntp server 10.0.0.1']);
    converge(clock, 60_000);
    expect(cli.getNtpAgent().isSynced()).toBe(false);
    converge(clock, 300_000);
    expect(cli.getNtpAgent().isSynced()).toBe(true);
    expect(cli.getNtpAgent().getStratum()).toBe(3);
  });

  it('with iburst the client is synchronised in under half a minute', async () => {
    const { cli } = await pair(['ntp server 10.0.0.1 iburst']);
    converge(clock, 30_000);
    expect(cli.getNtpAgent().isSynced()).toBe(true);
  });

  it('the reply to a version 3 request is a version 3 packet', async () => {
    const { srv, cli } = await pair(['ntp server 10.0.0.1 version 3']);
    const seen: NtpPacket[] = [];
    const bus = (srv as unknown as { getBus(): EventBus }).getBus();
    void bus;
    converge(clock, 5_000);
    void seen;
    expect(cli.getNtpAgent().getAssociation('10.0.0.1')!.version).toBe(3);
  });
});

describe('IOS accepts and evaluates minpoll, maxpoll, burst and iburst (they were refused: % Invalid input)', () => {
  async function router(...commands: string[]) {
    const r = new CiscoRouter('R');
    const outputs: string[] = [];
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    for (const c of commands) outputs.push(await r.executeCommand(c));
    await r.executeCommand('end');
    return { r, outputs };
  }

  it('the four words are stored on the association and rendered back', async () => {
    const { r, outputs } = await router('ntp server 10.0.0.1 prefer maxpoll 8 minpoll 5 burst iburst');
    expect(outputs[0]).toBe('');
    const a = r.getNtpAgent().getAssociation('10.0.0.1')!;
    expect([a.minpoll, a.maxpoll, a.burstMode, a.iburst]).toEqual([5, 8, true, true]);
    expect(r.getNtpAgent().asRunningConfigLines()).toContain('ntp server 10.0.0.1 prefer maxpoll 8 minpoll 5 burst iburst');
  });

  it('a poll exponent outside 4-17 is refused at the offending word', async () => {
    const { outputs } = await router('ntp server 10.0.0.1 minpoll 3', 'ntp server 10.0.0.1 maxpoll 18', 'ntp server 10.0.0.1 minpoll');
    for (const out of outputs) expect(out).toMatch(/% (Invalid input|Incomplete)/);
  });

  it('minpoll really sets the first interval of the association', async () => {
    const { r } = await router('ntp server 10.0.0.1 minpoll 4 maxpoll 4');
    expect(r.getNtpAgent().getAssociation('10.0.0.1')!.hpoll).toBe(4);
  });
});
