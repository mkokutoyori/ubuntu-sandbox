/**
 * NAT/PAT Service - Network Address Translation implementation
 * Supports Static NAT, Dynamic NAT, and PAT (overload)
 */

import {
  Packet,
  IPv4Packet,
  UDPDatagram,
  EthernetFrame,
  ETHER_TYPE,
  IP_PROTOCOL,
  generatePacketId,
} from './packet';

// NAT Translation Entry
export interface NATTranslation {
  insideLocal: string;      // Inside local IP
  insideGlobal: string;     // Inside global IP (after NAT)
  outsideLocal: string;     // Outside local IP
  outsideGlobal: string;    // Outside global IP
  protocol?: number;        // Protocol (TCP=6, UDP=17, ICMP=1)
  insidePort?: number;      // Inside port (for PAT)
  outsidePort?: number;     // Outside port (for PAT)
  translatedPort?: number;  // Translated port (for PAT)
  type: 'static' | 'dynamic' | 'pat';
  timeout: number;          // Timeout in seconds
  lastUsed: number;         // Timestamp of last use
  hits: number;             // Number of times used
}

// NAT Pool Configuration
export interface NATPool {
  name: string;
  startIP: string;
  endIP: string;
  netmask: string;
  type: 'pool' | 'overload';  // overload = PAT
}

// Static NAT Entry
export interface StaticNATEntry {
  insideLocal: string;
  insideGlobal: string;
}

// NAT Access List binding
export interface NATAccessListBinding {
  aclNumber: number;
  poolName?: string;
  interfaceName?: string;
  overload: boolean;
}

/**
 * NAT Service for Cisco routers
 */
export class NATService {
  private pools: Map<string, NATPool> = new Map();
  private staticEntries: StaticNATEntry[] = [];
  private accessListBindings: NATAccessListBinding[] = [];
  private translations: Map<string, NATTranslation> = new Map();
  private insideInterfaces: Set<string> = new Set();
  private outsideInterfaces: Set<string> = new Set();
  private nextPATPort: number = 1024;
  private translationTimeout: number = 86400; // 24 hours default

  // Statistics
  private stats = {
    hits: 0,
    misses: 0,
    expiredTranslations: 0,
  };

  constructor() {}

  /**
   * Configure interface as NAT inside
   */
  setInsideInterface(interfaceName: string): void {
    this.insideInterfaces.add(interfaceName);
    this.outsideInterfaces.delete(interfaceName);
  }

  /**
   * Configure interface as NAT outside
   */
  setOutsideInterface(interfaceName: string): void {
    this.outsideInterfaces.add(interfaceName);
    this.insideInterfaces.delete(interfaceName);
  }

  /**
   * Check if interface is NAT inside
   */
  isInsideInterface(interfaceName: string): boolean {
    return this.insideInterfaces.has(interfaceName);
  }

  /**
   * Check if interface is NAT outside
   */
  isOutsideInterface(interfaceName: string): boolean {
    return this.outsideInterfaces.has(interfaceName);
  }

  /**
   * Get inside interfaces
   */
  getInsideInterfaces(): string[] {
    return Array.from(this.insideInterfaces);
  }

  /**
   * Get outside interfaces
   */
  getOutsideInterfaces(): string[] {
    return Array.from(this.outsideInterfaces);
  }

  /**
   * Add a NAT pool
   */
  addPool(pool: NATPool): void {
    this.pools.set(pool.name, pool);
  }

  /**
   * Remove a NAT pool
   */
  removePool(name: string): void {
    this.pools.delete(name);
  }

  /**
   * Get a NAT pool
   */
  getPool(name: string): NATPool | undefined {
    return this.pools.get(name);
  }

  /**
   * Get all pools
   */
  getPools(): NATPool[] {
    return Array.from(this.pools.values());
  }

  /**
   * Add static NAT entry
   */
  addStaticNAT(insideLocal: string, insideGlobal: string): void {
    // Remove existing entry for this inside local
    this.staticEntries = this.staticEntries.filter(e => e.insideLocal !== insideLocal);
    this.staticEntries.push({ insideLocal, insideGlobal });

    // Create translation entry
    const key = `static:${insideLocal}`;
    this.translations.set(key, {
      insideLocal,
      insideGlobal,
      outsideLocal: '',
      outsideGlobal: '',
      type: 'static',
      timeout: 0, // Never expires
      lastUsed: Date.now(),
      hits: 0,
    });
  }

