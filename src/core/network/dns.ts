/**
 * DNS Service - Domain Name System implementation for network simulation
 * Supports basic DNS resolution with A records and caching
 */

import {
  Packet,
  UDPDatagram,
  IPv4Packet,
  EthernetFrame,
  ETHER_TYPE,
  IP_PROTOCOL,
  generatePacketId,
} from './packet';

// DNS Port
export const DNS_PORT = 53;

// DNS Record Types
export enum DNSRecordType {
  A = 1,       // IPv4 address
  NS = 2,      // Name server
  CNAME = 5,   // Canonical name
  SOA = 6,     // Start of authority
  PTR = 12,    // Pointer (reverse DNS)
  MX = 15,     // Mail exchange
  TXT = 16,    // Text record
  AAAA = 28,   // IPv6 address
}

// DNS Query Class
export enum DNSClass {
  IN = 1,      // Internet
}

// DNS Response Codes
export enum DNSResponseCode {
  NOERROR = 0,
  FORMERR = 1,   // Format error
  SERVFAIL = 2,  // Server failure
  NXDOMAIN = 3,  // Non-existent domain
  NOTIMP = 4,    // Not implemented
  REFUSED = 5,   // Query refused
}

// DNS Header
export interface DNSHeader {
  id: number;              // Transaction ID
  flags: {
    qr: boolean;           // Query (0) / Response (1)
    opcode: number;        // 0 = standard query
    aa: boolean;           // Authoritative answer
    tc: boolean;           // Truncated
    rd: boolean;           // Recursion desired
    ra: boolean;           // Recursion available
    rcode: DNSResponseCode;
  };
  qdcount: number;         // Question count
  ancount: number;         // Answer count
  nscount: number;         // Authority count
  arcount: number;         // Additional count
}

// DNS Question
export interface DNSQuestion {
  name: string;
  type: DNSRecordType;
  class: DNSClass;
}

// DNS Resource Record
export interface DNSResourceRecord {
  name: string;
  type: DNSRecordType;
  class: DNSClass;
  ttl: number;
  data: string;            // For A record: IP address
}

// DNS Message
export interface DNSMessage {
  header: DNSHeader;
  questions: DNSQuestion[];
  answers: DNSResourceRecord[];
  authority: DNSResourceRecord[];
  additional: DNSResourceRecord[];
}

// DNS Cache Entry
interface DNSCacheEntry {
  records: DNSResourceRecord[];
  expiry: number;
}

/**
 * DNS Wire Format Encoder/Decoder
 * Implements RFC 1035 DNS message format
 */
export class DNSWireFormat {
  /**
   * Encode a domain name to DNS wire format (length-prefixed labels)
   * e.g., "www.example.com" -> [3,'w','w','w',7,'e','x','a','m','p','l','e',3,'c','o','m',0]
   */
  static encodeDomainName(name: string): Uint8Array {
    if (!name || name === '.') {
      return new Uint8Array([0]);
    }

    const labels = name.split('.');
    const parts: number[] = [];

    for (const label of labels) {
      if (label.length > 63) {
        throw new Error('DNS label exceeds 63 characters');
      }
      if (label.length > 0) {
        parts.push(label.length);
        for (let i = 0; i < label.length; i++) {
          parts.push(label.charCodeAt(i));
        }
      }
    }
    parts.push(0); // Null terminator

    return new Uint8Array(parts);
  }

  /**
   * Decode a domain name from DNS wire format
   */
  static decodeDomainName(data: Uint8Array, offset: number): { name: string; bytesRead: number } {
    const labels: string[] = [];
    let pos = offset;
    let bytesRead = 0;
    let jumped = false;
    let jumpedPos = -1;

    while (pos < data.length) {
      const len = data[pos];

      // Check for compression pointer (RFC 1035 section 4.1.4)
      if ((len & 0xc0) === 0xc0) {
        if (!jumped) {
          bytesRead = pos - offset + 2;
          jumped = true;
        }
        const pointer = ((len & 0x3f) << 8) | data[pos + 1];
        pos = pointer;
        continue;
      }

      if (len === 0) {
        if (!jumped) {
          bytesRead = pos - offset + 1;
        }
        break;
      }

      pos++;
      const label = String.fromCharCode(...data.slice(pos, pos + len));
      labels.push(label);
      pos += len;
    }

    return { name: labels.join('.'), bytesRead };
  }

