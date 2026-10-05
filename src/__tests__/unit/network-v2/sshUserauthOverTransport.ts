import type { TcpStream } from '@/network/tcp/types';
import { resolveAlgorithmDirectives } from '@/network/protocols/ssh/transport/SshAlgorithms';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { encodeUserauthRequest } from '@/network/protocols/ssh/auth/UserauthMessages';
import {
  SSH_MSG_USERAUTH_FAILURE, SSH_MSG_USERAUTH_SUCCESS,
} from '@/network/protocols/ssh/transport/SshMessageNumbers';

export type UserauthReplyKind = 'failure' | 'success' | 'ended';

export interface UserauthChannel {
  readonly replies: UserauthReplyKind[];
  closed(): boolean;
  password(user: string, password: string): void;
}

export async function userauthOverTransport(socket: TcpStream): Promise<UserauthChannel | null> {
  const transport = new SshTransport(socket, {
    role: 'client', identification: 'SSH-2.0-probe',
    algorithms: resolveAlgorithmDirectives({
      kex: '+diffie-hellman-group-exchange-sha1,diffie-hellman-group14-sha1,diffie-hellman-group1-sha1',
      hostKey: '+ssh-rsa',
      ciphers: '+aes128-cbc,aes192-cbc,aes256-cbc,3des-cbc',
    }),
  });
  const replies: UserauthReplyKind[] = [];
  let closed = false;
  transport.onClose(() => {
    closed = true;
    replies.push('ended');
  });
  const outcome = await transport.established;
  if (!outcome.ok) return null;
  transport.onMessage((payload) => {
    if (payload[0] === SSH_MSG_USERAUTH_FAILURE) replies.push('failure');
    if (payload[0] === SSH_MSG_USERAUTH_SUCCESS) replies.push('success');
  });
  return {
    replies,
    closed: () => closed,
    password: (user, password) => transport.send(encodeUserauthRequest(user, { method: 'password', password })),
  };
}