  /**
   * Remove static NAT entry
   */
  removeStaticNAT(insideLocal: string): void {
    this.staticEntries = this.staticEntries.filter(e => e.insideLocal !== insideLocal);
    this.translations.delete(`static:${insideLocal}`);
  }

  /**
   * Get static NAT entries
   */
  getStaticEntries(): StaticNATEntry[] {
    return [...this.staticEntries];
  }

  /**
   * Bind access list to NAT pool or interface
   */
  bindAccessList(binding: NATAccessListBinding): void {
    // Remove existing binding for this ACL
    this.accessListBindings = this.accessListBindings.filter(
      b => b.aclNumber !== binding.aclNumber
    );
    this.accessListBindings.push(binding);
  }

  /**
   * Remove access list binding
   */
  unbindAccessList(aclNumber: number): void {
    this.accessListBindings = this.accessListBindings.filter(
      b => b.aclNumber !== aclNumber
    );
  }

  /**
   * Get access list bindings
   */
  getAccessListBindings(): NATAccessListBinding[] {
    return [...this.accessListBindings];
  }

  /**
   * Translate outgoing packet (inside to outside)
   */
  translateOutgoing(
    packet: Packet,
    sourceInterface: string,
    outsideIP: string,
    checkACL: (aclNumber: number, sourceIP: string) => boolean
  ): { translated: boolean; packet: Packet } {
    if (!this.isInsideInterface(sourceInterface)) {
      return { translated: false, packet };
    }

    const frame = packet.frame;
    if (frame.etherType !== ETHER_TYPE.IPv4) {
      return { translated: false, packet };
    }

    const ipPacket = frame.payload as IPv4Packet;
    const sourceIP = ipPacket.sourceIP;

    // Check for static NAT first
    const staticEntry = this.staticEntries.find(e => e.insideLocal === sourceIP);
    if (staticEntry) {
      const key = `static:${sourceIP}`;
      const translation = this.translations.get(key);
      if (translation) {
        translation.hits++;
        translation.lastUsed = Date.now();
        this.stats.hits++;
      }
      return {
        translated: true,
        packet: this.rewriteSourceIP(packet, staticEntry.insideGlobal),
      };
    }

    // Check access list bindings for dynamic NAT/PAT
    for (const binding of this.accessListBindings) {
      if (checkACL(binding.aclNumber, sourceIP)) {
        if (binding.overload) {
          // PAT (overload)
          return this.translatePAT(packet, sourceIP, outsideIP);
        } else if (binding.poolName) {
          // Dynamic NAT from pool
          const pool = this.pools.get(binding.poolName);
          if (pool) {
            return this.translateDynamicNAT(packet, sourceIP, pool);
          }
        }
      }
    }

    this.stats.misses++;
    return { translated: false, packet };
  }

  /**
   * Translate incoming packet (outside to inside)
   */
  translateIncoming(
    packet: Packet,
    sourceInterface: string
  ): { translated: boolean; packet: Packet } {
    if (!this.isOutsideInterface(sourceInterface)) {
      return { translated: false, packet };
    }

    const frame = packet.frame;
    if (frame.etherType !== ETHER_TYPE.IPv4) {
      return { translated: false, packet };
    }

    const ipPacket = frame.payload as IPv4Packet;
    const destIP = ipPacket.destinationIP;

    // Check for static NAT (reverse lookup)
    const staticEntry = this.staticEntries.find(e => e.insideGlobal === destIP);
    if (staticEntry) {
      const key = `static:${staticEntry.insideLocal}`;
      const translation = this.translations.get(key);
      if (translation) {
        translation.hits++;
        translation.lastUsed = Date.now();
        this.stats.hits++;
      }
      return {
        translated: true,
        packet: this.rewriteDestIP(packet, staticEntry.insideLocal),
      };
    }

    // Check dynamic translations
    for (const [key, translation] of this.translations) {
      if (translation.type === 'pat') {
        // For PAT, check destination IP and port
        if (translation.insideGlobal === destIP) {
          const protocol = ipPacket.protocol;
          if (protocol === IP_PROTOCOL.UDP || protocol === IP_PROTOCOL.TCP) {
            const transportPacket = ipPacket.payload as UDPDatagram;
            if (transportPacket.destinationPort === translation.translatedPort) {
              translation.hits++;
              translation.lastUsed = Date.now();
              this.stats.hits++;
              return {
                translated: true,
                packet: this.rewriteDestIPAndPort(
                  packet,
                  translation.insideLocal,
                  translation.insidePort!
                ),
              };
            }
          }
        }
      } else if (translation.type === 'dynamic') {
        if (translation.insideGlobal === destIP) {
          translation.hits++;
          translation.lastUsed = Date.now();
          this.stats.hits++;
          return {
            translated: true,
            packet: this.rewriteDestIP(packet, translation.insideLocal),
          };
        }
      }
    }

    this.stats.misses++;
    return { translated: false, packet };
  }

