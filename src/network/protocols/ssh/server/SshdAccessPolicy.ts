import type { AuthMethodType } from '../auth/ISshAuthMethod';
import { SshdServerConfig, type SshdEffectiveView } from './SshdServerConfig';

export type SshdAccountMethod = 'password' | 'publickey' | 'keyboard-interactive';

const IDENTITY_DIRECTIVES = /^(allowusers|denyusers|allowgroups|denygroups)(\s+)(.*)$/i;
const MATCH_DIRECTIVE = /^(match)(\s+)(.*)$/i;

export function foldSshdIdentityCase(text: string): string {
  return text.split('\n').map((line) => {
    const trimmed = line.trim();
    const identity = IDENTITY_DIRECTIVES.exec(trimmed);
    if (identity !== null) return `${identity[1]}${identity[2]}${identity[3].toLowerCase()}`;
    const match = MATCH_DIRECTIVE.exec(trimmed);
    if (match === null) return line;
    const tokens = match[3].split(/\s+/);
    const folded = tokens.map((token, index) => {
      const keyword = (tokens[index - 1] ?? '').toLowerCase();
      return keyword === 'user' || keyword === 'group' ? token.toLowerCase() : token;
    });
    return `${match[1]}${match[2]}${folded.join(' ')}`;
  }).join('\n');
}

export class SshdAccessPolicy {
  private constructor(
    readonly config: SshdServerConfig,
    private readonly groupsOf: (user: string) => readonly string[],
    private readonly fold: (value: string) => string,
  ) {}

  static forText(
    text: string, groupsOf: (user: string) => readonly string[], caseInsensitive = false,
  ): SshdAccessPolicy {
    return caseInsensitive
      ? new SshdAccessPolicy(SshdServerConfig.parse(foldSshdIdentityCase(text)), groupsOf, (value) => value.toLowerCase())
      : new SshdAccessPolicy(SshdServerConfig.parse(text), groupsOf, (value) => value);
  }

  static over(config: SshdServerConfig, groupsOf: (user: string) => readonly string[]): SshdAccessPolicy {
    return new SshdAccessPolicy(config, groupsOf, (value) => value);
  }

  view(user: string, address?: string): SshdEffectiveView {
    return this.config.effectiveFor({
      user: this.fold(user), groups: this.groupsOf(user).map(this.fold), ...(address === undefined || address === '' ? {} : { address }),
    });
  }

  refusal(user: string, address?: string): string | null {
    const groups = this.groupsOf(user).map(this.fold);
    return this.config.userRefusal(this.fold(user), groups, address === undefined || address === '' ? undefined : { address });
  }

  maxAuthTries(user: string, address: string): number {
    return this.view(user, address).maxAuthTries;
  }

  methodEnabled(user: string, address: string, method: SshdAccountMethod): boolean {
    const view = this.view(user, address);
    if (method === 'password') return view.passwordAuthentication;
    if (method === 'publickey') return view.pubkeyAuthentication;
    return view.kbdInteractiveAuthentication;
  }

  availableMethods(
    user: string, address: string,
    offered: { readonly publickey: boolean; readonly password: boolean; readonly keyboardInteractive: boolean },
  ): readonly AuthMethodType[] {
    const methods: AuthMethodType[] = [];
    if (offered.publickey && this.methodEnabled(user, address, 'publickey')) methods.push('publickey');
    if (offered.password && this.methodEnabled(user, address, 'password')) methods.push('password');
    if (offered.keyboardInteractive && this.methodEnabled(user, address, 'keyboard-interactive')) methods.push('keyboard-interactive');
    return methods;
  }

  bannerPath(user: string, address: string): string | null {
    return this.view(user, address).banner;
  }

  forceCommand(user: string, address: string): string | null {
    return this.view(user, address).forceCommand;
  }

  agentForwarding(user: string, address: string): boolean {
    return this.view(user, address).allowAgentForwarding;
  }

  permitsLocalForward(user: string, address: string, host: string, port: number): boolean {
    return this.config.permitsLocalForward(
      { user: this.fold(user), groups: this.groupsOf(user).map(this.fold), address }, host, port,
    );
  }
}
