/**
 * ICMPService - ICMP protocol management service
 *
 * Manages ICMP functionality for network devices:
 * - Echo Request/Reply handling (ping)
 * - Request tracking with identifier and sequence numbers
 * - RTT (Round Trip Time) calculation
 * - Timeout management
 * - Statistics collection
 *
 * Design Pattern: Service Layer
 * - Encapsulates ICMP business logic
 * - Stateful service with request tracking
 * - Observer pattern for callbacks
 *
 * @example
 * ```typescript
 * const icmpService = new ICMPService();
 *
 * // Register callback
 * icmpService.onEchoReply((dest, result) => {
 *   console.log(`Reply from ${dest}: ${result.rtt}ms`);
 * });
 *
 * // Send Echo Request
 * const request = icmpService.createEchoRequest(
 *   new IPAddress('192.168.1.1'),
 *   Buffer.from('ping data')
 * );
 *
 * // Later, handle reply
 * icmpService.handleEchoReply(dest, replyPacket);
 * ```
 */

import { ICMPPacket, ICMPType } from '../entities/ICMPPacket';
import { IPAddress } from '../value-objects/IPAddress';

/**
 * Pending ICMP request information
 */
interface PendingRequest {
  identifier: number;
  sequenceNumber: number;
  destination: IPAddress;
  sentAt: number;
  timeout: number;
  data: Buffer;
}

/**
 * Echo Reply result
 */
export interface EchoReplyResult {
  success: boolean;
  sequenceNumber: number;
  rtt: number; // Round Trip Time in milliseconds
  data: Buffer;
}

/**
 * ICMP statistics
 */
export interface ICMPStatistics {
  requestsSent: number;
  repliesReceived: number;
  timeouts: number;
  averageRTT: number;
  minRTT: number;
  maxRTT: number;
}

/**
 * Callback types
 */
type EchoReplyCallback = (destination: IPAddress, result: EchoReplyResult) => void;
type TimeoutCallback = (destination: IPAddress, sequenceNumber: number) => void;

/**
 * ICMPService - Manages ICMP protocol operations
 */
export class ICMPService {
  // Request tracking by destination IP
  private pendingRequests: Map<string, Map<number, PendingRequest>>;

  // Identifier management per destination
  private identifiers: Map<string, number>;

  // Sequence numbers per destination
  private sequences: Map<string, number>;

  // Statistics
  private statistics: ICMPStatistics;
  private rttSamples: number[];

  // Callbacks
  private replyCallback?: EchoReplyCallback;
  private timeoutCallback?: TimeoutCallback;

  // Configuration
  private readonly DEFAULT_TIMEOUT = 5000; // 5 seconds

  constructor() {
    this.pendingRequests = new Map();
    this.identifiers = new Map();
    this.sequences = new Map();
    this.rttSamples = [];

    this.statistics = {
      requestsSent: 0,
      repliesReceived: 0,
      timeouts: 0,
      averageRTT: 0,
      minRTT: Infinity,
      maxRTT: 0
    };
  }

  /**
   * Creates an Echo Request packet
   *
   * @param destination - Destination IP address
   * @param data - Payload data
   * @param timeout - Timeout in milliseconds (default: 5000)
   * @returns Echo Request packet
   */
  public createEchoRequest(
    destination: IPAddress,
    data: Buffer,
    timeout: number = this.DEFAULT_TIMEOUT
  ): ICMPPacket {
    const destKey = destination.toString();

    // Get or create identifier for this destination
    if (!this.identifiers.has(destKey)) {
      this.identifiers.set(destKey, this.generateIdentifier());
    }
    const identifier = this.identifiers.get(destKey)!;

    // Get or increment sequence number
    const currentSeq = this.sequences.get(destKey) || 0;
    const sequenceNumber = currentSeq + 1;
    this.sequences.set(destKey, sequenceNumber);

    // Create Echo Request packet
    const packet = new ICMPPacket({
      type: ICMPType.ECHO_REQUEST,
      code: 0,
      identifier,
      sequenceNumber,
      data
    });

    // Track pending request
    if (!this.pendingRequests.has(destKey)) {
      this.pendingRequests.set(destKey, new Map());
    }

    this.pendingRequests.get(destKey)!.set(sequenceNumber, {
      identifier,
      sequenceNumber,
      destination,
      sentAt: Date.now(),
      timeout,
      data
    });

    // Update statistics
    this.statistics.requestsSent++;

    return packet;
  }

