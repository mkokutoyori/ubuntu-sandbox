/**
 * ARP - Address Resolution Protocol Service
 * Manages ARP tables and handles ARP request/reply process
 */

import {
  ARPPacket,
  ARPOpcode,
  EthernetFrame,
  Packet,
  BROADCAST_MAC,
  ETHER_TYPE,
  createARPRequest,
  createARPReply,
  generatePacketId
} from './packet';

export interface ARPTableEntry {
  ipAddress: string;
  macAddress: string;
  interface: string;
  type: 'static' | 'dynamic';
  createdAt: number;      // timestamp
  lastUsed: number;       // timestamp
  state: 'incomplete' | 'reachable' | 'stale' | 'delay' | 'probe';
}

export interface ARPConfig {
  /** Timeout for dynamic entries in seconds (default: 300) */
  timeout: number;
  /** Maximum number of ARP retries (default: 3) */
  maxRetries: number;
  /** Retry interval in milliseconds (default: 1000) */
  retryInterval: number;
  /** Enable proxy ARP (default: false) */
  proxyARP: boolean;
}

const DEFAULT_CONFIG: ARPConfig = {
  timeout: 300,
  maxRetries: 3,
  retryInterval: 1000,
  proxyARP: false
};

export class ARPService {
  private table: Map<string, ARPTableEntry> = new Map();
  private config: ARPConfig;
  private pendingRequests: Map<string, {
    callbacks: Array<(mac: string | null) => void>;
    retries: number;
    interfaceId: string;
    sourceMAC: string;
    sourceIP: string;
    timer?: ReturnType<typeof setTimeout>;
  }> = new Map();
  private sendPacket: ((packet: Packet, interfaceId: string) => void) | null = null;

  constructor(config: Partial<ARPConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the packet sending function
   */
  setPacketSender(sender: (packet: Packet, interfaceId: string) => void): void {
    this.sendPacket = sender;
  }

  /**
   * Get all ARP entries
   */
  getTable(): ARPTableEntry[] {
    return Array.from(this.table.values());
  }

  /**
   * Get ARP entry for specific IP
   */
  getEntry(ip: string): ARPTableEntry | undefined {
    return this.table.get(ip);
  }

  /**
   * Add a static ARP entry
   */
  addStaticEntry(ip: string, mac: string, interfaceName: string): void {
    const now = Date.now();
    this.table.set(ip, {
      ipAddress: ip,
      macAddress: mac.toUpperCase(),
      interface: interfaceName,
      type: 'static',
      createdAt: now,
      lastUsed: now,
      state: 'reachable'
    });
  }

  /**
   * Add/update a dynamic ARP entry
   */
  addDynamicEntry(ip: string, mac: string, interfaceName: string): void {
    const existing = this.table.get(ip);
    const now = Date.now();

    // Don't overwrite static entries
    if (existing?.type === 'static') {
      return;
    }

    this.table.set(ip, {
      ipAddress: ip,
      macAddress: mac.toUpperCase(),
      interface: interfaceName,
      type: 'dynamic',
      createdAt: existing?.createdAt || now,
      lastUsed: now,
      state: 'reachable'
    });

    // Resolve any pending requests for this IP
    this.resolvePendingRequest(ip, mac);
  }

  /**
   * Remove an ARP entry
   */
  removeEntry(ip: string): boolean {
    return this.table.delete(ip);
  }

  /**
   * Clear all dynamic entries
   */
  clearDynamic(): void {
    for (const [ip, entry] of this.table.entries()) {
      if (entry.type === 'dynamic') {
        this.table.delete(ip);
      }
    }
  }

  /**
   * Clear all entries
   */
  clearAll(): void {
    this.table.clear();
  }

  /**
   * Lookup MAC address for IP (synchronous, returns cached value or undefined)
   */
  lookup(ip: string): string | undefined {
    const entry = this.table.get(ip);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.macAddress;
    }
    return undefined;
  }

