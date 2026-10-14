import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
import { agentKeyOf, type AgentKey, type SshAgent } from '../SshAgent';
import type { ConnectionChannel } from '../connection/SshConnection';
import {
  AgentFrameReader, decodeAgentReply, decodeAgentRequest, encodeAgentReply, encodeAgentRequest, frameAgentMessage,
  type AgentIdentityEntry, type AgentReply, type AgentRequest,
} from './AgentWire';

export interface AgentPort {
  identities(): Promise<readonly AgentIdentityEntry[]>;
  sign(blob: Uint8Array, data: Uint8Array, flags: number): Promise<Uint8Array | null>;
  add(key: AgentKey): Promise<boolean>;
  remove(blob: Uint8Array): Promise<boolean>;
  removeAll(): Promise<boolean>;
}

export async function answerAgentRequest(port: AgentPort, request: AgentRequest): Promise<AgentReply> {
  switch (request.kind) {
    case 'request-identities':
      return { kind: 'identities', entries: await port.identities() };
    case 'sign': {
      const signature = await port.sign(request.blob, request.data, request.flags);
      return signature === null ? { kind: 'failure' } : { kind: 'signature', signature };
    }
    case 'add': {
      const key = agentKeyOf(request.comment, request.material);
      return { kind: key !== null && await port.add(key) ? 'success' : 'failure' };
    }
    case 'remove':
      return { kind: await port.remove(request.blob) ? 'success' : 'failure' };
    case 'remove-all':
      return { kind: await port.removeAll() ? 'success' : 'failure' };
  }
}

export function serveAgentChannel(channel: ConnectionChannel, port: AgentPort): void {
  const frames = new AgentFrameReader();
  channel.onData((data) => {
    for (const frame of frames.push(data)) {
      const request = decodeAgentRequest(frame);
      void (request === null ? Promise.resolve<AgentReply>({ kind: 'failure' }) : answerAgentRequest(port, request))
        .then((reply) => channel.write(frameAgentMessage(encodeAgentReply(reply))));
    }
  });
  channel.onEof(() => channel.close());
}

export class LocalAgentPort implements AgentPort {
  constructor(private readonly agent: SshAgent) {}

  async identities(): Promise<readonly AgentIdentityEntry[]> {
    return this.agent.list().map((key) => ({ blob: base64ToBytes(key.blob), comment: key.comment }));
  }

  async sign(blob: Uint8Array, data: Uint8Array, flags: number): Promise<Uint8Array | null> {
    return this.agent.sign(blob, data, flags);
  }

  async add(key: AgentKey): Promise<boolean> {
    this.agent.install(key);
    return true;
  }

  async remove(blob: Uint8Array): Promise<boolean> {
    return this.agent.removeKey(bytesToBase64(blob));
  }

  async removeAll(): Promise<boolean> {
    this.agent.removeAll();
    return true;
  }
}

export class ChannelAgentPort implements AgentPort {
  constructor(private readonly open: () => Promise<ConnectionChannel>) {}

  private async exchange(request: AgentRequest): Promise<AgentReply> {
    let channel: ConnectionChannel;
    try {
      channel = await this.open();
    } catch {
      return { kind: 'failure' };
    }
    return new Promise<AgentReply>((resolve) => {
      const frames = new AgentFrameReader();
      let answered = false;
      const finish = (reply: AgentReply): void => {
        if (answered) return;
        answered = true;
        channel.close();
        resolve(reply);
      };
      channel.onData((data) => {
        for (const frame of frames.push(data)) finish(decodeAgentReply(frame) ?? { kind: 'failure' });
      });
      channel.onClose(() => finish({ kind: 'failure' }));
      channel.write(frameAgentMessage(encodeAgentRequest(request)));
    });
  }

  async identities(): Promise<readonly AgentIdentityEntry[]> {
    const reply = await this.exchange({ kind: 'request-identities' });
    return reply.kind === 'identities' ? reply.entries : [];
  }

  async sign(blob: Uint8Array, data: Uint8Array, flags: number): Promise<Uint8Array | null> {
    const reply = await this.exchange({ kind: 'sign', blob, data, flags });
    return reply.kind === 'signature' ? reply.signature : null;
  }

  async add(key: AgentKey): Promise<boolean> {
    const reply = await this.exchange({
      kind: 'add', keyType: key.algorithm, material: key.material, comment: key.comment,
    });
    return reply.kind === 'success';
  }

  async remove(blob: Uint8Array): Promise<boolean> {
    return (await this.exchange({ kind: 'remove', blob })).kind === 'success';
  }

  async removeAll(): Promise<boolean> {
    return (await this.exchange({ kind: 'remove-all' })).kind === 'success';
  }
}