  /**
   * Serialize a DNS message to wire format
   */
  static serialize(msg: DNSMessage): Uint8Array {
    const buffer: number[] = [];

    // Header (12 bytes)
    // Transaction ID (2 bytes)
    buffer.push((msg.header.id >> 8) & 0xff);
    buffer.push(msg.header.id & 0xff);

    // Flags (2 bytes)
    let flags = 0;
    if (msg.header.flags.qr) flags |= 0x8000;
    flags |= (msg.header.flags.opcode & 0x0f) << 11;
    if (msg.header.flags.aa) flags |= 0x0400;
    if (msg.header.flags.tc) flags |= 0x0200;
    if (msg.header.flags.rd) flags |= 0x0100;
    if (msg.header.flags.ra) flags |= 0x0080;
    flags |= msg.header.flags.rcode & 0x0f;
    buffer.push((flags >> 8) & 0xff);
    buffer.push(flags & 0xff);

    // Counts (8 bytes)
    buffer.push((msg.header.qdcount >> 8) & 0xff);
    buffer.push(msg.header.qdcount & 0xff);
    buffer.push((msg.header.ancount >> 8) & 0xff);
    buffer.push(msg.header.ancount & 0xff);
    buffer.push((msg.header.nscount >> 8) & 0xff);
    buffer.push(msg.header.nscount & 0xff);
    buffer.push((msg.header.arcount >> 8) & 0xff);
    buffer.push(msg.header.arcount & 0xff);

    // Questions
    for (const q of msg.questions) {
      const encodedName = this.encodeDomainName(q.name);
      buffer.push(...encodedName);
      buffer.push((q.type >> 8) & 0xff);
      buffer.push(q.type & 0xff);
      buffer.push((q.class >> 8) & 0xff);
      buffer.push(q.class & 0xff);
    }

    // Answers
    for (const rr of msg.answers) {
      this.serializeResourceRecord(buffer, rr);
    }

    // Authority
    for (const rr of msg.authority) {
      this.serializeResourceRecord(buffer, rr);
    }

    // Additional
    for (const rr of msg.additional) {
      this.serializeResourceRecord(buffer, rr);
    }

    return new Uint8Array(buffer);
  }

  /**
   * Serialize a resource record to the buffer
   */
  private static serializeResourceRecord(buffer: number[], rr: DNSResourceRecord): void {
    // Name
    const encodedName = this.encodeDomainName(rr.name);
    buffer.push(...encodedName);

    // Type (2 bytes)
    buffer.push((rr.type >> 8) & 0xff);
    buffer.push(rr.type & 0xff);

    // Class (2 bytes)
    buffer.push((rr.class >> 8) & 0xff);
    buffer.push(rr.class & 0xff);

    // TTL (4 bytes)
    buffer.push((rr.ttl >> 24) & 0xff);
    buffer.push((rr.ttl >> 16) & 0xff);
    buffer.push((rr.ttl >> 8) & 0xff);
    buffer.push(rr.ttl & 0xff);

    // RDATA
    let rdata: number[];
    if (rr.type === DNSRecordType.A) {
      // A record: 4 bytes IPv4 address
      rdata = rr.data.split('.').map(Number);
    } else if (rr.type === DNSRecordType.AAAA) {
      // AAAA record: 16 bytes IPv6 address (simplified)
      rdata = [];
      const parts = rr.data.split(':');
      for (const part of parts) {
        const val = parseInt(part, 16);
        rdata.push((val >> 8) & 0xff);
        rdata.push(val & 0xff);
      }
    } else {
      // Other types: encode as domain name or raw text
      const encoded = this.encodeDomainName(rr.data);
      rdata = Array.from(encoded);
    }

    // RDLENGTH (2 bytes)
    buffer.push((rdata.length >> 8) & 0xff);
    buffer.push(rdata.length & 0xff);

    // RDATA
    buffer.push(...rdata);
  }

