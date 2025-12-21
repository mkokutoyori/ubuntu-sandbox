/**
 * ACL Service - Access Control List implementation
 * Supports Standard and Extended ACLs for Cisco routers
 */

import { IP_PROTOCOL } from './packet';

// ACL Entry (ACE - Access Control Entry)
export interface ACLEntry {
  sequence: number;
  action: 'permit' | 'deny';
  protocol?: number | 'ip' | 'tcp' | 'udp' | 'icmp' | 'any';
  sourceIP: string;
  sourceWildcard: string;
  sourcePort?: PortMatch;
  destIP?: string;
  destWildcard?: string;
  destPort?: PortMatch;
  established?: boolean;  // For TCP established connections
  log?: boolean;
  hits: number;
}

// Port matching options
export interface PortMatch {
  operator: 'eq' | 'neq' | 'lt' | 'gt' | 'range';
  port: number;
  portEnd?: number;  // For range operator
}

// ACL Types
export type ACLType = 'standard' | 'extended';

// Access Control List
export interface ACL {
  number?: number;         // For numbered ACLs
  name?: string;           // For named ACLs
  type: ACLType;
  entries: ACLEntry[];
  remark?: string;
}

// Interface ACL binding
export interface InterfaceACLBinding {
  interfaceName: string;
  aclIdentifier: number | string;
  direction: 'in' | 'out';
}

// Protocol name to number mapping
export const PROTOCOL_MAP: Record<string, number> = {
  'ip': 0,      // Match any IP protocol
  'icmp': 1,
  'tcp': 6,
  'udp': 17,
  'gre': 47,
  'esp': 50,
  'ah': 51,
  'eigrp': 88,
  'ospf': 89,
};

// Common port numbers
export const PORT_MAP: Record<string, number> = {
  'ftp-data': 20,
  'ftp': 21,
  'ssh': 22,
  'telnet': 23,
  'smtp': 25,
  'dns': 53,
  'dhcp': 67,
  'tftp': 69,
  'http': 80,
  'pop3': 110,
  'ntp': 123,
  'snmp': 161,
  'https': 443,
  'www': 80,
};

/**
 * ACL Service for Cisco routers
 */
export class ACLService {
  private numberedACLs: Map<number, ACL> = new Map();
  private namedACLs: Map<string, ACL> = new Map();
  private interfaceBindings: InterfaceACLBinding[] = [];
  private nextSequence: Map<number | string, number> = new Map();

  constructor() {}

  /**
   * Check if ACL number is valid for standard ACL
   */
  isStandardACLNumber(num: number): boolean {
    return (num >= 1 && num <= 99) || (num >= 1300 && num <= 1999);
  }

  /**
   * Check if ACL number is valid for extended ACL
   */
  isExtendedACLNumber(num: number): boolean {
    return (num >= 100 && num <= 199) || (num >= 2000 && num <= 2699);
  }

  /**
   * Get or create a numbered ACL
   */
  getOrCreateNumberedACL(number: number): ACL {
    let acl = this.numberedACLs.get(number);
    if (!acl) {
      const type: ACLType = this.isStandardACLNumber(number) ? 'standard' : 'extended';
      acl = { number, type, entries: [] };
      this.numberedACLs.set(number, acl);
      this.nextSequence.set(number, 10);
    }
    return acl;
  }

  /**
   * Get or create a named ACL
   */
  getOrCreateNamedACL(name: string, type: ACLType): ACL {
    let acl = this.namedACLs.get(name);
    if (!acl) {
      acl = { name, type, entries: [] };
      this.namedACLs.set(name, acl);
      this.nextSequence.set(name, 10);
    }
    return acl;
  }

