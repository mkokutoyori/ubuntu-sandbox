import { SshReader, SshWriter } from '../wire/SshDataTypes';

export const SSH_AGENT_FAILURE = 5;
export const SSH_AGENT_SUCCESS = 6;
export const SSH_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH_AGENT_IDENTITIES_ANSWER = 12;
export const SSH_AGENTC_SIGN_REQUEST = 13;
export const SSH_AGENT_SIGN_RESPONSE = 14;
export const SSH_AGENTC_ADD_IDENTITY = 17;
export const SSH_AGENTC_REMOVE_IDENTITY = 18;
export const SSH_AGENTC_REMOVE_ALL_IDENTITIES = 19;

export const SSH_AGENT_RSA_SHA2_256 = 2;
export const SSH_AGENT_RSA_SHA2_512 = 4;

export function agentSignatureFlags(algorithm: string): number {
  if (algorithm === 'rsa-sha2-512') return SSH_AGENT_RSA_SHA2_512;
  return algorithm === 'rsa-sha2-256' ? SSH_AGENT_RSA_SHA2_256 : 0;
}

export const AGENT_CHANNEL_TYPE = 'auth-agent@openssh.com';
export const AGENT_FORWARDING_REQUEST = 'auth-agent-req@openssh.com';

export interface AgentIdentityEntry {
  readonly blob: Uint8Array;
  readonly comment: string;
}

export type AgentRequest =
  | { readonly kind: 'request-identities' }
  | { readonly kind: 'sign'; readonly blob: Uint8Array; readonly data: Uint8Array; readonly flags: number }
  | { readonly kind: 'add'; readonly keyType: string; readonly material: string; readonly comment: string }
  | { readonly kind: 'remove'; readonly blob: Uint8Array }
  | { readonly kind: 'remove-all' };

export type AgentReply =
  | { readonly kind: 'failure' }
  | { readonly kind: 'success' }
  | { readonly kind: 'identities'; readonly entries: readonly AgentIdentityEntry[] }
  | { readonly kind: 'signature'; readonly signature: Uint8Array };

export function frameAgentMessage(payload: Uint8Array): Uint8Array {
  return new SshWriter().writeBytes(payload).toBytes();
}

export function encodeAgentRequest(request: AgentRequest): Uint8Array {
  const writer = new SshWriter();
  switch (request.kind) {
    case 'request-identities':
      return writer.writeByte(SSH_AGENTC_REQUEST_IDENTITIES).toBytes();
    case 'sign':
      return writer.writeByte(SSH_AGENTC_SIGN_REQUEST).writeBytes(request.blob)
        .writeBytes(request.data).writeUint32(request.flags).toBytes();
    case 'add':
      return writer.writeByte(SSH_AGENTC_ADD_IDENTITY).writeString(request.keyType)
        .writeString(request.material).writeString(request.comment).toBytes();
    case 'remove':
      return writer.writeByte(SSH_AGENTC_REMOVE_IDENTITY).writeBytes(request.blob).toBytes();
    case 'remove-all':
      return writer.writeByte(SSH_AGENTC_REMOVE_ALL_IDENTITIES).toBytes();
  }
}

export function decodeAgentRequest(payload: Uint8Array): AgentRequest | null {
  try {
    const reader = new SshReader(payload);
    switch (reader.readByte()) {
      case SSH_AGENTC_REQUEST_IDENTITIES:
        return { kind: 'request-identities' };
      case SSH_AGENTC_SIGN_REQUEST:
        return { kind: 'sign', blob: reader.readBytes(), data: reader.readBytes(), flags: reader.readUint32() };
      case SSH_AGENTC_ADD_IDENTITY:
        return { kind: 'add', keyType: reader.readString(), material: reader.readString(), comment: reader.readString() };
      case SSH_AGENTC_REMOVE_IDENTITY:
        return { kind: 'remove', blob: reader.readBytes() };
      case SSH_AGENTC_REMOVE_ALL_IDENTITIES:
        return { kind: 'remove-all' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function encodeAgentReply(reply: AgentReply): Uint8Array {
  const writer = new SshWriter();
  switch (reply.kind) {
    case 'failure':
      return writer.writeByte(SSH_AGENT_FAILURE).toBytes();
    case 'success':
      return writer.writeByte(SSH_AGENT_SUCCESS).toBytes();
    case 'identities': {
      writer.writeByte(SSH_AGENT_IDENTITIES_ANSWER).writeUint32(reply.entries.length);
      for (const entry of reply.entries) writer.writeBytes(entry.blob).writeString(entry.comment);
      return writer.toBytes();
    }
    case 'signature':
      return writer.writeByte(SSH_AGENT_SIGN_RESPONSE).writeBytes(reply.signature).toBytes();
  }
}

export function decodeAgentReply(payload: Uint8Array): AgentReply | null {
  try {
    const reader = new SshReader(payload);
    switch (reader.readByte()) {
      case SSH_AGENT_FAILURE:
        return { kind: 'failure' };
      case SSH_AGENT_SUCCESS:
        return { kind: 'success' };
      case SSH_AGENT_IDENTITIES_ANSWER: {
        const count = reader.readUint32();
        const entries: AgentIdentityEntry[] = [];
        for (let i = 0; i < count; i++) entries.push({ blob: reader.readBytes(), comment: reader.readString() });
        return { kind: 'identities', entries };
      }
      case SSH_AGENT_SIGN_RESPONSE:
        return { kind: 'signature', signature: reader.readBytes() };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export class AgentFrameReader {
  private buffer = new Uint8Array(0);

  push(data: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + data.length);
    merged.set(this.buffer);
    merged.set(data, this.buffer.length);
    this.buffer = merged;
    const frames: Uint8Array[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = new SshReader(this.buffer).readUint32();
      if (this.buffer.length < 4 + length) break;
      frames.push(this.buffer.slice(4, 4 + length));
      this.buffer = this.buffer.slice(4 + length);
    }
    return frames;
  }
}