  /**
   * Parse a DNS message from wire format
   */
  static parse(data: Uint8Array): DNSMessage | null {
    if (data.length < 12) {
      return null;
    }

    try {
      let offset = 0;

      // Header
      const id = (data[offset] << 8) | data[offset + 1];
      offset += 2;

      const flags = (data[offset] << 8) | data[offset + 1];
      offset += 2;

      const header: DNSHeader = {
        id,
        flags: {
          qr: (flags & 0x8000) !== 0,
          opcode: (flags >> 11) & 0x0f,
          aa: (flags & 0x0400) !== 0,
          tc: (flags & 0x0200) !== 0,
          rd: (flags & 0x0100) !== 0,
          ra: (flags & 0x0080) !== 0,
          rcode: flags & 0x0f,
        },
        qdcount: (data[offset] << 8) | data[offset + 1],
        ancount: (data[offset + 2] << 8) | data[offset + 3],
        nscount: (data[offset + 4] << 8) | data[offset + 5],
        arcount: (data[offset + 6] << 8) | data[offset + 7],
      };
      offset += 8;

      // Questions
      const questions: DNSQuestion[] = [];
      for (let i = 0; i < header.qdcount; i++) {
        const { name, bytesRead } = this.decodeDomainName(data, offset);
        offset += bytesRead;
        const type = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        const qclass = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        questions.push({ name, type, class: qclass });
      }

      // Parse resource records
      const parseRRs = (count: number): DNSResourceRecord[] => {
        const rrs: DNSResourceRecord[] = [];
        for (let i = 0; i < count; i++) {
          const { name, bytesRead } = this.decodeDomainName(data, offset);
          offset += bytesRead;

          const type = (data[offset] << 8) | data[offset + 1];
          offset += 2;
          const rclass = (data[offset] << 8) | data[offset + 1];
          offset += 2;
          const ttl = (data[offset] << 24) | (data[offset + 1] << 16) |
                      (data[offset + 2] << 8) | data[offset + 3];
          offset += 4;
          const rdlength = (data[offset] << 8) | data[offset + 1];
          offset += 2;

          let rdata = '';
          if (type === DNSRecordType.A && rdlength === 4) {
            rdata = `${data[offset]}.${data[offset + 1]}.${data[offset + 2]}.${data[offset + 3]}`;
          } else if (type === DNSRecordType.CNAME || type === DNSRecordType.NS || type === DNSRecordType.PTR) {
            const { name: domainData } = this.decodeDomainName(data, offset);
            rdata = domainData;
          } else {
            // Generic: convert to hex string
            rdata = Array.from(data.slice(offset, offset + rdlength))
              .map(b => b.toString(16).padStart(2, '0'))
              .join('');
          }
          offset += rdlength;

          rrs.push({ name, type, class: rclass, ttl, data: rdata });
        }
        return rrs;
      };

      const answers = parseRRs(header.ancount);
      const authority = parseRRs(header.nscount);
      const additional = parseRRs(header.arcount);

      return {
        header,
        questions,
        answers,
        authority,
        additional,
      };
    } catch {
      return null;
    }
  }
}

/**
 * DNS Server - Provides DNS resolution for the network
 */
export class DNSServer {
  private zones: Map<string, DNSZone> = new Map();
  private serverIP: string = '0.0.0.0';
  private serverMAC: string = '00:00:00:00:00:00';
  private packetSender?: (packet: Packet, interfaceId: string) => void;
  private interfaceId: string = '';

  // Simulated root/public DNS records for common domains
  private publicRecords: Map<string, string> = new Map([
    ['google.com', '142.250.80.46'],
    ['www.google.com', '142.250.80.46'],
    ['facebook.com', '157.240.1.35'],
    ['www.facebook.com', '157.240.1.35'],
    ['amazon.com', '54.239.28.85'],
    ['www.amazon.com', '54.239.28.85'],
    ['github.com', '140.82.121.3'],
    ['www.github.com', '140.82.121.3'],
    ['microsoft.com', '20.112.250.133'],
    ['www.microsoft.com', '20.112.250.133'],
    ['apple.com', '17.253.144.10'],
    ['www.apple.com', '17.253.144.10'],
    ['cloudflare.com', '104.16.132.229'],
    ['dns.google', '8.8.8.8'],
  ]);

  constructor() {}

  /**
   * Set packet sender
   */
  setPacketSender(sender: (packet: Packet, interfaceId: string) => void): void {
    this.packetSender = sender;
  }

  /**
   * Set server interface
   */
  setInterface(interfaceId: string, ipAddress: string, macAddress: string): void {
    this.interfaceId = interfaceId;
    this.serverIP = ipAddress;
    this.serverMAC = macAddress;
  }

  /**
   * Add a DNS zone
   */
  addZone(zone: DNSZone): void {
    this.zones.set(zone.name.toLowerCase(), zone);
  }

  /**
   * Add a record to a zone
   */
  addRecord(zoneName: string, record: DNSResourceRecord): void {
    const zone = this.zones.get(zoneName.toLowerCase());
    if (zone) {
      zone.records.push(record);
    }
  }

  /**
   * Add a static A record
   */
  addARecord(hostname: string, ipAddress: string, ttl: number = 3600): void {
    this.publicRecords.set(hostname.toLowerCase(), ipAddress);
  }

