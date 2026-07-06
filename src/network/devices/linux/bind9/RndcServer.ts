/**
 * `rndc` control channel — real TCP server (PRD-Nslookup-Dig-Rndc-Runas.md
 * §3.1/P8). Closes the biggest fidelity gap in `rndc`: previously
 * `RndcChannel.dispatch()` was called in-process with no network, no ACL,
 * and no authentication. `RndcServer` is the real listener, opened/closed by
 * `Bind9Service` according to the parsed `controls{}` block: it checks the
 * per-`inet` `allow{}` ACL before even looking at the message (matching real
 * `named`'s behavior of rejecting unlisted clients at the TCP layer), then
 * verifies the HMAC against every key that `inet` clause names, and only
 * then delegates to the existing, unchanged `RndcChannel.dispatch()`.
 */

import type { EndHost } from '@/network/devices/EndHost';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import type { NamedControls, NamedKey } from './NamedConfig';
import type { AclHostEnvironment } from './NamedAcl';
import type { RndcChannel } from './RndcChannel';
import type { RndcRequest, RndcResponse, RndcWireEnvelope } from './RndcWireCodec';
import { decodeRndcEnvelope, encodeRndcEnvelope, verifyRndcEnvelope, signRndcEnvelope } from './RndcWireCodec';

const WILDCARD_ADDRESS = '0.0.0.0';
const NOT_AUTHENTICATED = 1;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class RndcServer {
  private readonly listening: { readonly ip: string; readonly port: number }[] = [];
  private running = false;

  constructor(
    private readonly host: EndHost,
    private readonly channel: RndcChannel,
    private readonly controls: readonly NamedControls[],
    private readonly keys: ReadonlyMap<string, NamedKey>,
    private readonly aclEnvironment: () => AclHostEnvironment,
  ) {}

  start(): void {
    if (this.running || this.controls.length === 0) return;
    for (const control of this.controls) {
      const listenIp = control.address === '*' ? WILDCARD_ADDRESS : control.address;
      this.host.getTcpStack().listen(
        control.port,
        { onAccept: (socket) => this.handleConnection(socket, control) },
        listenIp,
      );
      this.listening.push({ ip: listenIp, port: control.port });
    }
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    for (const { ip, port } of this.listening) this.host.getTcpStack().closeListener(port, ip);
    this.listening.length = 0;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private handleConnection(socket: TcpSocket, control: NamedControls): void {
    if (!control.allow.matches(socket.remoteIp, this.aclEnvironment())) {
      socket.close();
      return;
    }

    let buffer = new Uint8Array(0);
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      buffer = concat(buffer, data);
      for (;;) {
        let decoded;
        try {
          decoded = decodeRndcEnvelope(buffer);
        } catch {
          socket.close();
          return;
        }
        if (!decoded) break;
        buffer = buffer.subarray(decoded.consumed);
        this.handleRequest(socket, decoded.envelope, control);
      }
    });
  }

  private handleRequest(socket: TcpSocket, envelope: RndcWireEnvelope, control: NamedControls): void {
    const payload = envelope.payload;
    if (!('command' in payload)) return;
    const request = payload as RndcRequest;

    const matchedKey = this.authenticate(envelope, control);
    if (!matchedKey) {
      this.reply(socket, { nonce: request.nonce, result: NOT_AUTHENTICATED, text: 'not authenticated' }, null);
      socket.close();
      return;
    }

    const args = request.command.split(/\s+/).filter((s) => s.length > 0);
    const text = this.channel.dispatch(args);
    this.reply(socket, { nonce: request.nonce, result: 0, text }, matchedKey);
  }

  /** Tries every key the connecting `inet` clause names; the first that verifies wins. */
  private authenticate(envelope: RndcWireEnvelope, control: NamedControls): NamedKey | null {
    for (const name of control.keys) {
      const key = this.keys.get(name);
      if (!key) continue;
      if (verifyRndcEnvelope(envelope, key.algorithm, key.secret)) return key;
    }
    return null;
  }

  /** Signs with the key that authenticated the request; an unauthenticated reply carries an empty HMAC (the client already knows to distrust it — `result` says so). */
  private reply(socket: TcpSocket, response: RndcResponse, key: NamedKey | null): void {
    const envelope = key ? signRndcEnvelope(response, key.algorithm, key.secret) : { hmac: '', payload: response };
    socket.send(encodeRndcEnvelope(envelope));
  }
}
