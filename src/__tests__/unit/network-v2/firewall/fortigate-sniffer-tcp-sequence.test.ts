/*
 * Probe — `diagnose sniffer packet` prints the TCP sequence and
 * acknowledgement numbers the segment really carries.
 *
 * Before: the renderer read the segment as the legacy core `TCPPacket`
 * (`sequenceNumber`, `acknowledgementNumber`) while the TCP stack puts a
 * `TcpSegment` (`sequence`, `acknowledgement`) on the wire, so every TCP
 * line read "syn undefined" and a SYN-ACK "syn undefined ack undefined";
 * a pure ACK read "ack <seq> ack <ack>"; and the stack drew its initial
 * sequence number with a XOR, a signed 32-bit result, so about one SYN in
 * two carried a negative number.
 *
 * Authority: FortiOS "diagnose sniffer packet" at verbosity 4, as shown in
 * Fortinet's troubleshooting examples (recalled — docs.fortinet.com is not
 * reachable from this environment): "<src>.<port> -> <dst>.<port>: syn
 * <seq>", "syn <seq> ack <ack>" for the answer, "ack <ack>" for a pure ACK.
 * RFC 9293 §3.4.1: a sequence number is an unsigned 32-bit value.
 *
 * Measured before the change (git stash of src/network/devices/firewall and
 * src/network/tcp): 4 of the 5 cases fail.
 * Passing either way:
 *   - "the handshake is captured" is the WITNESS: the lab puts the SYN and
 *     the SYN-ACK on port2, so the other cases measure the numbers only.
 * "a SYN carries its sequence number" also failed on "undefined" before;
 * the sign of the old ISN alone would have made it fail one run in two.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { nextIsn } from '@/network/tcp/types';

const run = (device: unknown, command: string): Promise<string> =>
  (device as { executeCommand(c: string): Promise<string> }).executeCommand(command);

async function capturedHandshake(): Promise<string> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  pc.powerOn();
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await run(pc, 'ip link set eth0 up');
  await run(pc, 'ip addr add 192.168.10.10/24 dev eth0');
  for (const line of ['config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping http', 'next', 'end']) await run(fgt, line);
  await run(pc, 'curl -s -o /dev/null --connect-timeout 3 http://192.168.10.1/');
  return run(fgt, "diagnose sniffer packet port2 'tcp' 4 10");
}

describe('the sniffer prints real TCP numbers', () => {
  it('the handshake is captured', async () => {
    const trace = await capturedHandshake();
    expect(trace).toMatch(/192\.168\.10\.10\.\d+ -> 192\.168\.10\.1\.80: syn/);
    expect(trace).toMatch(/192\.168\.10\.1\.80 -> 192\.168\.10\.10\.\d+: syn/);
  });

  it('a SYN carries its sequence number', async () => {
    const trace = await capturedHandshake();
    expect(trace).toMatch(/192\.168\.10\.10\.\d+ -> 192\.168\.10\.1\.80: syn \d+$/m);
  });

  it('a SYN-ACK carries its sequence and the acknowledgement of the SYN', async () => {
    const trace = await capturedHandshake();
    const syn = /192\.168\.10\.10\.\d+ -> 192\.168\.10\.1\.80: syn (\d+)$/m.exec(trace);
    const synAck = /192\.168\.10\.1\.80 -> 192\.168\.10\.10\.\d+: syn \d+ ack (\d+)$/m.exec(trace);
    expect(syn).not.toBeNull();
    expect(synAck).not.toBeNull();
    expect(Number(synAck![1])).toBe((Number(syn![1]) + 1) >>> 0);
  });

  it('a pure ACK shows the acknowledgement number alone', async () => {
    const trace = await capturedHandshake();
    expect(trace).toMatch(/192\.168\.10\.10\.\d+ -> 192\.168\.10\.1\.80: ack \d+$/m);
    expect(trace).not.toMatch(/: ack \d+ ack /);
  });

  it('an initial sequence number is an unsigned 32-bit value', () => {
    const draws = Array.from({ length: 200 }, () => nextIsn());
    expect(draws.every((isn) => Number.isInteger(isn) && isn >= 0 && isn <= 0xffffffff)).toBe(true);
  });
});
