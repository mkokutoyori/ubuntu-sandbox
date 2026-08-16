import { subnetAddress, hostAddress, rangeAddress } from '../../model/AddressObject';
import type { RuleAction } from '../../model/SecurityRule';
import type { AsaFirewall } from './AsaFirewall';
import type { SimulatedFlow, SimulatedProtocol } from '../../pipeline/SimulatedPacket';
import { ASA_PROFILE, asaDefaultSecurityLevel } from './AsaProfile';
import { renderPacketTracer } from './AsaPacketTracer';
import {
  ASA_INVALID_INPUT,
  ASA_UNIMPLEMENTED_REASONS,
  asaNotImplemented,
  asaSecurityLevelNotice,
} from './AsaMessages';

export type AsaMode = 'exec' | 'privileged' | 'config' | 'config-if' | 'config-object' | 'config-group';

interface AclLine {
  readonly acl: string;
  readonly action: RuleAction;
  readonly protocol: string;
  readonly source: string;
  readonly destination: string;
  readonly port?: string;
}

function parseTracerFlow(args: string[]): SimulatedFlow | undefined {
  const protocol = args[0];
  if (protocol === 'icmp') {
    if (args.length < 5) return undefined;
    return numericFlow('icmp', args[1], args[4], 0, args[2], args[3]);
  }
  if (protocol !== 'tcp' && protocol !== 'udp') return undefined;
  if (args.length < 5) return undefined;

  return numericFlow(protocol, args[1], args[3], undefined, args[2], undefined, args[4]);
}

function numericFlow(
  protocol: SimulatedProtocol, sourceIP: string, destinationIP: string,
  sourcePort: number | undefined, sourceField: string,
  icmpCode?: string, destinationField?: string,
): SimulatedFlow | undefined {
  const first = Number(sourceField);
  const second = destinationField === undefined ? 0 : Number(destinationField);
  if (!Number.isInteger(first) || !Number.isInteger(second)) return undefined;

  if (protocol === 'icmp') {
    const code = Number(icmpCode);
    if (!Number.isInteger(code)) return undefined;
    return {
      protocol, sourceIP, destinationIP,
      sourcePort: sourcePort ?? 0, destinationPort: first, icmpCode: code,
    };
  }
  return { protocol, sourceIP, destinationIP, sourcePort: first, destinationPort: second };
}

export class AsaShell {
  private mode: AsaMode = 'exec';
  private currentInterface?: string;
  private currentObject?: string;
  private currentGroup?: string;
  private ruleCounter = 0;
  private readonly aclLines: AclLine[] = [];

  constructor(private readonly fw: AsaFirewall) {}

  getPrompt(): string {
    const host = this.fw.getName();
    switch (this.mode) {
      case 'exec': return `${host}>`;
      case 'privileged': return `${host}#`;
      case 'config': return `${host}(config)#`;
      case 'config-if': return `${host}(config-if)#`;
      case 'config-object': return `${host}(config-network-object)#`;
      case 'config-group': return `${host}(config-network-object-group)#`;
    }
  }

  getMode(): AsaMode {
    return this.mode;
  }

  execute(rawLine: string): string {
    const line = rawLine.trim();
    if (line.length === 0) return '';

    const unimplemented = this.unimplementedMatch(line);
    if (unimplemented) return asaNotImplemented(unimplemented, ASA_UNIMPLEMENTED_REASONS[unimplemented]);

    const negated = line.startsWith('no ');
    const body = negated ? line.slice(3).trim() : line;
    const tokens = body.split(/\s+/);

    const navigated = this.navigate(tokens, negated);
    if (navigated !== null) return navigated;

    return this.dispatch(tokens, negated);
  }

  private dispatch(tokens: string[], negated: boolean): string {
    if (this.mode === 'exec' || this.mode === 'privileged') return this.execCommand(tokens);

    const answer = this.configFamilyCommand(tokens, negated);
    if (answer !== ASA_INVALID_INPUT) return answer;

    return this.execCommand(tokens);
  }

  private configFamilyCommand(tokens: string[], negated: boolean): string {
    switch (this.mode) {
      case 'config': return this.configCommand(tokens, negated);
      case 'config-if': return this.interfaceCommand(tokens, negated);
      case 'config-object': return this.objectCommand(tokens);
      case 'config-group': return this.groupCommand(tokens);
      default: return ASA_INVALID_INPUT;
    }
  }

  private unimplementedMatch(line: string): string | undefined {
    return Object.keys(ASA_UNIMPLEMENTED_REASONS).find(key => line.startsWith(key));
  }

