import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress } from '@/network/core/types';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import {
  makeARecord, makeAaaaRecord, makeCnameRecord, makeMxRecord,
  makePtrRecord, makeTxtRecord,
  type ResourceRecord, type ResourceRecordData,
} from '@/network/dns/wire/ResourceRecord';
import type {
  UpdateInstruction, UpdatePrerequisite, DnsUpdateRequest,
} from '@/network/dns/update/DnsUpdate';
import { TsigAlgorithm, type TsigKey } from '@/network/dns/tsig/Tsig';
import { DnsUpdateRcode } from '@/network/dns/update/UpdateResponder';

interface Script {
  server: string | null;
  zone: string | null;
  prerequisites: UpdatePrerequisite[];
  updates: UpdateInstruction[];
}

const RCODE_NAMES = new Map<number, string>([
  [DnsRcode.NOERROR, 'NOERROR'],
  [DnsRcode.FORMERR, 'FORMERR'],
  [DnsRcode.SERVFAIL, 'SERVFAIL'],
  [DnsRcode.NXDOMAIN, 'NXDOMAIN'],
  [DnsRcode.NOTIMP, 'NOTIMP'],
  [DnsRcode.REFUSED, 'REFUSED'],
  [DnsUpdateRcode.YXDOMAIN, 'YXDOMAIN'],
  [DnsUpdateRcode.YXRRSET, 'YXRRSET'],
  [DnsUpdateRcode.NXRRSET, 'NXRRSET'],
  [DnsUpdateRcode.NOTAUTH, 'NOTAUTH'],
  [DnsUpdateRcode.NOTZONE, 'NOTZONE'],
]);

const TYPE_CODES = new Map<string, number>([
  ['A', RRType.A], ['AAAA', RRType.AAAA], ['CNAME', RRType.CNAME],
  ['MX', RRType.MX], ['PTR', RRType.PTR], ['TXT', RRType.TXT], ['ANY', RRType.ANY],
]);

function buildRecord(
  name: string, ttl: number, type: string, rdata: string[],
): ResourceRecord<ResourceRecordData> | null {
  switch (type) {
    case 'A': return makeARecord(name, ttl, rdata[0]);
    case 'AAAA': return makeAaaaRecord(name, ttl, rdata[0]);
    case 'CNAME': return makeCnameRecord(name, ttl, rdata[0]);
    case 'PTR': return makePtrRecord(name, ttl, rdata[0]);
    case 'TXT': return makeTxtRecord(name, ttl, rdata.join(' '));
    case 'MX': return makeMxRecord(name, ttl, Number(rdata[0]), rdata[1]);
    default: return null;
  }
}

function parseKeyOption(spec: string): TsigKey | string {
  const parts = spec.split(':');
  if (parts.length === 3) {
    const algorithm = parts[0].endsWith('.') ? parts[0] : `${parts[0]}.`;
    return { name: parts[1], algorithm, secret: parts[2] };
  }
  if (parts.length === 2) {
    return { name: parts[0], algorithm: TsigAlgorithm.HMAC_SHA256, secret: parts[1] };
  }
  return `nsupdate: could not read key from ${spec}`;
}

