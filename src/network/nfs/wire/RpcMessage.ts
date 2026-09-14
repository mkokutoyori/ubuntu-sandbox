import { XdrReader, XdrWriter, XdrError } from './Xdr';

export const RPC_VERSION = 2;

export enum RpcMessageType {
  CALL = 0,
  REPLY = 1,
}

export enum RpcReplyState {
  MSG_ACCEPTED = 0,
  MSG_DENIED = 1,
}

export enum RpcAcceptState {
  SUCCESS = 0,
  PROG_UNAVAIL = 1,
  PROG_MISMATCH = 2,
  PROC_UNAVAIL = 3,
  GARBAGE_ARGS = 4,
  SYSTEM_ERR = 5,
}

export enum RpcRejectState {
  RPC_MISMATCH = 0,
  AUTH_ERROR = 1,
}

export enum RpcAuthState {
  AUTH_OK = 0,
  AUTH_BADCRED = 1,
  AUTH_REJECTEDCRED = 2,
  AUTH_BADVERF = 3,
  AUTH_REJECTEDVERF = 4,
  AUTH_TOOWEAK = 5,
  AUTH_INVALIDRESP = 6,
  AUTH_FAILED = 7,
}

export enum RpcAuthFlavor {
  AUTH_NONE = 0,
  AUTH_SYS = 1,
  AUTH_SHORT = 2,
  AUTH_DH = 3,
  RPCSEC_GSS = 6,
}

export const RPC_MAX_AUTH_SIZE = 400;
export const RPC_MAX_MACHINENAME = 255;
export const RPC_MAX_GROUPS = 16;
export const RPC_LAST_FRAGMENT = 0x80000000;
export const RPC_FRAGMENT_SIZE_MASK = 0x7fffffff;

export interface RpcOpaqueAuth {
  readonly flavor: RpcAuthFlavor;
  readonly body: Uint8Array;
}

export interface AuthSysParams {
  readonly stamp: number;
  readonly machineName: string;
  readonly uid: number;
  readonly gid: number;
  readonly gids: readonly number[];
}

export const AUTH_NONE: RpcOpaqueAuth = { flavor: RpcAuthFlavor.AUTH_NONE, body: new Uint8Array(0) };

export function encodeAuthSys(params: AuthSysParams): RpcOpaqueAuth {
  if (params.machineName.length > RPC_MAX_MACHINENAME) {
    throw new XdrError(`AUTH_SYS machine name of ${params.machineName.length} bytes exceeds ${RPC_MAX_MACHINENAME}`);
  }
  if (params.gids.length > RPC_MAX_GROUPS) {
    throw new XdrError(`AUTH_SYS carries ${params.gids.length} groups, the limit is ${RPC_MAX_GROUPS}`);
  }
  const writer = new XdrWriter();
  writer.uint32(params.stamp);
  writer.string(params.machineName);
  writer.uint32(params.uid);
  writer.uint32(params.gid);
  writer.array(params.gids, (w, g) => w.uint32(g));
  const body = writer.toBytes();
  if (body.length > RPC_MAX_AUTH_SIZE) {
    throw new XdrError(`AUTH_SYS credential of ${body.length} bytes exceeds ${RPC_MAX_AUTH_SIZE}`);
  }
  return { flavor: RpcAuthFlavor.AUTH_SYS, body };
}

export function decodeAuthSys(auth: RpcOpaqueAuth): AuthSysParams | null {
  if (auth.flavor !== RpcAuthFlavor.AUTH_SYS) return null;
  const reader = new XdrReader(auth.body);
  const stamp = reader.uint32();
  const machineName = reader.string(RPC_MAX_MACHINENAME);
  const uid = reader.uint32();
  const gid = reader.uint32();
  const gids = reader.array((r) => r.uint32());
  return { stamp, machineName, uid, gid, gids };
}

export interface RpcCall {
  readonly xid: number;
  readonly rpcVersion: number;
  readonly program: number;
  readonly programVersion: number;
  readonly procedure: number;
  readonly credential: RpcOpaqueAuth;
  readonly verifier: RpcOpaqueAuth;
  readonly payload: Uint8Array;
}

export type RpcReply =
  | {
      readonly xid: number;
      readonly state: RpcReplyState.MSG_ACCEPTED;
      readonly verifier: RpcOpaqueAuth;
      readonly acceptState: RpcAcceptState.SUCCESS;
      readonly payload: Uint8Array;
    }
  | {
      readonly xid: number;
      readonly state: RpcReplyState.MSG_ACCEPTED;
      readonly verifier: RpcOpaqueAuth;
      readonly acceptState: RpcAcceptState.PROG_MISMATCH;
      readonly lowVersion: number;
      readonly highVersion: number;
    }
  | {
      readonly xid: number;
      readonly state: RpcReplyState.MSG_ACCEPTED;
      readonly verifier: RpcOpaqueAuth;
      readonly acceptState: Exclude<RpcAcceptState, RpcAcceptState.SUCCESS | RpcAcceptState.PROG_MISMATCH>;
    }
  | {
      readonly xid: number;
      readonly state: RpcReplyState.MSG_DENIED;
      readonly rejectState: RpcRejectState.RPC_MISMATCH;
      readonly lowVersion: number;
      readonly highVersion: number;
    }
  | {
      readonly xid: number;
      readonly state: RpcReplyState.MSG_DENIED;
      readonly rejectState: RpcRejectState.AUTH_ERROR;
      readonly authState: RpcAuthState;
    };