  /**
   * Add entry to numbered ACL
   */
  addNumberedEntry(aclNumber: number, entry: Omit<ACLEntry, 'sequence' | 'hits'>): void {
    const acl = this.getOrCreateNumberedACL(aclNumber);
    const sequence = this.nextSequence.get(aclNumber) || 10;

    acl.entries.push({
      ...entry,
      sequence,
      hits: 0,
    });

    // Sort entries by sequence
    acl.entries.sort((a, b) => a.sequence - b.sequence);
    this.nextSequence.set(aclNumber, sequence + 10);
  }

  /**
   * Add entry to named ACL
   */
  addNamedEntry(aclName: string, type: ACLType, entry: Omit<ACLEntry, 'sequence' | 'hits'>, sequence?: number): void {
    const acl = this.getOrCreateNamedACL(aclName, type);
    const seq = sequence || this.nextSequence.get(aclName) || 10;

    acl.entries.push({
      ...entry,
      sequence: seq,
      hits: 0,
    });

    // Sort entries by sequence
    acl.entries.sort((a, b) => a.sequence - b.sequence);

    if (!sequence) {
      this.nextSequence.set(aclName, seq + 10);
    }
  }

  /**
   * Remove entry from ACL by sequence number
   */
  removeEntry(aclIdentifier: number | string, sequence: number): boolean {
    const acl = typeof aclIdentifier === 'number'
      ? this.numberedACLs.get(aclIdentifier)
      : this.namedACLs.get(aclIdentifier);

    if (!acl) return false;

    const index = acl.entries.findIndex(e => e.sequence === sequence);
    if (index === -1) return false;

    acl.entries.splice(index, 1);
    return true;
  }

  /**
   * Delete entire ACL
   */
  deleteACL(aclIdentifier: number | string): boolean {
    if (typeof aclIdentifier === 'number') {
      return this.numberedACLs.delete(aclIdentifier);
    } else {
      return this.namedACLs.delete(aclIdentifier);
    }
  }

  /**
   * Get ACL by identifier
   */
  getACL(aclIdentifier: number | string): ACL | undefined {
    if (typeof aclIdentifier === 'number') {
      return this.numberedACLs.get(aclIdentifier);
    } else {
      return this.namedACLs.get(aclIdentifier);
    }
  }

  /**
   * Get all numbered ACLs
   */
  getNumberedACLs(): ACL[] {
    return Array.from(this.numberedACLs.values());
  }

  /**
   * Get all named ACLs
   */
  getNamedACLs(): ACL[] {
    return Array.from(this.namedACLs.values());
  }

  /**
   * Get all ACLs
   */
  getAllACLs(): ACL[] {
    return [...this.getNumberedACLs(), ...this.getNamedACLs()];
  }

  /**
   * Bind ACL to interface
   */
  bindToInterface(interfaceName: string, aclIdentifier: number | string, direction: 'in' | 'out'): void {
    // Remove existing binding for same interface and direction
    this.interfaceBindings = this.interfaceBindings.filter(
      b => !(b.interfaceName === interfaceName && b.direction === direction)
    );

    this.interfaceBindings.push({ interfaceName, aclIdentifier, direction });
  }

  /**
   * Unbind ACL from interface
   */
  unbindFromInterface(interfaceName: string, direction: 'in' | 'out'): boolean {
    const before = this.interfaceBindings.length;
    this.interfaceBindings = this.interfaceBindings.filter(
      b => !(b.interfaceName === interfaceName && b.direction === direction)
    );
    return this.interfaceBindings.length < before;
  }

  /**
   * Get interface bindings
   */
  getInterfaceBindings(): InterfaceACLBinding[] {
    return [...this.interfaceBindings];
  }

  /**
   * Get ACL binding for an interface
   */
  getInterfaceACL(interfaceName: string, direction: 'in' | 'out'): ACL | undefined {
    const binding = this.interfaceBindings.find(
      b => b.interfaceName === interfaceName && b.direction === direction
    );

    if (!binding) return undefined;

    return this.getACL(binding.aclIdentifier);
  }

