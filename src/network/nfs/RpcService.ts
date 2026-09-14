import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import {
  AUTH_NONE, RPC_VERSION, RpcAcceptState, RpcReplyState, decodeRpcCall, encodeRpcReply,
  frameRecord, readRecord, type RpcCall, type RpcReply,
} from './wire/RpcMessage';

export interface RpcCallContext {
  readonly call: RpcCall;
  readonly peerIp: string;
  readonly peerPort: number;
}

export interface RpcProgramHandler {
  readonly program: number;
  readonly lowVersion: number;
  readonly highVersion: number;
  hasProcedure(version: number, procedure: number): boolean;
  invoke(context: RpcCallContext): Uint8Array;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const text = String(data);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

export class RpcService {
  private listener: TcpListener | null = null;
  private readonly programs = new Map<number, RpcProgramHandler>();

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly port: number,
  ) {}

  register(handler: RpcProgramHandler): void {
    this.programs.set(handler.program, handler);
  }

  unregister(program: number): void {
    this.programs.delete(program);
  }

  get boundPort(): number {
    return this.port;
  }

  start(identity?: ListenerIdentity): boolean {
    if (this.listener) return true;
    try {
      this.listener = this.tcpStack.listen(this.port, {
        onAccept: (socket) => this.serve(socket),
        identity,
      });
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (!this.listener) return;
    this.tcpStack.closeListener(this.port);
    this.listener = null;
  }

  private serve(socket: TcpSocket): void {
    let pending = new Uint8Array(0);
    socket.onData((data) => {
      pending = concat(pending, toBytes(data));
      for (;;) {
        const record = readRecord(pending);
        if (!record) return;
        pending = pending.subarray(record.consumed);
        const reply = this.dispatch(record.message, socket);
        socket.send(frameRecord(encodeRpcReply(reply)));
      }
    });
  }

  private dispatch(message: Uint8Array, socket: TcpSocket): RpcReply {
    let call: RpcCall;
    try {
      call = decodeRpcCall(message);
    } catch {
      return {
        xid: 0,
        state: RpcReplyState.MSG_ACCEPTED,
        verifier: AUTH_NONE,
        acceptState: RpcAcceptState.GARBAGE_ARGS,
      };
    }
    if (call.rpcVersion !== RPC_VERSION) {
      return {
        xid: call.xid,
        state: RpcReplyState.MSG_DENIED,
        rejectState: 0,
        lowVersion: RPC_VERSION,
        highVersion: RPC_VERSION,
      };
    }
    const handler = this.programs.get(call.program);
    if (!handler) {
      return {
        xid: call.xid,
        state: RpcReplyState.MSG_ACCEPTED,
        verifier: AUTH_NONE,
        acceptState: RpcAcceptState.PROG_UNAVAIL,
      };
    }
    if (call.programVersion < handler.lowVersion || call.programVersion > handler.highVersion) {
      return {
        xid: call.xid,
        state: RpcReplyState.MSG_ACCEPTED,
        verifier: AUTH_NONE,
        acceptState: RpcAcceptState.PROG_MISMATCH,
        lowVersion: handler.lowVersion,
        highVersion: handler.highVersion,
      };
    }
    if (!handler.hasProcedure(call.programVersion, call.procedure)) {
      return {
        xid: call.xid,
        state: RpcReplyState.MSG_ACCEPTED,
        verifier: AUTH_NONE,
        acceptState: RpcAcceptState.PROC_UNAVAIL,
      };
    }
    try {
      const payload = handler.invoke({
        call, peerIp: socket.remoteIp, peerPort: socket.remotePort,
      });
      return {
        xid: call.xid,
        state: RpcReplyState.MSG_ACCEPTED,
        verifier: AUTH_NONE,
        acceptState: RpcAcceptState.SUCCESS,
        payload,
      };
    } catch {
      return {
        xid: call.xid,
        state: RpcReplyState.MSG_ACCEPTED,
        verifier: AUTH_NONE,
        acceptState: RpcAcceptState.GARBAGE_ARGS,
      };
    }
  }
}
