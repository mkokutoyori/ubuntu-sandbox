/**
 * Unit tests for ICMPService
 * Following TDD approach - tests written first
 *
 * ICMPService manages ICMP functionality for network devices:
 * - Echo Request/Reply handling (ping)
 * - Request tracking with identifier and sequence numbers
 * - RTT (Round Trip Time) calculation
 * - Timeout management
 *
 * Design Pattern: Service Layer
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ICMPService } from '@/domain/network/services/ICMPService';
import { ICMPPacket, ICMPType, ICMPCode } from '@/domain/network/entities/ICMPPacket';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';

describe('ICMPService', () => {
  let service: ICMPService;

  beforeEach(() => {
    service = new ICMPService();
  });

  describe('Echo Request generation', () => {
    it('should create Echo Request with unique identifier', () => {
      const request1 = service.createEchoRequest(
        new IPAddress('192.168.1.1'),
        Buffer.from('test data')
      );

      expect(request1.isEchoRequest()).toBe(true);
      expect(request1.getIdentifier()).toBeGreaterThan(0);
      expect(request1.getSequenceNumber()).toBe(1);
      expect(request1.getData().toString()).toBe('test data');
    });

    it('should increment sequence number for same destination', () => {
      const dest = new IPAddress('192.168.1.1');

      const request1 = service.createEchoRequest(dest, Buffer.from('test1'));
      const request2 = service.createEchoRequest(dest, Buffer.from('test2'));
      const request3 = service.createEchoRequest(dest, Buffer.from('test3'));

      expect(request1.getSequenceNumber()).toBe(1);
      expect(request2.getSequenceNumber()).toBe(2);
      expect(request3.getSequenceNumber()).toBe(3);

      // Same identifier for same destination
      expect(request1.getIdentifier()).toBe(request2.getIdentifier());
      expect(request2.getIdentifier()).toBe(request3.getIdentifier());
    });

    it('should use different identifiers for different destinations', () => {
      const dest1 = new IPAddress('192.168.1.1');
      const dest2 = new IPAddress('192.168.1.2');

      const request1 = service.createEchoRequest(dest1, Buffer.from('test'));
      const request2 = service.createEchoRequest(dest2, Buffer.from('test'));

      expect(request1.getIdentifier()).not.toBe(request2.getIdentifier());
    });

    it('should track pending requests', () => {
      const dest = new IPAddress('192.168.1.1');
      const request = service.createEchoRequest(dest, Buffer.from('test'));

      const pending = service.getPendingRequests();
      expect(pending.size).toBe(1);
      expect(pending.has(dest.toString())).toBe(true);
    });
  });

  describe('Echo Reply handling', () => {
    it('should process Echo Reply and calculate RTT', () => {
      const dest = new IPAddress('192.168.1.1');
      const request = service.createEchoRequest(dest, Buffer.from('test'));

      // Simulate time passing
      vi.useFakeTimers();
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      service.createEchoRequest(dest, Buffer.from('test'));

      vi.setSystemTime(startTime + 50); // 50ms later

      const reply = ICMPPacket.createEchoReply(request);
      const result = service.handleEchoReply(dest, reply);

      expect(result).toBeDefined();
      expect(result?.success).toBe(true);
      expect(result?.rtt).toBeGreaterThanOrEqual(50);
      expect(result?.sequenceNumber).toBe(1);

      vi.useRealTimers();
    });

    it('should remove processed request from pending', () => {
      const dest = new IPAddress('192.168.1.1');
      const request = service.createEchoRequest(dest, Buffer.from('test'));

      expect(service.getPendingRequests().size).toBe(1);

      const reply = ICMPPacket.createEchoReply(request);
      service.handleEchoReply(dest, reply);

      expect(service.getPendingRequests().size).toBe(0);
    });

    it('should ignore reply for unknown request', () => {
      const dest = new IPAddress('192.168.1.1');

      // Create a reply without sending request
      const fakeReply = new ICMPPacket({
        type: ICMPType.ECHO_REPLY,
        code: 0,
        identifier: 9999,
        sequenceNumber: 1,
        data: Buffer.from('test')
      });

      const result = service.handleEchoReply(dest, fakeReply);

      expect(result).toBeUndefined();
    });

    it('should handle replies with mismatched sequence numbers', () => {
      const dest = new IPAddress('192.168.1.1');
      const request = service.createEchoRequest(dest, Buffer.from('test'));

      // Create reply with wrong sequence number
      const wrongReply = new ICMPPacket({
        type: ICMPType.ECHO_REPLY,
        code: 0,
        identifier: request.getIdentifier(),
        sequenceNumber: 999, // wrong sequence
        data: request.getData()
      });

      const result = service.handleEchoReply(dest, wrongReply);

      expect(result).toBeUndefined();
    });
  });

  describe('Request timeout', () => {
    it('should detect timeout for pending requests', () => {
      vi.useFakeTimers();
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const dest = new IPAddress('192.168.1.1');
      service.createEchoRequest(dest, Buffer.from('test'));

      // Check timeout after 6 seconds (default timeout is 5 seconds)
      vi.setSystemTime(startTime + 6000);

      const timedOut = service.getTimedOutRequests();
      expect(timedOut.length).toBe(1);
      expect(timedOut[0].destination.equals(dest)).toBe(true);

      vi.useRealTimers();
    });

    it('should not timeout requests within timeout period', () => {
      vi.useFakeTimers();
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const dest = new IPAddress('192.168.1.1');
      service.createEchoRequest(dest, Buffer.from('test'));

      // Check after 3 seconds (still within 5 second timeout)
      vi.setSystemTime(startTime + 3000);

      const timedOut = service.getTimedOutRequests();
      expect(timedOut.length).toBe(0);

      vi.useRealTimers();
    });

    it('should allow custom timeout', () => {
      vi.useFakeTimers();
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const dest = new IPAddress('192.168.1.1');
      service.createEchoRequest(dest, Buffer.from('test'), 2000); // 2 second timeout

      vi.setSystemTime(startTime + 3000);

      const timedOut = service.getTimedOutRequests();
      expect(timedOut.length).toBe(1);

      vi.useRealTimers();
    });

    it('should clean up timed out requests', () => {
      vi.useFakeTimers();
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const dest = new IPAddress('192.168.1.1');
      service.createEchoRequest(dest, Buffer.from('test'));

      vi.setSystemTime(startTime + 6000);

      service.cleanupTimedOutRequests();

      expect(service.getPendingRequests().size).toBe(0);

      vi.useRealTimers();
    });
  });

  describe('Statistics', () => {
    it('should track successful replies', () => {
      const dest = new IPAddress('192.168.1.1');
      const request = service.createEchoRequest(dest, Buffer.from('test'));
      const reply = ICMPPacket.createEchoReply(request);

      service.handleEchoReply(dest, reply);

      const stats = service.getStatistics();
      expect(stats.requestsSent).toBe(1);
      expect(stats.repliesReceived).toBe(1);
      expect(stats.timeouts).toBe(0);
    });

    it('should track multiple requests', () => {
      const dest = new IPAddress('192.168.1.1');

      service.createEchoRequest(dest, Buffer.from('test1'));
      service.createEchoRequest(dest, Buffer.from('test2'));
      service.createEchoRequest(dest, Buffer.from('test3'));

      const stats = service.getStatistics();
      expect(stats.requestsSent).toBe(3);
    });

    it('should calculate average RTT', () => {
      vi.useFakeTimers();
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const dest = new IPAddress('192.168.1.1');

      // Request 1
      const req1 = service.createEchoRequest(dest, Buffer.from('test'));
      vi.setSystemTime(startTime + 10);
      service.handleEchoReply(dest, ICMPPacket.createEchoReply(req1));

      // Request 2
      vi.setSystemTime(startTime + 20);
      const req2 = service.createEchoRequest(dest, Buffer.from('test'));
      vi.setSystemTime(startTime + 50);
      service.handleEchoReply(dest, ICMPPacket.createEchoReply(req2));

      const stats = service.getStatistics();
      expect(stats.averageRTT).toBeGreaterThan(0);

      vi.useRealTimers();
    });

    it('should reset statistics', () => {
      const dest = new IPAddress('192.168.1.1');
      service.createEchoRequest(dest, Buffer.from('test'));

      service.resetStatistics();

      const stats = service.getStatistics();
      expect(stats.requestsSent).toBe(0);
      expect(stats.repliesReceived).toBe(0);
    });
  });

  describe('Callbacks', () => {
    it('should trigger callback on Echo Reply', () => {
      const dest = new IPAddress('192.168.1.1');
      let callbackTriggered = false;
      let receivedResult: any = null;

      service.onEchoReply((destination, result) => {
        callbackTriggered = true;
        receivedResult = result;
      });

      const request = service.createEchoRequest(dest, Buffer.from('test'));
      const reply = ICMPPacket.createEchoReply(request);

      service.handleEchoReply(dest, reply);

      expect(callbackTriggered).toBe(true);
      expect(receivedResult.success).toBe(true);
    });

    it('should trigger callback on timeout', () => {
      vi.useFakeTimers();
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const dest = new IPAddress('192.168.1.1');
      let timeoutTriggered = false;

      service.onTimeout((destination, sequenceNumber) => {
        timeoutTriggered = true;
      });

      service.createEchoRequest(dest, Buffer.from('test'));

      vi.setSystemTime(startTime + 6000);
      service.cleanupTimedOutRequests();

      expect(timeoutTriggered).toBe(true);

      vi.useRealTimers();
    });
  });
});
