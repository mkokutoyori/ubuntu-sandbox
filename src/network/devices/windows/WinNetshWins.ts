import type { WinCommandContext } from './WinCommandExecutor';
import { adapterDisplayName, resolveAdapterPortName } from './netAdapter';
import { IPAddress } from '../../core/types';

const WINS_WORD = /^wins(?:servers?)?\b\s*/i;

export function isWinsCommand(joined: string): boolean {
  return WINS_WORD.test(joined.trim());
}

function interfaceOf(ctx: WinCommandContext, raw: string): string | null {
  const name = raw.replace(/^name=/i, '').replace(/^["']|["']$/g, '').trim();
  return resolveAdapterPortName(name, ctx.ports.values()) ?? (ctx.ports.has(name) ? name : null);
}

const TAIL_START = /^(?:(?:source|address|index)=|static$|dhcp$|all$|none$|\d+\.\d+\.\d+\.\d+$)/i;

function splitNameAndTail(rest: string): { name: string; tail: string[] } | null {
  const tokens = rest.trim().split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 0) return null;
  const nameTokens: string[] = [];
  let index = 0;
  while (index < tokens.length && (nameTokens.length === 0 || !TAIL_START.test(tokens[index]))) nameTokens.push(tokens[index++]);
  return { name: nameTokens.join(' ').replace(/^name=/i, ''), tail: tokens.slice(index) };
}

function addressOf(raw: string): string | null {
  return IPAddress.tryParse(raw.replace(/^address=/i, ''))?.toString() ?? null;
}

export function handleWins(ctx: WinCommandContext, verb: 'add' | 'delete' | 'set' | 'show', joined: string): string {
  const rest = joined.trim().replace(WINS_WORD, '');
  if (verb === 'show') return showWins(ctx, rest);
  const split = splitNameAndTail(rest);
  if (split === null) return `The syntax supplied for this command is not valid. Check help for the correct syntax.`;
  const port = interfaceOf(ctx, split.name);
  if (port === null) return `The interface "${split.name.replace(/^["']|["']$/g, '')}" was not found.`;
  const tail = split.tail;
  const current = [...ctx.getWinsServers(port)];
  if (verb === 'set') {
    const source = (tail[0] ?? '').replace(/^source=/i, '').toLowerCase();
    if (source === 'dhcp') { ctx.setWinsServers(port, []); return 'Ok.'; }
    if (source !== 'static') return 'The syntax supplied for this command is not valid. Check help for the correct syntax.';
    const given = (tail[1] ?? '').replace(/^address=/i, '');
    if (given.toLowerCase() === 'none') { ctx.setWinsServers(port, []); return 'Ok.'; }
    const address = addressOf(given);
    if (address === null) return `The syntax supplied for this command is not valid. Check help for the correct syntax.`;
    ctx.setWinsServers(port, [address]);
    return 'Ok.';
  }
  if (verb === 'add') {
    const address = addressOf(tail[0] ?? '');
    if (address === null) return `The syntax supplied for this command is not valid. Check help for the correct syntax.`;
    if (current.includes(address)) return 'The object already exists.';
    const index = Number((tail[1] ?? '').replace(/^index=/i, ''));
    if (Number.isInteger(index) && index >= 1 && index <= current.length + 1) current.splice(index - 1, 0, address);
    else current.push(address);
    ctx.setWinsServers(port, current);
    return 'Ok.';
  }
  const target = (tail[0] ?? '').replace(/^address=/i, '');
  if (target.toLowerCase() === 'all') { ctx.setWinsServers(port, []); return 'Ok.'; }
  const address = addressOf(target);
  if (address === null) return `The syntax supplied for this command is not valid. Check help for the correct syntax.`;
  if (!current.includes(address)) return 'The system cannot find the file specified.';
  ctx.setWinsServers(port, current.filter((server) => server !== address));
  return 'Ok.';
}

function showWins(ctx: WinCommandContext, rest: string): string {
  const named = rest.trim() === '' ? null : splitNameAndTail(rest);
  const filter = named === null ? null : interfaceOf(ctx, named.name);
  const lines: string[] = [];
  for (const [name] of ctx.ports) {
    if (filter !== null && name !== filter) continue;
    const servers = ctx.getWinsServers(name);
    lines.push(`Configuration for interface "${adapterDisplayName(name, ctx.ports)}"`);
    if (servers.length === 0) lines.push('    Statically Configured WINS Servers:   None');
    servers.forEach((server, index) => {
      lines.push(index === 0 ? `    Statically Configured WINS Servers:   ${server}` : `                                          ${server}`);
    });
    lines.push('');
  }
  return lines.join('\n');
}