  /**
   * Resolve MAC address for IP (asynchronous, sends ARP request if needed)
   */
  resolve(
    ip: string,
    sourceMAC: string,
    sourceIP: string,
    interfaceId: string
  ): Promise<string | null> {
    // Check cache first
    const cached = this.lookup(ip);
    if (cached) {
      return Promise.resolve(cached);
    }

    // Return existing promise if request is already pending
    const pending = this.pendingRequests.get(ip);
    if (pending) {
      return new Promise(resolve => {
        pending.callbacks.push(resolve);
      });
    }

    // Start new ARP request
    return new Promise(resolve => {
      this.pendingRequests.set(ip, {
        callbacks: [resolve],
        retries: 0,
        interfaceId,
        sourceMAC,
        sourceIP
      });

      this.sendARPRequest(ip);
    });
  }

  /**
   * Send ARP request
   */
  private sendARPRequest(targetIP: string): void {
    const pending = this.pendingRequests.get(targetIP);
    if (!pending || !this.sendPacket) return;

    if (pending.retries >= this.config.maxRetries) {
      // Max retries reached, fail the request
      this.resolvePendingRequest(targetIP, null);
      return;
    }

    const arpPacket = createARPRequest(
      pending.sourceMAC,
      pending.sourceIP,
      targetIP
    );

    const frame: EthernetFrame = {
      destinationMAC: BROADCAST_MAC,
      sourceMAC: pending.sourceMAC,
      etherType: ETHER_TYPE.ARP,
      payload: arpPacket
    };

    const packet: Packet = {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit'
    };

    this.sendPacket(packet, pending.interfaceId);
    pending.retries++;

    // Set retry timer
    pending.timer = setTimeout(() => {
      this.sendARPRequest(targetIP);
    }, this.config.retryInterval);
  }

  /**
   * Resolve pending request with result
   */
  private resolvePendingRequest(ip: string, mac: string | null): void {
    const pending = this.pendingRequests.get(ip);
    if (!pending) return;

    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    pending.callbacks.forEach(callback => callback(mac));
    this.pendingRequests.delete(ip);
  }

  /**
   * Process incoming ARP packet
   */
  processPacket(
    arpPacket: ARPPacket,
    incomingInterface: string,
    localIP: string,
    localMAC: string
  ): Packet | null {
    // Always learn the sender's MAC (ARP learning/snooping)
    this.addDynamicEntry(arpPacket.senderIP, arpPacket.senderMAC, incomingInterface);

    // Check if this ARP is for our IP
    if (arpPacket.targetIP !== localIP) {
      return null; // Not for us
    }

    // If it's a request, generate a reply
    if (arpPacket.opcode === ARPOpcode.REQUEST) {
      const replyPacket = createARPReply(
        localMAC,
        localIP,
        arpPacket.senderMAC,
        arpPacket.senderIP
      );

      const frame: EthernetFrame = {
        destinationMAC: arpPacket.senderMAC,
        sourceMAC: localMAC,
        etherType: ETHER_TYPE.ARP,
        payload: replyPacket
      };

      return {
        id: generatePacketId(),
        timestamp: Date.now(),
        frame,
        hops: [],
        status: 'in_transit'
      };
    }

    // If it's a reply, the entry was already added above
    return null;
  }

  /**
   * Age entries and remove expired ones
   */
  ageEntries(): void {
    const now = Date.now();
    const timeout = this.config.timeout * 1000;

    for (const [ip, entry] of this.table.entries()) {
      if (entry.type === 'dynamic') {
        const age = now - entry.lastUsed;

        if (age > timeout) {
          this.table.delete(ip);
        } else if (age > timeout * 0.75) {
          entry.state = 'stale';
        }
      }
    }
  }

  /**
   * Format ARP table for display (like 'arp -a')
   */
  formatTable(): string {
    const entries = this.getTable();

    if (entries.length === 0) {
      return 'ARP cache is empty';
    }

    let output = 'Address                  HWtype  HWaddress           Flags Mask            Iface\n';

    for (const entry of entries) {
      const flags = entry.type === 'static' ? 'CM' : 'C';
      output += `${entry.ipAddress.padEnd(24)} ether   ${entry.macAddress}   ${flags.padEnd(6)}                  ${entry.interface}\n`;
    }

    return output;
  }
}

// Export singleton for global use if needed
export const globalARPService = new ARPService();