  private navigate(tokens: string[], negated: boolean): string | null {
    const [head, ...rest] = tokens;

    if (head === 'enable' && this.mode === 'exec') { this.mode = 'privileged'; return ''; }
    if (head === 'disable' && this.mode === 'privileged') { this.mode = 'exec'; return ''; }

    if (head === 'configure' && rest[0] === 'terminal') {
      if (this.mode !== 'privileged') return ASA_INVALID_INPUT;
      this.mode = 'config';
      return '';
    }

    if (head === 'end') {
      this.mode = this.mode === 'exec' ? 'exec' : 'privileged';
      this.clearSubMode();
      return '';
    }

    if (head === 'exit') {
      if (this.mode === 'config-if' || this.mode === 'config-object' || this.mode === 'config-group') {
        this.mode = 'config';
        this.clearSubMode();
      } else if (this.mode === 'config') this.mode = 'privileged';
      else if (this.mode === 'privileged') this.mode = 'exec';
      return '';
    }

    if (head === 'interface' && !negated) {
      if (this.mode !== 'config' && this.mode !== 'config-if') return ASA_INVALID_INPUT;
      if (!this.fw.getPort(rest[0])) return ASA_INVALID_INPUT;
      this.currentInterface = rest[0];
      this.mode = 'config-if';
      return '';
    }

    if (head === 'object' && rest[0] === 'network' && !negated) {
      if (this.mode !== 'config' && this.mode !== 'config-object') return ASA_INVALID_INPUT;
      this.currentObject = rest[1];
      this.mode = 'config-object';
      return '';
    }

    if (head === 'object-group' && rest[0] === 'network' && !negated) {
      if (this.mode !== 'config' && this.mode !== 'config-group') return ASA_INVALID_INPUT;
      this.currentGroup = rest[1];
      this.fw.getObjectStore().addAddressGroup(rest[1], []);
      this.mode = 'config-group';
      return '';
    }

    return null;
  }

  private clearSubMode(): void {
    this.currentInterface = undefined;
    this.currentObject = undefined;
    this.currentGroup = undefined;
  }

  private execCommand(tokens: string[]): string {
    const [head, ...rest] = tokens;
    if (head === 'packet-tracer') return this.packetTracer(rest);
    if (head !== 'show') return ASA_INVALID_INPUT;

    switch (rest[0]) {
      case 'nameif': return this.showNameif();
      case 'conn': return this.showConn();
      case 'version': return this.showVersion();
      case 'running-config': return this.showRunningConfig();
      case 'access-list': return this.showAccessList();
      default: return ASA_INVALID_INPUT;
    }
  }

  private configCommand(tokens: string[], negated: boolean): string {
    const [head, ...rest] = tokens;

    if (head === 'access-list') return this.accessList(rest);
    if (head === 'access-group') return this.accessGroup(rest, negated);
    if (head === 'same-security-traffic') return this.sameSecurityTraffic(rest, negated);
    if (head === 'hostname') { this.fw.setName(rest[0]); return ''; }
    return ASA_INVALID_INPUT;
  }

  private interfaceCommand(tokens: string[], negated: boolean): string {
    const iface = this.currentInterface;
    if (!iface) return ASA_INVALID_INPUT;
    const [head, ...rest] = tokens;

    if (head === 'nameif') {
      const name = rest[0];
      if (!name) return ASA_INVALID_INPUT;
      const level = asaDefaultSecurityLevel(name);
      this.fw.nameif(iface, name, level);
      return asaSecurityLevelNotice(name, level);
    }

    if (head === 'security-level') {
      const level = Number(rest[0]);
      if (!Number.isInteger(level) || level < 0 || level > 100) return ASA_INVALID_INPUT;
      return this.fw.setSecurityLevel(iface, level) ? '' : ASA_INVALID_INPUT;
    }

    if (head === 'ip' && rest[0] === 'address') {
      this.fw.configureInterface(iface, { ip: rest[1], mask: rest[2] });
      return '';
    }

    if (head === 'shutdown') {
      this.fw.setInterfaceUp(iface, negated);
      return '';
    }

    return ASA_INVALID_INPUT;
  }

  private objectCommand(tokens: string[]): string {
    const name = this.currentObject;
    if (!name) return ASA_INVALID_INPUT;
    const [head, ...rest] = tokens;
    const store = this.fw.getObjectStore();

    if (head === 'host') { store.addAddress(hostAddress(name, rest[0])); return ''; }
    if (head === 'subnet') { store.addAddress(subnetAddress(name, rest[0], rest[1])); return ''; }
    if (head === 'range') { store.addAddress(rangeAddress(name, rest[0], rest[1])); return ''; }
    return ASA_INVALID_INPUT;
  }

  private groupCommand(tokens: string[]): string {
    const group = this.currentGroup;
    if (!group) return ASA_INVALID_INPUT;
    const [head, ...rest] = tokens;

    if (head === 'network-object' && rest[0] === 'object') {
      const result = this.fw.getObjectStore().addGroupMember(group, rest[1]);
      return result.ok ? '' : ASA_INVALID_INPUT;
    }
    return ASA_INVALID_INPUT;
  }

  private accessList(rest: string[]): string {
    const [acl, kind, keyword, protocol, source, destination, ...tail] = rest;
    if (kind !== 'extended') return ASA_INVALID_INPUT;
    if (keyword !== 'permit' && keyword !== 'deny') return ASA_INVALID_INPUT;

    const port = tail[0] === 'eq' ? tail[1] : undefined;
    this.aclLines.push({
      acl, action: keyword === 'permit' ? 'allow' : 'deny',
      protocol, source, destination, port,
    });

    this.ruleCounter++;
    this.fw.getPolicyStore().append({
      id: `${acl}#${this.ruleCounter}`,
      name: acl,
      from: ['any'], to: ['any'],
      source: [source === 'any' ? 'any' : source],
      destination: [destination === 'any' ? 'any' : destination],
      service: ['any'],
      action: keyword === 'permit' ? 'allow' : 'deny',
    });
    return '';
  }

