import { OPENSSH_USERAUTH_METHODS, type SshClientAuthentication } from '../SshConnectOptions';
import type { AuthMethodType } from './ISshAuthMethod';

export interface UserauthPrompt {
  readonly prompt: string;
  readonly echo: boolean;
}

export interface UserauthInfoRequest {
  readonly name: string;
  readonly instruction: string;
  readonly prompts: readonly UserauthPrompt[];
}

export type UserauthReply =
  | { readonly kind: 'success' }
  | { readonly kind: 'failure'; readonly methods: string }
  | { readonly kind: 'disconnect'; readonly reason: string }
  | { readonly kind: 'closed' };

export type UserauthOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'denied'; readonly methods: string }
  | { readonly kind: 'disconnect'; readonly reason: string }
  | { readonly kind: 'closed' };

export interface UserauthTransport {
  request(
    method: 'none' | AuthMethodType,
    fields: Readonly<Record<string, unknown>>,
    onInfoRequest?: (request: UserauthInfoRequest) => Promise<readonly string[] | null>,
  ): Promise<UserauthReply>;
}

export interface UserauthPrompter {
  canAnswer(): boolean;
  password(): Promise<string>;
  keyboardInteractive(prompt: UserauthPrompt): Promise<string>;
  retry(): void;
  inform(text: string): void;
}

export interface UserauthPlan {
  readonly authentication: SshClientAuthentication;
  readonly publicKeys: readonly string[];
  readonly interactive: boolean;
}

const isUserauthMethod = (name: string): name is AuthMethodType =>
  (OPENSSH_USERAUTH_METHODS as readonly string[]).includes(name);

export async function runUserauth(
  transport: UserauthTransport,
  plan: UserauthPlan,
  prompter: UserauthPrompter,
): Promise<UserauthOutcome> {
  const auth = plan.authentication;
  const disabled = new Set<AuthMethodType>();
  const configured = (method: AuthMethodType): boolean => {
    if (method === 'publickey') return auth.publickey;
    if (auth.batchMode || !plan.interactive) return false;
    return method === 'password' ? auth.password : auth.keyboardInteractive;
  };
  const enabled = (method: AuthMethodType): boolean => configured(method) && !disabled.has(method);
  const preferred = auth.preferred ?? OPENSSH_USERAUTH_METHODS.filter(configured);

  let supported: string | null = null;
  let remaining: readonly string[] = preferred;
  let current: AuthMethodType | null = null;
  const nextMethod = (list: string): AuthMethodType | null => {
    if (supported !== list) {
      supported = list;
      remaining = preferred;
      current = null;
    } else if (current !== null && enabled(current)) {
      return current;
    }
    const offered = new Set(list.split(',').filter(Boolean));
    for (;;) {
      const index = remaining.findIndex((name) => offered.has(name));
      if (index < 0) {
        current = null;
        return null;
      }
      const name = remaining[index];
      remaining = remaining.slice(index + 1);
      if (isUserauthMethod(name) && enabled(name)) {
        current = name;
        return name;
      }
    }
  };

  let publicKeysOffered = 0;
  let keyboardInteractiveAttempts = 0;
  let infoRequestSeen = false;
  let passwordAttempts = 0;
  const attempt = async (method: AuthMethodType): Promise<UserauthReply | null> => {
    if (method === 'publickey') {
      const publicKey = plan.publicKeys[publicKeysOffered++];
      return publicKey === undefined ? null : transport.request('publickey', { publicKey });
    }
    if (method === 'keyboard-interactive') {
      if (keyboardInteractiveAttempts++ >= auth.passwordPrompts) return null;
      if (keyboardInteractiveAttempts > 1 && !infoRequestSeen) return null;
      if (!prompter.canAnswer()) return null;
      return transport.request('keyboard-interactive', { devices: '' }, async (request) => {
        infoRequestSeen = true;
        if (request.name) prompter.inform(request.name);
        if (request.instruction) prompter.inform(request.instruction);
        const responses: string[] = [];
        for (const prompt of request.prompts) responses.push(await prompter.keyboardInteractive(prompt));
        return responses;
      });
    }
    if (passwordAttempts++ >= auth.passwordPrompts) return null;
    if (!prompter.canAnswer()) return null;
    if (passwordAttempts !== 1) prompter.retry();
    return transport.request('password', { password: await prompter.password() });
  };

  let reply = await transport.request('none', {});
  for (;;) {
    if (reply.kind !== 'failure') return reply;
    let sent: UserauthReply | null = null;
    while (sent === null) {
      const method = nextMethod(reply.methods);
      if (method === null) return { kind: 'denied', methods: reply.methods };
      sent = await attempt(method);
      if (sent === null) disabled.add(method);
    }
    reply = sent;
  }
}
