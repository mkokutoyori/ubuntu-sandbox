import { describe, it, expect } from 'vitest';
import { TtlsPapInnerAuthServer, TtlsPapInnerAuthPeer } from '@/network/radius/eaptls/TtlsInnerAuth';
import { PeapMd5InnerAuthServer, PeapMd5InnerAuthPeer } from '@/network/radius/eaptls/PeapInnerAuth';
import type { RadiusUser } from '@/network/radius/types';

function usersMap(...users: RadiusUser[]): Map<string, RadiusUser> {
  return new Map(users.map((u) => [u.username, u]));
}

/** Drives an InnerAuthServer/InnerAuthPeer pair to a terminal result. */
function runInner(
  server: { start(): Uint8Array; handle(i: Uint8Array): { next: Uint8Array | null; result: 'accept' | 'reject' | null } },
  peer: { handle(i: Uint8Array): { next: Uint8Array; result: 'success' | 'failure' | null } },
): 'accept' | 'reject' {
  let toPeer = server.start();
  for (let round = 0; round < 20; round++) {
    const peerOut = peer.handle(toPeer);
    const serverOut = server.handle(peerOut.next);
    if (serverOut.result !== null) return serverOut.result;
    toPeer = serverOut.next!;
  }
  throw new Error('inner auth did not converge');
}

describe('TTLS inner PAP', () => {
  it('accepts the correct username/password', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new TtlsPapInnerAuthServer((u) => users.get(u));
    const peer = new TtlsPapInnerAuthPeer('alice', 'wonderland');
    expect(runInner(server, peer)).toBe('accept');
  });

  it('rejects a wrong password', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new TtlsPapInnerAuthServer((u) => users.get(u));
    const peer = new TtlsPapInnerAuthPeer('alice', 'wrong');
    expect(runInner(server, peer)).toBe('reject');
  });

  it('rejects an unknown user', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new TtlsPapInnerAuthServer((u) => users.get(u));
    const peer = new TtlsPapInnerAuthPeer('mallory', 'whatever');
    expect(runInner(server, peer)).toBe('reject');
  });
});

describe('PEAP inner EAP-MD5', () => {
  it('accepts the correct password', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new PeapMd5InnerAuthServer((u) => users.get(u));
    const peer = new PeapMd5InnerAuthPeer('alice', 'wonderland');
    expect(runInner(server, peer)).toBe('accept');
  });

  it('rejects a wrong password', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new PeapMd5InnerAuthServer((u) => users.get(u));
    const peer = new PeapMd5InnerAuthPeer('alice', 'not-the-password');
    expect(runInner(server, peer)).toBe('reject');
  });

  it('rejects an unknown identity', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new PeapMd5InnerAuthServer((u) => users.get(u));
    const peer = new PeapMd5InnerAuthPeer('bob', 'whatever');
    expect(runInner(server, peer)).toBe('reject');
  });
});