  /**
   * Process incoming DNS query
   */
  processQuery(dnsMessage: DNSMessage, sourceIP: string, sourceMAC: string, interfaceId: string): Packet | null {
    if (dnsMessage.header.flags.qr) {
      // This is a response, not a query
      return null;
    }

    const answers: DNSResourceRecord[] = [];

    for (const question of dnsMessage.questions) {
      const records = this.resolveQuestion(question);
      answers.push(...records);
    }

    // Build response
    const response: DNSMessage = {
      header: {
        id: dnsMessage.header.id,
        flags: {
          qr: true,
          opcode: 0,
          aa: true,
          tc: false,
          rd: dnsMessage.header.flags.rd,
          ra: true,
          rcode: answers.length > 0 ? DNSResponseCode.NOERROR : DNSResponseCode.NXDOMAIN,
        },
        qdcount: dnsMessage.questions.length,
        ancount: answers.length,
        nscount: 0,
        arcount: 0,
      },
      questions: dnsMessage.questions,
      answers,
      authority: [],
      additional: [],
    };

    return this.createDNSPacket(response, sourceIP, sourceMAC, interfaceId);
  }

  /**
   * Resolve a DNS question
   */
  private resolveQuestion(question: DNSQuestion): DNSResourceRecord[] {
    const name = question.name.toLowerCase();
    const records: DNSResourceRecord[] = [];

    // Check local zones first
    for (const zone of this.zones.values()) {
      if (name.endsWith(zone.name.toLowerCase()) || name === zone.name.toLowerCase()) {
        for (const record of zone.records) {
          if (record.name.toLowerCase() === name && record.type === question.type) {
            records.push(record);
          }
        }
      }
    }

    // If no local records, check public records (simulated internet)
    if (records.length === 0 && question.type === DNSRecordType.A) {
      const ip = this.publicRecords.get(name);
      if (ip) {
        records.push({
          name: question.name,
          type: DNSRecordType.A,
          class: DNSClass.IN,
          ttl: 300,
          data: ip,
        });
      }
    }

    return records;
  }

  /**
   * Create DNS response packet
   */
  private createDNSPacket(
    dnsMessage: DNSMessage,
    destIP: string,
    destMAC: string,
    interfaceId: string
  ): Packet {
    const udp: UDPDatagram = {
      sourcePort: DNS_PORT,
      destinationPort: DNS_PORT,
      length: 0,
      checksum: 0,
      payload: this.serializeDNSMessage(dnsMessage),
    };

    const ipv4: IPv4Packet = {
      version: 4,
      headerLength: 20,
      dscp: 0,
      totalLength: 0,
      identification: Math.floor(Math.random() * 65535),
      flags: 0,
      fragmentOffset: 0,
      ttl: 64,
      protocol: IP_PROTOCOL.UDP,
      headerChecksum: 0,
      sourceIP: this.serverIP,
      destinationIP: destIP,
      payload: udp,
    };

    const frame: EthernetFrame = {
      destinationMAC: destMAC,
      sourceMAC: this.serverMAC,
      etherType: ETHER_TYPE.IPv4,
      payload: ipv4,
    };

    return {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit',
    };
  }

  private serializeDNSMessage(msg: DNSMessage): Uint8Array {
    // Use proper DNS wire format
    return DNSWireFormat.serialize(msg);
  }
}

/**
 * DNS Zone
 */
export interface DNSZone {
  name: string;
  records: DNSResourceRecord[];
  soa?: {
    mname: string;    // Primary nameserver
    rname: string;    // Admin email
    serial: number;
    refresh: number;
    retry: number;
    expire: number;
    minimum: number;  // Minimum TTL
  };
}

/**
 * DNS Resolver (Client)
 */
export class DNSResolver {
  private cache: Map<string, DNSCacheEntry> = new Map();
  private nameservers: string[] = ['8.8.8.8', '8.8.4.4'];
  private searchDomains: string[] = [];
  private pendingQueries: Map<number, {
    resolve: (records: DNSResourceRecord[]) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    sourcePort: number;
    hostname: string;
  }> = new Map();
  private clientIP: string = '0.0.0.0';
  private clientMAC: string = '00:00:00:00:00:00';
  private packetSender?: (packet: Packet, interfaceId: string) => void;
  private interfaceId: string = '';
  private nextQueryId: number = 1;

  constructor() {}

  /**
   * Set nameservers
   */
  setNameservers(servers: string[]): void {
    this.nameservers = servers;
  }