function writeAuth(writer: XdrWriter, auth: RpcOpaqueAuth): void {
  if (auth.body.length > RPC_MAX_AUTH_SIZE) {
    throw new XdrError(`opaque auth of ${auth.body.length} bytes exceeds ${RPC_MAX_AUTH_SIZE}`);
  }
  writer.enumeration(auth.flavor);
  writer.variableOpaque(auth.body);
}

function readAuth(reader: XdrReader): RpcOpaqueAuth {
  const flavor = reader.enumeration() as RpcAuthFlavor;
  return { flavor, body: reader.variableOpaque(RPC_MAX_AUTH_SIZE) };
}

export function encodeRpcCall(call: RpcCall): Uint8Array {
  const writer = new XdrWriter();
  writer.uint32(call.xid);
  writer.enumeration(RpcMessageType.CALL);
  writer.uint32(call.rpcVersion);
  writer.uint32(call.program);
  writer.uint32(call.programVersion);
  writer.uint32(call.procedure);
  writeAuth(writer, call.credential);
  writeAuth(writer, call.verifier);
  writer.raw(call.payload);
  return writer.toBytes();
}

export function decodeRpcCall(bytes: Uint8Array): RpcCall {
  const reader = new XdrReader(bytes);
  const xid = reader.uint32();
  const type = reader.enumeration();
  if (type !== RpcMessageType.CALL) throw new XdrError(`message type ${type} is not a call`);
  const rpcVersion = reader.uint32();
  const program = reader.uint32();
  const programVersion = reader.uint32();
  const procedure = reader.uint32();
  const credential = readAuth(reader);
  const verifier = readAuth(reader);
  return {
    xid, rpcVersion, program, programVersion, procedure, credential, verifier,
    payload: reader.raw(reader.remaining),
  };
}

export function encodeRpcReply(reply: RpcReply): Uint8Array {
  const writer = new XdrWriter();
  writer.uint32(reply.xid);
  writer.enumeration(RpcMessageType.REPLY);
  writer.enumeration(reply.state);
  if (reply.state === RpcReplyState.MSG_ACCEPTED) {
    writeAuth(writer, reply.verifier);
    writer.enumeration(reply.acceptState);
    if (reply.acceptState === RpcAcceptState.SUCCESS) {
      writer.raw(reply.payload);
    } else if (reply.acceptState === RpcAcceptState.PROG_MISMATCH) {
      writer.uint32(reply.lowVersion);
      writer.uint32(reply.highVersion);
    }
    return writer.toBytes();
  }
  writer.enumeration(reply.rejectState);
  if (reply.rejectState === RpcRejectState.RPC_MISMATCH) {
    writer.uint32(reply.lowVersion);
    writer.uint32(reply.highVersion);
  } else {
    writer.enumeration(reply.authState);
  }
  return writer.toBytes();
}

export function decodeRpcReply(bytes: Uint8Array): RpcReply {
  const reader = new XdrReader(bytes);
  const xid = reader.uint32();
  const type = reader.enumeration();
  if (type !== RpcMessageType.REPLY) throw new XdrError(`message type ${type} is not a reply`);
  const state = reader.enumeration() as RpcReplyState;
  if (state === RpcReplyState.MSG_ACCEPTED) {
    const verifier = readAuth(reader);
    const acceptState = reader.enumeration() as RpcAcceptState;
    if (acceptState === RpcAcceptState.SUCCESS) {
      return { xid, state, verifier, acceptState, payload: reader.raw(reader.remaining) };
    }
    if (acceptState === RpcAcceptState.PROG_MISMATCH) {
      return { xid, state, verifier, acceptState, lowVersion: reader.uint32(), highVersion: reader.uint32() };
    }
    return { xid, state, verifier, acceptState };
  }
  const rejectState = reader.enumeration() as RpcRejectState;
  if (rejectState === RpcRejectState.RPC_MISMATCH) {
    return { xid, state, rejectState, lowVersion: reader.uint32(), highVersion: reader.uint32() };
  }
  return { xid, state, rejectState, authState: reader.enumeration() as RpcAuthState };
}

export function frameRecord(message: Uint8Array): Uint8Array {
  if (message.length > RPC_FRAGMENT_SIZE_MASK) {
    throw new XdrError(`record fragment of ${message.length} bytes exceeds the 31-bit length`);
  }
  const header = (RPC_LAST_FRAGMENT | message.length) >>> 0;
  const out = new Uint8Array(4 + message.length);
  out[0] = (header >>> 24) & 0xff;
  out[1] = (header >>> 16) & 0xff;
  out[2] = (header >>> 8) & 0xff;
  out[3] = header & 0xff;
  out.set(message, 4);
  return out;
}

export function readRecord(stream: Uint8Array): { message: Uint8Array; consumed: number } | null {
  const fragments: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > stream.length) return null;
    const header = ((stream[offset] << 24) | (stream[offset + 1] << 16)
      | (stream[offset + 2] << 8) | stream[offset + 3]) >>> 0;
    const size = header & RPC_FRAGMENT_SIZE_MASK;
    const last = (header & RPC_LAST_FRAGMENT) !== 0;
    if (offset + 4 + size > stream.length) return null;
    fragments.push(stream.subarray(offset + 4, offset + 4 + size));
    offset += 4 + size;
    if (last) break;
  }
  const total = fragments.reduce((sum, f) => sum + f.length, 0);
  const message = new Uint8Array(total);
  let at = 0;
  for (const fragment of fragments) {
    message.set(fragment, at);
    at += fragment.length;
  }
  return { message, consumed: offset };
}