  /**
   * Handles an Echo Reply packet
   *
   * @param source - Source IP address of the reply
   * @param reply - Echo Reply packet
   * @returns Result with RTT, or undefined if not matching any pending request
   */
  public handleEchoReply(source: IPAddress, reply: ICMPPacket): EchoReplyResult | undefined {
    if (!reply.isEchoReply()) {
      return undefined;
    }

    const sourceKey = source.toString();
    const destRequests = this.pendingRequests.get(sourceKey);

    if (!destRequests) {
      return undefined;
    }

    const sequenceNumber = reply.getSequenceNumber();
    const pending = destRequests.get(sequenceNumber);

    if (!pending) {
      return undefined;
    }

    // Verify identifier matches
    if (pending.identifier !== reply.getIdentifier()) {
      return undefined;
    }

    // Calculate RTT
    const rtt = Date.now() - pending.sentAt;

    // Remove from pending
    destRequests.delete(sequenceNumber);
    if (destRequests.size === 0) {
      this.pendingRequests.delete(sourceKey);
    }

    // Update statistics
    this.statistics.repliesReceived++;
    this.rttSamples.push(rtt);
    this.updateRTTStatistics(rtt);

    const result: EchoReplyResult = {
      success: true,
      sequenceNumber,
      rtt,
      data: reply.getData()
    };

    // Trigger callback
    if (this.replyCallback) {
      this.replyCallback(source, result);
    }

    return result;
  }

  /**
   * Returns pending requests
   */
  public getPendingRequests(): Map<string, Map<number, PendingRequest>> {
    return this.pendingRequests;
  }

  /**
   * Returns timed out requests
   */
  public getTimedOutRequests(): PendingRequest[] {
    const now = Date.now();
    const timedOut: PendingRequest[] = [];

    for (const [destKey, requests] of this.pendingRequests.entries()) {
      for (const [seq, request] of requests.entries()) {
        if (now - request.sentAt >= request.timeout) {
          timedOut.push(request);
        }
      }
    }

    return timedOut;
  }

  /**
   * Cleans up timed out requests
   */
  public cleanupTimedOutRequests(): void {
    const timedOut = this.getTimedOutRequests();

    for (const request of timedOut) {
      const destKey = request.destination.toString();
      const destRequests = this.pendingRequests.get(destKey);

      if (destRequests) {
        destRequests.delete(request.sequenceNumber);

        if (destRequests.size === 0) {
          this.pendingRequests.delete(destKey);
        }
      }

      // Update statistics
      this.statistics.timeouts++;

      // Trigger timeout callback
      if (this.timeoutCallback) {
        this.timeoutCallback(request.destination, request.sequenceNumber);
      }
    }
  }

  /**
   * Returns statistics
   */
  public getStatistics(): Readonly<ICMPStatistics> {
    return { ...this.statistics };
  }

  /**
   * Resets statistics
   */
  public resetStatistics(): void {
    this.statistics = {
      requestsSent: 0,
      repliesReceived: 0,
      timeouts: 0,
      averageRTT: 0,
      minRTT: Infinity,
      maxRTT: 0
    };
    this.rttSamples = [];
  }

  /**
   * Registers callback for Echo Replies
   */
  public onEchoReply(callback: EchoReplyCallback): void {
    this.replyCallback = callback;
  }

  /**
   * Registers callback for timeouts
   */
  public onTimeout(callback: TimeoutCallback): void {
    this.timeoutCallback = callback;
  }

  /**
   * Generates a unique identifier for ICMP requests
   */
  private generateIdentifier(): number {
    return Math.floor(Math.random() * 65535) + 1;
  }

  /**
   * Updates RTT statistics
   */
  private updateRTTStatistics(rtt: number): void {
    // Update min/max
    if (rtt < this.statistics.minRTT) {
      this.statistics.minRTT = rtt;
    }
    if (rtt > this.statistics.maxRTT) {
      this.statistics.maxRTT = rtt;
    }

    // Calculate average
    if (this.rttSamples.length > 0) {
      const sum = this.rttSamples.reduce((a, b) => a + b, 0);
      this.statistics.averageRTT = sum / this.rttSamples.length;
    }
  }
}
