/**
 * PacketQueue — Generic packet queue for packets awaiting address resolution
 *
 * Fixes:
 * - 1.6: Missing PacketQueue abstraction
 * - 1.2: Eliminates duplicate fwdQueue / ipv6FwdQueue / packetQueue patterns
 * - 1.9: Adds proper cleanup and size limiting (prevents memory leaks)
 */

import { ARP_TIMERS } from './constants';

/**
 * Queued packet entry with metadata for timeout management.
 */
interface QueueEntry<TPacket, TAddress extends string> {
  packet: TPacket;
  outIface: string;
  nextHop: TAddress;
  timer: ReturnType<typeof setTimeout>;
  enqueuedAt: number;
}

/**
 * Generic packet queue for packets waiting on neighbor resolution.
 *
 * Used by both IPv4 (waiting for ARP) and IPv6 (waiting for NDP).
 * Supports timeout-based expiration and size limiting.
 *
 * @typeParam TPacket - The packet type (IPv4Packet or IPv6Packet)
 * @typeParam TAddress - The address type (IPAddress or IPv6Address)
 *
 * @example
 * ```ts
 * const queue = new PacketQueue<IPv4Packet, IPAddress>(100);
 * queue.enqueue(packet, 'eth0', '10.0.0.1', 5000);
 * // After ARP resolves:
 * queue.flush('10.0.0.1', (pkt, iface) => sendFrame(pkt, iface));
 * ```
 */
export class PacketQueue<TPacket, TAddress extends string> {
  private entries: QueueEntry<TPacket, TAddress>[] = [];

  /**
   * @param maxSize - Maximum queue depth (prevents memory exhaustion)
   */
  constructor(private readonly maxSize: number = ARP_TIMERS.MAX_QUEUE_SIZE) {}

  /**
   * Enqueue a packet waiting for address resolution.
   * If the queue is full, the oldest entry is evicted.
   */
  enqueue(packet: TPacket, outIface: string, nextHop: TAddress, timeoutMs: number): void {
    // Evict oldest if at capacity
    if (this.entries.length >= this.maxSize) {
      const evicted = this.entries.shift();
      if (evicted) {
        clearTimeout(evicted.timer);
      }
    }

    const timer = setTimeout(() => {
      this.removeByRef(entry);
    }, timeoutMs);

    const entry: QueueEntry<TPacket, TAddress> = {
      packet,
      outIface,
      nextHop,
      timer,
      enqueuedAt: Date.now(),
    };

    this.entries.push(entry);
  }

  /**
   * Flush all packets destined for a given next-hop address.
   * Called when address resolution completes successfully.
   *
   * @returns Number of packets flushed
   */
  flush(address: TAddress, sendFn: (packet: TPacket, outIface: string) => void): number {
    let count = 0;
    const remaining: QueueEntry<TPacket, TAddress>[] = [];

    for (const entry of this.entries) {
      if (entry.nextHop === address) {
        clearTimeout(entry.timer);
        sendFn(entry.packet, entry.outIface);
        count++;
      } else {
        remaining.push(entry);
      }
    }

    this.entries = remaining;
    return count;
  }

  /**
   * Purge all expired entries.
   * @returns Number of entries purged
   */
  purgeExpired(): number {
    // Expiration is handled by individual timers, but this provides
    // a manual sweep for cleanup during power-off or shutdown.
    const before = this.entries.length;
    for (const entry of this.entries) {
      clearTimeout(entry.timer);
    }
    this.entries = [];
    return before;
  }

  /** Get the current queue depth */
  size(): number {
    return this.entries.length;
  }

  /** Clear all queued packets (e.g., on device power-off) */
  clear(): void {
    for (const entry of this.entries) {
      clearTimeout(entry.timer);
    }
    this.entries = [];
  }

  /** Get queued packets for a specific next-hop (read-only) */
  getByNextHop(address: TAddress): TPacket[] {
    return this.entries
      .filter(e => e.nextHop === address)
      .map(e => e.packet);
  }

  private removeByRef(entry: QueueEntry<TPacket, TAddress>): void {
    const index = this.entries.indexOf(entry);
    if (index >= 0) {
      clearTimeout(entry.timer);
      this.entries.splice(index, 1);
    }
  }
}