  /**
   * Perform PAT translation
   */
  private translatePAT(
    packet: Packet,
    insideLocal: string,
    outsideIP: string
  ): { translated: boolean; packet: Packet } {
    const frame = packet.frame;
    const ipPacket = frame.payload as IPv4Packet;
    const protocol = ipPacket.protocol;

    let insidePort = 0;
    if (protocol === IP_PROTOCOL.UDP || protocol === IP_PROTOCOL.TCP) {
      const transportPacket = ipPacket.payload as UDPDatagram;
      insidePort = transportPacket.sourcePort;
    }

    // Check for existing translation
    const existingKey = `pat:${insideLocal}:${insidePort}:${protocol}`;
    let translation = this.translations.get(existingKey);

    if (!translation) {
      // Create new PAT translation
      const translatedPort = this.getNextPATPort();
      translation = {
        insideLocal,
        insideGlobal: outsideIP,
        outsideLocal: '',
        outsideGlobal: '',
        protocol,
        insidePort,
        translatedPort,
        type: 'pat',
        timeout: this.translationTimeout,
        lastUsed: Date.now(),
        hits: 0,
      };
      this.translations.set(existingKey, translation);
    }

    translation.hits++;
    translation.lastUsed = Date.now();
    this.stats.hits++;

    // Rewrite source IP and port
    return {
      translated: true,
      packet: this.rewriteSourceIPAndPort(packet, outsideIP, translation.translatedPort!),
    };
  }

  /**
   * Perform dynamic NAT translation
   */
  private translateDynamicNAT(
    packet: Packet,
    insideLocal: string,
    pool: NATPool
  ): { translated: boolean; packet: Packet } {
    // Check for existing translation
    const existingKey = `dynamic:${insideLocal}`;
    let translation = this.translations.get(existingKey);

    if (!translation) {
      // Get an IP from the pool
      const globalIP = this.getIPFromPool(pool);
      if (!globalIP) {
        this.stats.misses++;
        return { translated: false, packet };
      }

      translation = {
        insideLocal,
        insideGlobal: globalIP,
        outsideLocal: '',
        outsideGlobal: '',
        type: 'dynamic',
        timeout: this.translationTimeout,
        lastUsed: Date.now(),
        hits: 0,
      };
      this.translations.set(existingKey, translation);
    }

    translation.hits++;
    translation.lastUsed = Date.now();
    this.stats.hits++;

    return {
      translated: true,
      packet: this.rewriteSourceIP(packet, translation.insideGlobal),
    };
  }

  /**
   * Get next available PAT port
   */
  private getNextPATPort(): number {
    const port = this.nextPATPort;
    this.nextPATPort++;
    if (this.nextPATPort > 65535) {
      this.nextPATPort = 1024;
    }
    return port;
  }

  /**
   * Get an IP address from a pool
   */
  private getIPFromPool(pool: NATPool): string | null {
    const startNum = this.ipToNumber(pool.startIP);
    const endNum = this.ipToNumber(pool.endIP);

    // Find first unused IP in pool
    for (let ip = startNum; ip <= endNum; ip++) {
      const ipStr = this.numberToIP(ip);
      const inUse = Array.from(this.translations.values()).some(
        t => t.type === 'dynamic' && t.insideGlobal === ipStr
      );
      if (!inUse) {
        return ipStr;
      }
    }

    return null;
  }