  /**
   * Check packet against ACL - returns true if permitted
   */
  checkPacket(
    aclIdentifier: number | string,
    sourceIP: string,
    destIP?: string,
    protocol?: number,
    sourcePort?: number,
    destPort?: number
  ): boolean {
    const acl = this.getACL(aclIdentifier);
    if (!acl) {
      return true; // No ACL = permit all
    }

    // Process each entry in order
    for (const entry of acl.entries) {
      const match = this.matchEntry(entry, acl.type, sourceIP, destIP, protocol, sourcePort, destPort);
      if (match) {
        entry.hits++;
        return entry.action === 'permit';
      }
    }

    // Implicit deny at end of ACL
    return false;
  }

  /**
   * Check if source IP is permitted by standard ACL
   */
  checkStandardACL(aclNumber: number, sourceIP: string): boolean {
    return this.checkPacket(aclNumber, sourceIP);
  }

  /**
   * Match a single ACL entry
   */
  private matchEntry(
    entry: ACLEntry,
    aclType: ACLType,
    sourceIP: string,
    destIP?: string,
    protocol?: number,
    sourcePort?: number,
    destPort?: number
  ): boolean {
    // Check source IP
    if (!this.matchIP(sourceIP, entry.sourceIP, entry.sourceWildcard)) {
      return false;
    }

    // Standard ACL only checks source IP
    if (aclType === 'standard') {
      return true;
    }

    // Extended ACL checks
    // Check protocol
    if (entry.protocol !== undefined && entry.protocol !== 'ip' && entry.protocol !== 'any') {
      const entryProtocol = typeof entry.protocol === 'string'
        ? PROTOCOL_MAP[entry.protocol] || 0
        : entry.protocol;

      if (protocol !== entryProtocol) {
        return false;
      }
    }

    // Check destination IP
    if (entry.destIP && entry.destWildcard) {
      if (!this.matchIP(destIP || '', entry.destIP, entry.destWildcard)) {
        return false;
      }
    }

    // Check source port
    if (entry.sourcePort && sourcePort !== undefined) {
      if (!this.matchPort(sourcePort, entry.sourcePort)) {
        return false;
      }
    }

    // Check destination port
    if (entry.destPort && destPort !== undefined) {
      if (!this.matchPort(destPort, entry.destPort)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Match IP address against network/wildcard
   */
  matchIP(ip: string, network: string, wildcard: string): boolean {
    // Handle special cases
    if (network === 'any' || network === '0.0.0.0' && wildcard === '255.255.255.255') {
      return true;
    }

    if (network === 'host') {
      // Next parameter is the host IP, which should be in wildcard position
      return ip === wildcard;
    }

    const ipNum = this.ipToNumber(ip);
    const networkNum = this.ipToNumber(network);
    const wildcardNum = this.ipToNumber(wildcard);

    // Wildcard mask: 0 means must match, 1 means don't care
    // So IP matches if: (IP XOR Network) AND NOT(Wildcard) == 0
    return ((ipNum ^ networkNum) & ~wildcardNum) === 0;
  }

  /**
   * Match port against port match criteria
   */
  private matchPort(port: number, match: PortMatch): boolean {
    switch (match.operator) {
      case 'eq':
        return port === match.port;
      case 'neq':
        return port !== match.port;
      case 'lt':
        return port < match.port;
      case 'gt':
        return port > match.port;
      case 'range':
        return port >= match.port && port <= (match.portEnd || match.port);
      default:
        return false;
    }
  }

  /**
   * Parse port specification from CLI
   */
  parsePort(portStr: string): number {
    // Check if it's a named port
    const namedPort = PORT_MAP[portStr.toLowerCase()];
    if (namedPort !== undefined) {
      return namedPort;
    }

    // Otherwise parse as number
    const num = parseInt(portStr, 10);
    if (isNaN(num) || num < 0 || num > 65535) {
      throw new Error(`Invalid port: ${portStr}`);
    }
    return num;
  }

  /**
   * Parse protocol specification from CLI
   */
  parseProtocol(protocolStr: string): number | 'ip' {
    const lower = protocolStr.toLowerCase();
    if (lower === 'ip') {
      return 'ip';
    }

    const named = PROTOCOL_MAP[lower];
    if (named !== undefined) {
      return named;
    }

    const num = parseInt(protocolStr, 10);
    if (isNaN(num) || num < 0 || num > 255) {
      throw new Error(`Invalid protocol: ${protocolStr}`);
    }
    return num;
  }

  /**
   * Format ACL entry for display
   */
  formatEntry(entry: ACLEntry, type: ACLType): string {
    let result = `${entry.sequence} ${entry.action}`;

    if (type === 'extended') {
      // Protocol
      if (entry.protocol !== undefined) {
        if (typeof entry.protocol === 'string') {
          result += ` ${entry.protocol}`;
        } else {
          const protocolName = Object.entries(PROTOCOL_MAP).find(([_, v]) => v === entry.protocol)?.[0];
          result += ` ${protocolName || entry.protocol}`;
        }
      }
    }

    // Source
    if (entry.sourceIP === '0.0.0.0' && entry.sourceWildcard === '255.255.255.255') {
      result += ' any';
    } else if (entry.sourceWildcard === '0.0.0.0') {
      result += ` host ${entry.sourceIP}`;
    } else {
      result += ` ${entry.sourceIP} ${entry.sourceWildcard}`;
    }

    // Source port (for extended)
    if (type === 'extended' && entry.sourcePort) {
      result += ` ${entry.sourcePort.operator} ${this.formatPort(entry.sourcePort.port)}`;
      if (entry.sourcePort.operator === 'range' && entry.sourcePort.portEnd) {
        result += ` ${this.formatPort(entry.sourcePort.portEnd)}`;
      }
    }

    // Destination (for extended)
    if (type === 'extended' && entry.destIP !== undefined) {
      if (entry.destIP === '0.0.0.0' && entry.destWildcard === '255.255.255.255') {
        result += ' any';
      } else if (entry.destWildcard === '0.0.0.0') {
        result += ` host ${entry.destIP}`;
      } else {
        result += ` ${entry.destIP} ${entry.destWildcard}`;
      }

      // Destination port
      if (entry.destPort) {
        result += ` ${entry.destPort.operator} ${this.formatPort(entry.destPort.port)}`;
        if (entry.destPort.operator === 'range' && entry.destPort.portEnd) {
          result += ` ${this.formatPort(entry.destPort.portEnd)}`;
        }
      }
    }

    if (entry.established) {
      result += ' established';
    }

    if (entry.log) {
      result += ' log';
    }

    return result;
  }

  /**
   * Format port number, using name if available
   */
  private formatPort(port: number): string {
    const name = Object.entries(PORT_MAP).find(([_, v]) => v === port)?.[0];
    return name || String(port);
  }

  /**
   * Get ACL statistics
   */
  getStatistics(): {
    totalACLs: number;
    numberedACLs: number;
    namedACLs: number;
    totalEntries: number;
    interfaceBindings: number;
  } {
    const allACLs = this.getAllACLs();
    return {
      totalACLs: allACLs.length,
      numberedACLs: this.numberedACLs.size,
      namedACLs: this.namedACLs.size,
      totalEntries: allACLs.reduce((sum, acl) => sum + acl.entries.length, 0),
      interfaceBindings: this.interfaceBindings.length,
    };
  }

  // Helper function
  private ipToNumber(ip: string): number {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }
}

/**
 * Parse standard ACL from command line
 * Format: access-list <number> {permit|deny} <source> [wildcard]
 */
export function parseStandardACL(args: string[]): Omit<ACLEntry, 'sequence' | 'hits'> | null {
  if (args.length < 1) return null;

  const action = args[0].toLowerCase() as 'permit' | 'deny';
  if (action !== 'permit' && action !== 'deny') return null;

  let sourceIP = '0.0.0.0';
  let sourceWildcard = '255.255.255.255';

  if (args[1] === 'any') {
    sourceIP = '0.0.0.0';
    sourceWildcard = '255.255.255.255';
  } else if (args[1] === 'host') {
    sourceIP = args[2];
    sourceWildcard = '0.0.0.0';
  } else {
    sourceIP = args[1];
    sourceWildcard = args[2] || '0.0.0.0';
  }

  return { action, sourceIP, sourceWildcard };
}

/**
 * Parse extended ACL from command line
 * Format: access-list <number> {permit|deny} <protocol> <source> [port] <dest> [port] [options]
 */
export function parseExtendedACL(args: string[]): Omit<ACLEntry, 'sequence' | 'hits'> | null {
  if (args.length < 3) return null;

  const action = args[0].toLowerCase() as 'permit' | 'deny';
  if (action !== 'permit' && action !== 'deny') return null;

  const protocol = args[1].toLowerCase();
  let idx = 2;

  // Parse source
  let sourceIP = '0.0.0.0';
  let sourceWildcard = '255.255.255.255';
  let sourcePort: PortMatch | undefined;

  if (args[idx] === 'any') {
    sourceIP = '0.0.0.0';
    sourceWildcard = '255.255.255.255';
    idx++;
  } else if (args[idx] === 'host') {
    sourceIP = args[idx + 1];
    sourceWildcard = '0.0.0.0';
    idx += 2;
  } else {
    sourceIP = args[idx];
    sourceWildcard = args[idx + 1];
    idx += 2;
  }

  // Check for source port (for TCP/UDP)
  if ((protocol === 'tcp' || protocol === 'udp') &&
      ['eq', 'neq', 'lt', 'gt', 'range'].includes(args[idx])) {
    const operator = args[idx] as PortMatch['operator'];
    const port = parseInt(args[idx + 1]) || PORT_MAP[args[idx + 1].toLowerCase()] || 0;
    idx += 2;

    if (operator === 'range') {
      const portEnd = parseInt(args[idx]) || PORT_MAP[args[idx].toLowerCase()] || 0;
      idx++;
      sourcePort = { operator, port, portEnd };
    } else {
      sourcePort = { operator, port };
    }
  }

  // Parse destination
  let destIP = '0.0.0.0';
  let destWildcard = '255.255.255.255';
  let destPort: PortMatch | undefined;

  if (args[idx] === 'any') {
    destIP = '0.0.0.0';
    destWildcard = '255.255.255.255';
    idx++;
  } else if (args[idx] === 'host') {
    destIP = args[idx + 1];
    destWildcard = '0.0.0.0';
    idx += 2;
  } else if (args[idx]) {
    destIP = args[idx];
    destWildcard = args[idx + 1] || '0.0.0.0';
    idx += 2;
  }

  // Check for destination port
  if ((protocol === 'tcp' || protocol === 'udp') &&
      ['eq', 'neq', 'lt', 'gt', 'range'].includes(args[idx])) {
    const operator = args[idx] as PortMatch['operator'];
    const port = parseInt(args[idx + 1]) || PORT_MAP[args[idx + 1]?.toLowerCase()] || 0;
    idx += 2;

    if (operator === 'range') {
      const portEnd = parseInt(args[idx]) || PORT_MAP[args[idx]?.toLowerCase()] || 0;
      idx++;
      destPort = { operator, port, portEnd };
    } else {
      destPort = { operator, port };
    }
  }

  // Check for options
  let established = false;
  let log = false;

  while (idx < args.length) {
    if (args[idx] === 'established') {
      established = true;
    } else if (args[idx] === 'log') {
      log = true;
    }
    idx++;
  }

  return {
    action,
    protocol: PROTOCOL_MAP[protocol] || protocol as any,
    sourceIP,
    sourceWildcard,
    sourcePort,
    destIP,
    destWildcard,
    destPort,
    established,
    log,
  };
}