  /**
   * Get nameservers
   */
  getNameservers(): string[] {
    return [...this.nameservers];
  }

  /**
   * Set search domains
   */
  setSearchDomains(domains: string[]): void {
    this.searchDomains = domains;
  }

  /**
   * Set packet sender
   */
  setPacketSender(sender: (packet: Packet, interfaceId: string) => void): void {
    this.packetSender = sender;
  }

  /**
   * Set client interface
   */
  setInterface(interfaceId: string, ipAddress: string, macAddress: string): void {
    this.interfaceId = interfaceId;
    this.clientIP = ipAddress;
    this.clientMAC = macAddress;
  }

  /**
   * Resolve hostname to IP address
   * Returns a promise that resolves with the IP or rejects on failure
   */
  resolve(hostname: string): { packet: Packet; promise: Promise<string> } {
    const name = hostname.toLowerCase();

    // Check cache first
    const cached = this.cache.get(name);
    if (cached && cached.expiry > Date.now()) {
      const aRecord = cached.records.find(r => r.type === DNSRecordType.A);
      if (aRecord) {
        return {
          packet: null as unknown as Packet,
          promise: Promise.resolve(aRecord.data),
        };
      }
    }

    // Generate unique query ID (sequential + random component for security)
    // Wraps around at 65535
    this.nextQueryId = (this.nextQueryId + Math.floor(Math.random() * 100) + 1) % 65536;
    const queryId = this.nextQueryId;

    // Generate random source port in ephemeral range
    const sourcePort = Math.floor(Math.random() * (65535 - 49152)) + 49152;

    const query = this.createQuery(hostname, queryId, sourcePort);

    const promise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingQueries.delete(queryId);
        reject(new Error('DNS query timeout'));
      }, 5000);

      this.pendingQueries.set(queryId, {
        resolve: (records) => {
          clearTimeout(timeout);
          const aRecord = records.find(r => r.type === DNSRecordType.A);
          if (aRecord) {
            // Cache the result
            this.cache.set(name, {
              records,
              expiry: Date.now() + (aRecord.ttl * 1000),
            });
            resolve(aRecord.data);
          } else {
            reject(new Error('No A record found'));
          }
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
        sourcePort,
        hostname: name,
      });
    });

    return { packet: query, promise };
  }

  /**
   * Process DNS response
   * @param dnsMessage - The DNS response message
   * @param destPort - Optional destination port from the UDP header for validation
   */
  processResponse(dnsMessage: DNSMessage, destPort?: number): void {
    const queryId = dnsMessage.header.id;
    const pending = this.pendingQueries.get(queryId);

    if (!pending) {
      return; // No matching query
    }

    // Validate source port if provided (defense against DNS spoofing)
    if (destPort !== undefined && destPort !== pending.sourcePort) {
      // Port mismatch - possible spoofing attempt, ignore
      return;
    }

    // Validate that this is actually a response
    if (!dnsMessage.header.flags.qr) {
      return; // Not a response
    }

    this.pendingQueries.delete(queryId);

    if (dnsMessage.header.flags.rcode !== DNSResponseCode.NOERROR) {
      pending.reject(new Error(`DNS error: ${DNSResponseCode[dnsMessage.header.flags.rcode]}`));
      return;
    }

    pending.resolve(dnsMessage.answers);
  }

  /**
   * Get pending query info for debugging
   */
  getPendingQueries(): Array<{ id: number; hostname: string; sourcePort: number }> {
    const queries: Array<{ id: number; hostname: string; sourcePort: number }> = [];
    for (const [id, pending] of this.pendingQueries) {
      queries.push({
        id,
        hostname: pending.hostname,
        sourcePort: pending.sourcePort,
      });
    }
    return queries;
  }

  /**
   * Cancel a pending query
   */
  cancelQuery(queryId: number): void {
    const pending = this.pendingQueries.get(queryId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingQueries.delete(queryId);
      pending.reject(new Error('Query cancelled'));
    }
  }

  /**
   * Cancel all pending queries
   */
  cancelAllQueries(): void {
    for (const [id, pending] of this.pendingQueries) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Query cancelled'));
    }
    this.pendingQueries.clear();
  }

  /**
   * Lookup hostname (synchronous, returns cached or simulated)
   * For use in terminal commands
   */
  lookup(hostname: string): string | null {
    const name = hostname.toLowerCase();

    // Check cache
    const cached = this.cache.get(name);
    if (cached && cached.expiry > Date.now()) {
      const aRecord = cached.records.find(r => r.type === DNSRecordType.A);
      if (aRecord) {
        return aRecord.data;
      }
    }

    // Simulated public DNS for common domains
    const publicRecords: Record<string, string> = {
      'google.com': '142.250.80.46',
      'www.google.com': '142.250.80.46',
      'facebook.com': '157.240.1.35',
      'github.com': '140.82.121.3',
      'microsoft.com': '20.112.250.133',
      'apple.com': '17.253.144.10',
      'amazon.com': '54.239.28.85',
      'cloudflare.com': '104.16.132.229',
      'dns.google': '8.8.8.8',
      'localhost': '127.0.0.1',
    };

    return publicRecords[name] || null;
  }

  /**
   * Get DNS cache entries
   */
  getCache(): Array<{ hostname: string; ip: string; ttl: number }> {
    const entries: Array<{ hostname: string; ip: string; ttl: number }> = [];
    const now = Date.now();

    for (const [hostname, entry] of this.cache) {
      if (entry.expiry > now) {
        const aRecord = entry.records.find(r => r.type === DNSRecordType.A);
        if (aRecord) {
          entries.push({
            hostname,
            ip: aRecord.data,
            ttl: Math.floor((entry.expiry - now) / 1000),
          });
        }
      }
    }

    return entries;
  }

  /**
   * Clear DNS cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Add entry to cache manually
   */
  addToCache(hostname: string, ip: string, ttl: number = 300): void {
    this.cache.set(hostname.toLowerCase(), {
      records: [{
        name: hostname,
        type: DNSRecordType.A,
        class: DNSClass.IN,
        ttl,
        data: ip,
      }],
      expiry: Date.now() + (ttl * 1000),
    });
  }

  /**
   * Create DNS query packet
   */
  private createQuery(hostname: string, queryId: number, sourcePort: number): Packet {
    const dnsMessage: DNSMessage = {
      header: {
        id: queryId,
        flags: {
          qr: false,
          opcode: 0,
          aa: false,
          tc: false,
          rd: true,
          ra: false,
          rcode: DNSResponseCode.NOERROR,
        },
        qdcount: 1,
        ancount: 0,
        nscount: 0,
        arcount: 0,
      },
      questions: [{
        name: hostname,
        type: DNSRecordType.A,
        class: DNSClass.IN,
      }],
      answers: [],
      authority: [],
      additional: [],
    };

    const udp: UDPDatagram = {
      sourcePort,
      destinationPort: DNS_PORT,
      length: 0,
      checksum: 0,
      payload: this.serializeDNSMessage(dnsMessage),
    };

    const nameserver = this.nameservers[0] || '8.8.8.8';

    const ipv4: IPv4Packet = {
      version: 4,
      headerLength: 20,
      dscp: 0,
      totalLength: 0,
      identification: Math.floor(Math.random() * 65535),
      flags: 0,
      fragmentOffset: 0,
      ttl: 64,
      protocol: IP_PROTOCOL.UDP,
      headerChecksum: 0,
      sourceIP: this.clientIP,
      destinationIP: nameserver,
      payload: udp,
    };

    const frame: EthernetFrame = {
      destinationMAC: '00:00:00:00:00:00', // Will be resolved by ARP
      sourceMAC: this.clientMAC,
      etherType: ETHER_TYPE.IPv4,
      payload: ipv4,
    };

    return {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit',
    };
  }

  private serializeDNSMessage(msg: DNSMessage): Uint8Array {
    // Use proper DNS wire format
    return DNSWireFormat.serialize(msg);
  }
}

/**
 * Parse DNS message from UDP payload
 * Supports both binary wire format and JSON (for backwards compatibility)
 */
export function parseDNSMessage(payload: Uint8Array): DNSMessage | null {
  // Try binary wire format first
  const binaryResult = DNSWireFormat.parse(payload);
  if (binaryResult) {
    return binaryResult;
  }

  // Fallback to JSON for backwards compatibility
  try {
    const decoder = new TextDecoder();
    const json = decoder.decode(payload);
    return JSON.parse(json) as DNSMessage;
  } catch {
    return null;
  }
}

/**
 * Serialize DNS message to wire format
 */
export function serializeDNSMessage(msg: DNSMessage): Uint8Array {
  return DNSWireFormat.serialize(msg);
}

/**
 * Check if UDP packet is DNS
 */
export function isDNSPacket(udp: UDPDatagram): boolean {
  return udp.sourcePort === DNS_PORT || udp.destinationPort === DNS_PORT;
}
