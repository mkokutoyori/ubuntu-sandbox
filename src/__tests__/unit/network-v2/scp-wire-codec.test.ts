/**
 * SCP real wire protocol (PRD-FTP-SFTP.md §2.1.19/P18) — `ScpWireCodec.ts`
 * is tested standalone (control-line/ack byte round-trips);
 * the transfer itself is covered by `scp-roles.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import {
  encodeScpControlLine, decodeScpControlLine, encodeScpAck, decodeScpAck, scpModeString, SCP_ACK,
  type ScpControlLine,
} from '@/network/protocols/ssh/scp/ScpWireCodec';

beforeEach(() => {
  resetCounters();
});

describe('ScpWireCodec — control-line round-trips (§2.1.19/P18)', () => {
  it('round-trips a C (file) control line', () => {
    const line: ScpControlLine = { kind: 'C', mode: '0644', size: 13, name: 'test.txt' };
    const encoded = encodeScpControlLine(line);
    expect(encoded).toBe('C0644 13 test.txt\n');
    expect(decodeScpControlLine(encoded)).toEqual(line);
  });

  it('round-trips a D (enter directory) control line', () => {
    const line: ScpControlLine = { kind: 'D', mode: '0755', name: 'subdir' };
    const encoded = encodeScpControlLine(line);
    expect(encoded).toBe('D0755 0 subdir\n');
    expect(decodeScpControlLine(encoded)).toEqual(line);
  });

  it('round-trips an E (leave directory) control line', () => {
    const line: ScpControlLine = { kind: 'E', mode: '', name: '' };
    const encoded = encodeScpControlLine(line);
    expect(encoded).toBe('E\n');
    expect(decodeScpControlLine(encoded)).toEqual(line);
  });

  it('decodes a control line whether or not the trailing newline is included', () => {
    expect(decodeScpControlLine('C0644 5 a.txt')).toEqual({ kind: 'C', mode: '0644', size: 5, name: 'a.txt' });
    expect(decodeScpControlLine('C0644 5 a.txt\n')).toEqual({ kind: 'C', mode: '0644', size: 5, name: 'a.txt' });
  });

  it('rejects malformed control lines', () => {
    expect(decodeScpControlLine('X0644 5 a.txt')).toBeNull();
    expect(decodeScpControlLine('C99 5 a.txt')).toBeNull();
    expect(decodeScpControlLine('garbage')).toBeNull();
  });

  it('scpModeString formats a numeric mode as a 4-digit octal string', () => {
    expect(scpModeString(0o644)).toBe('0644');
    expect(scpModeString(0o755)).toBe('0755');
    expect(scpModeString(0o600)).toBe('0600');
  });
});

describe('ScpWireCodec — ack byte round-trips', () => {
  it('round-trips SCP_ACK.OK as a single zero byte', () => {
    const bytes = encodeScpAck(SCP_ACK.OK);
    expect(Array.from(bytes)).toEqual([0]);
    expect(decodeScpAck(bytes)).toEqual({ ack: 0 });
  });

  it('round-trips a warning ack with a message', () => {
    const bytes = encodeScpAck(SCP_ACK.WARNING, 'partial transfer');
    expect(bytes[0]).toBe(1);
    expect(decodeScpAck(bytes)).toEqual({ ack: 1, message: 'partial transfer' });
  });

  it('round-trips a fatal ack with a message', () => {
    const bytes = encodeScpAck(SCP_ACK.FATAL, 'scp: /root/x: Permission denied');
    expect(bytes[0]).toBe(2);
    expect(decodeScpAck(bytes)).toEqual({ ack: 2, message: 'scp: /root/x: Permission denied' });
  });

  it('rejects an empty or out-of-range ack byte sequence', () => {
    expect(decodeScpAck(new Uint8Array([]))).toBeNull();
    expect(decodeScpAck(new Uint8Array([9]))).toBeNull();
  });
});