  private accessGroup(rest: string[], negated: boolean): string {
    const [acl, direction, keyword, zoneName] = rest;
    if (direction !== 'in' && direction !== 'out') return ASA_INVALID_INPUT;
    if (keyword !== 'interface') return ASA_INVALID_INPUT;

    const iface = this.interfaceNamed(zoneName);
    if (!iface) return ASA_INVALID_INPUT;

    if (negated) this.fw.removeAccessGroup(iface);
    else this.fw.accessGroup(acl, iface);
    return '';
  }

  private sameSecurityTraffic(rest: string[], negated: boolean): string {
    if (rest[0] !== 'permit') return ASA_INVALID_INPUT;
    if (rest[1] !== 'inter-interface' && rest[1] !== 'intra-interface') return ASA_INVALID_INPUT;

    this.fw.setSameSecurityTraffic(rest[1], !negated);
    return '';
  }

  private interfaceNamed(zoneName: string): string | undefined {
    return this.fw.getZoneTable().interfacesOf(zoneName)[0];
  }

  private packetTracer(rest: string[]): string {
    if (this.mode === 'exec') return ASA_INVALID_INPUT;
    if (rest[0] !== 'input') return ASA_INVALID_INPUT;

    const ingressPort = this.interfaceNamed(rest[1]);
    if (!ingressPort) return ASA_INVALID_INPUT;

    const flow = parseTracerFlow(rest.slice(2));
    if (!flow) return ASA_INVALID_INPUT;

    const result = this.fw.simulate({ ingressPort, ...flow });
    return renderPacketTracer(result, iface => this.fw.getZoneTable().zoneOf(iface));
  }

  private showNameif(): string {
    const lines = ['Interface                Name                     Security'];
    for (const iface of this.fw.getInterfaceTable().names()) {
      const zone = this.fw.getZoneTable().zoneOf(iface);
      if (!zone) continue;
      const level = this.fw.getZoneTable().getZone(zone)?.securityLevel ?? 0;
      lines.push(`${iface.padEnd(25)}${zone.padEnd(25)}${level}`);
    }
    return lines.join('\n');
  }

  private showConn(): string {
    const sessions = this.fw.getSessionTable().view().all();
    const header = `${sessions.length} in use, ${sessions.length} most used`;
    if (sessions.length === 0) return header;

    const lines = sessions.map(s =>
      `TCP ${s.egressZone} ${s.c2s.destIP}:${s.c2s.destPort} ${s.ingressZone} `
      + `${s.c2s.sourceIP}:${s.c2s.sourcePort}, idle 0:00:00, bytes ${s.counters.bytesC2S}`);
    return [header, ...lines].join('\n');
  }

  private showVersion(): string {
    return [
      `Cisco Adaptive Security Appliance Software Version ${ASA_PROFILE.defaultVersion}`,
      '',
      `${this.fw.getName()} up 0 days 0 hours`,
    ].join('\n');
  }

  private showAccessList(): string {
    if (this.aclLines.length === 0) return '';
    return this.aclLines.map((l, index) => {
      const rule = this.fw.getPolicyStore().ordered()[index];
      const port = l.port ? ` eq ${l.port}` : '';
      const keyword = l.action === 'allow' ? 'permit' : 'deny';
      return `access-list ${l.acl} line ${index + 1} extended ${keyword} `
        + `${l.protocol} ${l.source} ${l.destination}${port} (hitcnt=${rule?.hitCount ?? 0})`;
    }).join('\n');
  }

  private showRunningConfig(): string {
    const lines: string[] = [`hostname ${this.fw.getName()}`, '!'];

    for (const iface of this.fw.getInterfaceTable().names()) {
      const zone = this.fw.getZoneTable().zoneOf(iface);
      const info = this.fw.getInterfaceTable().get(iface);
      if (!zone && !info?.ip) continue;

      lines.push(`interface ${iface}`);
      if (zone) {
        lines.push(` nameif ${zone}`);
        lines.push(` security-level ${this.fw.getZoneTable().getZone(zone)?.securityLevel ?? 0}`);
      }
      if (info?.ip && info.mask) lines.push(` ip address ${info.ip} ${info.mask}`);
      if (!this.fw.getInterfaceTable().isUp(iface)) lines.push(' shutdown');
      lines.push('!');
    }

    for (const line of this.aclLines) {
      const keyword = line.action === 'allow' ? 'permit' : 'deny';
      const port = line.port ? ` eq ${line.port}` : '';
      lines.push(`access-list ${line.acl} extended ${keyword} `
        + `${line.protocol} ${line.source} ${line.destination}${port}`);
    }

    if (this.fw.sameSecurityTrafficEnabled('inter-interface')) {
      lines.push('same-security-traffic permit inter-interface');
    }
    return lines.join('\n');
  }
}
