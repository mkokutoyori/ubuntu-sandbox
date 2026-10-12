export type HuaweiHeaderKind = 'login' | 'shell';

export interface HuaweiHeaderHost {
  header(kind: HuaweiHeaderKind): string;
  setHeader(kind: HuaweiHeaderKind, text: string): void;
}

const INCOMPLETE = 'Error: Incomplete command found at \'^\' position.';
const UNRECOGNIZED = 'Error: Unrecognized command found at \'^\' position.';

function unquoted(text: string): string {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function applyHeaderCommand(
  args: readonly string[], host: HuaweiHeaderHost, negated: boolean,
): string {
  if (args.length === 0) return INCOMPLETE;
  const kind = args[0]?.toLowerCase();
  if (kind !== 'login' && kind !== 'shell') return UNRECOGNIZED;
  if (negated) {
    host.setHeader(kind, '');
    return '';
  }
  const form = args[1]?.toLowerCase();
  if (form === 'information' && args.length > 2) {
    host.setHeader(kind, unquoted(args.slice(2).join(' ')));
    return '';
  }
  if (form === 'file' && args[2]) return 'Error: The file does not exist.';
  return UNRECOGNIZED;
}

export function headerConfigLines(host: HuaweiHeaderHost): string[] {
  const lines: string[] = [];
  for (const kind of ['login', 'shell'] as const) {
    const text = host.header(kind);
    if (text !== '') lines.push(`header ${kind} information "${text}"`);
  }
  return lines;
}

interface BannerDevice {
  getBanner(kind: string): string;
  _setLoginBanner?(text: string): void;
  _setMotdBanner?(text: string): void;
  _setSshBanner?(text: string): void;
}

export function huaweiHeaderHost(device: () => unknown): HuaweiHeaderHost {
  const current = (): BannerDevice => device() as BannerDevice;
  return {
    header: (kind) => current().getBanner(kind === 'login' ? 'login' : 'motd'),
    setHeader: (kind, text) => {
      const target = current();
      if (kind === 'login') {
        target._setLoginBanner?.(text);
        target._setSshBanner?.(text);
      } else {
        target._setMotdBanner?.(text);
      }
    },
  };
}