  /**
   * Rewrite source IP in packet
   */
  private rewriteSourceIP(packet: Packet, newSourceIP: string): Packet {
    const newPacket = JSON.parse(JSON.stringify(packet)) as Packet;
    const ipPacket = newPacket.frame.payload as IPv4Packet;
    ipPacket.sourceIP = newSourceIP;
    return newPacket;
  }

  /**
   * Rewrite destination IP in packet
   */
  private rewriteDestIP(packet: Packet, newDestIP: string): Packet {
    const newPacket = JSON.parse(JSON.stringify(packet)) as Packet;
    const ipPacket = newPacket.frame.payload as IPv4Packet;
    ipPacket.destinationIP = newDestIP;
    return newPacket;
  }

  /**
   * Rewrite source IP and port in packet
   */
  private rewriteSourceIPAndPort(packet: Packet, newSourceIP: string, newPort: number): Packet {
    const newPacket = JSON.parse(JSON.stringify(packet)) as Packet;
    const ipPacket = newPacket.frame.payload as IPv4Packet;
    ipPacket.sourceIP = newSourceIP;

    if (ipPacket.protocol === IP_PROTOCOL.UDP || ipPacket.protocol === IP_PROTOCOL.TCP) {
      const transportPacket = ipPacket.payload as UDPDatagram;
      transportPacket.sourcePort = newPort;
    }

    return newPacket;
  }

  /**
   * Rewrite destination IP and port in packet
   */
  private rewriteDestIPAndPort(packet: Packet, newDestIP: string, newPort: number): Packet {
    const newPacket = JSON.parse(JSON.stringify(packet)) as Packet;
    const ipPacket = newPacket.frame.payload as IPv4Packet;
    ipPacket.destinationIP = newDestIP;

    if (ipPacket.protocol === IP_PROTOCOL.UDP || ipPacket.protocol === IP_PROTOCOL.TCP) {
      const transportPacket = ipPacket.payload as UDPDatagram;
      transportPacket.destinationPort = newPort;
    }

    return newPacket;
  }

  /**
   * Get all active translations
   */
  getTranslations(): NATTranslation[] {
    return Array.from(this.translations.values());
  }

  /**
   * Clear all dynamic translations
   */
  clearDynamicTranslations(): void {
    for (const [key, translation] of this.translations) {
      if (translation.type !== 'static') {
        this.translations.delete(key);
      }
    }
  }

  /**
   * Clear all translations
   */
  clearAllTranslations(): void {
    this.translations.clear();
    // Re-add static entries
    for (const entry of this.staticEntries) {
      const key = `static:${entry.insideLocal}`;
      this.translations.set(key, {
        insideLocal: entry.insideLocal,
        insideGlobal: entry.insideGlobal,
        outsideLocal: '',
        outsideGlobal: '',
        type: 'static',
        timeout: 0,
        lastUsed: Date.now(),
        hits: 0,
      });
    }
  }

  /**
   * Get NAT statistics
   */
  getStatistics(): {
    totalTranslations: number;
    staticTranslations: number;
    dynamicTranslations: number;
    patTranslations: number;
    hits: number;
    misses: number;
    insideInterfaces: string[];
    outsideInterfaces: string[];
  } {
    const translations = this.getTranslations();
    return {
      totalTranslations: translations.length,
      staticTranslations: translations.filter(t => t.type === 'static').length,
      dynamicTranslations: translations.filter(t => t.type === 'dynamic').length,
      patTranslations: translations.filter(t => t.type === 'pat').length,
      hits: this.stats.hits,
      misses: this.stats.misses,
      insideInterfaces: this.getInsideInterfaces(),
      outsideInterfaces: this.getOutsideInterfaces(),
    };
  }

  /**
   * Clean up expired translations
   */
  cleanupExpiredTranslations(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, translation] of this.translations) {
      if (translation.type !== 'static' && translation.timeout > 0) {
        const age = (now - translation.lastUsed) / 1000;
        if (age > translation.timeout) {
          this.translations.delete(key);
          cleaned++;
        }
      }
    }

    this.stats.expiredTranslations += cleaned;
    return cleaned;
  }

  // Helper functions
  private ipToNumber(ip: string): number {
    const parts = ip.split('.').map(Number);
    return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  }

  private numberToIP(num: number): string {
    return [
      (num >>> 24) & 255,
      (num >>> 16) & 255,
      (num >>> 8) & 255,
      num & 255,
    ].join('.');
  }
}