function parseLine(line: string, script: Script): string | null {
  const words = line.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return null;
  const verb = words[0].toLowerCase();

  if (verb === 'server') { script.server = words[1] ?? null; return null; }
  if (verb === 'zone') { script.zone = words[1] ?? null; return null; }

  if (verb === 'prereq') {
    const kind = (words[1] ?? '').toLowerCase();
    const name = words[2] ?? '';
    if (kind === 'nxdomain') { script.prerequisites.push({ kind: 'name-not-in-use', name }); return null; }
    if (kind === 'yxdomain') { script.prerequisites.push({ kind: 'name-in-use', name }); return null; }
    const type = TYPE_CODES.get((words[3] ?? '').toUpperCase());
    if (type === undefined) return `nsupdate: unknown type '${words[3] ?? ''}'`;
    if (kind === 'nxrrset') { script.prerequisites.push({ kind: 'rrset-absent', name, type }); return null; }
    if (kind === 'yxrrset') {
      const rdata = words.slice(4);
      if (rdata.length === 0) { script.prerequisites.push({ kind: 'rrset-exists', name, type }); return null; }
      const record = buildRecord(name, 0, (words[3] ?? '').toUpperCase(), rdata);
      if (!record) return `nsupdate: unknown type '${words[3] ?? ''}'`;
      script.prerequisites.push({ kind: 'rrset-exists-value', record });
      return null;
    }
    return `nsupdate: unknown prerequisite '${kind}'`;
  }

  if (verb === 'update') {
    const action = (words[1] ?? '').toLowerCase();
    if (action === 'add') {
      const name = words[2] ?? '';
      const ttl = Number(words[3]);
      if (!Number.isFinite(ttl)) return 'nsupdate: an added record needs a TTL';
      const type = (words[4] ?? '').toUpperCase();
      const record = buildRecord(name, ttl, type, words.slice(5));
      if (!record) return `nsupdate: unknown type '${words[4] ?? ''}'`;
      script.updates.push({ kind: 'add', record });
      return null;
    }
    if (action === 'delete' || action === 'del') {
      const name = words[2] ?? '';
      if (words.length === 3) { script.updates.push({ kind: 'delete-name', name }); return null; }
      const typeWord = (words[3] ?? '').toUpperCase();
      const type = TYPE_CODES.get(typeWord);
      if (type === undefined) return `nsupdate: unknown type '${words[3] ?? ''}'`;
      if (words.length === 4) { script.updates.push({ kind: 'delete-rrset', name, type }); return null; }
      const record = buildRecord(name, 0, typeWord, words.slice(4));
      if (!record) return `nsupdate: unknown type '${typeWord}'`;
      script.updates.push({ kind: 'delete-record', record });
      return null;
    }
    return `nsupdate: unknown update action '${action}'`;
  }

  if (verb === 'send' || verb === 'answer' || verb === 'show' || verb === 'quit') return null;
  return `nsupdate: unknown command '${verb}'`;
}

function zoneOf(script: Script): string | null {
  if (script.zone) return script.zone;
  const first = script.updates[0];
  if (!first) return null;
  const name = first.kind === 'add' || first.kind === 'delete-record'
    ? first.record.name : first.name;
  const dot = name.indexOf('.');
  return dot === -1 ? null : name.slice(dot + 1);
}

export const nsupdateCommand: LinuxCommand = {
  name: 'nsupdate',
  needsNetworkContext: true,
  binaryPath: '/usr/bin/nsupdate',
  readsStdin: true,
  usage: 'nsupdate [-y [hmac:]keyname:secret] [-v] [file]',
  async run(ctx: LinuxCommandContext, argv: string[], stdin?: string): Promise<string> {
    const sender = ctx.executor.dnsUpdateSender?.();
    if (!sender) return 'nsupdate: no DNS support on this host';

    let key: TsigKey | undefined;
    const files: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-y') {
        const parsed = parseKeyOption(argv[++i] ?? '');
        if (typeof parsed === 'string') return parsed;
        key = parsed;
        continue;
      }
      if (a === '-v' || a === '-d' || a === '-D') continue;
      if (a.startsWith('-')) return `nsupdate: invalid option -- '${a.replace(/^-+/, '')}'`;
      files.push(a);
    }

    let text = stdin ?? '';
    if (files.length > 0) {
      const read = ctx.executor.vfs.readFile(files[0]);
      if (read === undefined || read === null) {
        return `nsupdate: can't open ${files[0]}: file not found`;
      }
      text = read;
    }
    if (text.trim().length === 0) return '';

    const script: Script = { server: null, zone: null, prerequisites: [], updates: [] };
    for (const line of text.split('\n')) {
      const error = parseLine(line, script);
      if (error) return error;
    }
    if (script.updates.length === 0 && script.prerequisites.length === 0) return '';

    if (!script.server) return 'nsupdate: no server given and this build does not guess one';
    const serverIP = IPAddress.tryParse(script.server)
      ?? await ctx.net.resolveHostname(script.server);
    if (!serverIP) return `nsupdate: couldn't get address for '${script.server}'`;

    const zone = zoneOf(script);
    if (!zone) return 'nsupdate: could not determine the zone to update';

    const request: DnsUpdateRequest = {
      zone, zoneClass: DnsClass.IN,
      prerequisites: script.prerequisites, updates: script.updates,
    };
    const outcome = await sender(serverIP, request, key);
    if (!outcome.answered) return 'nsupdate: no answer from the server';
    if (outcome.rcode === DnsRcode.NOERROR) return '';
    return `update failed: ${RCODE_NAMES.get(outcome.rcode) ?? `RCODE${outcome.rcode}`}`;
  },
  async runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    const output = await nsupdateCommand.run(ctx, args, stdin) as string;
    const failed = output.startsWith('nsupdate:') || output.startsWith('update failed:');
    return { output: failed ? '' : output, exitCode: failed ? 1 : 0, stderr: failed ? output : undefined };
  },
};
