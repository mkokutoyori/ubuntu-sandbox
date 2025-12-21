/**
 * useNetworkSimulator - Hook to integrate NetworkSimulator with the React app
 *
 * This hook:
 * 1. Initializes the NetworkSimulator when the component mounts
 * 2. Keeps the simulator in sync with the network store
 * 3. Provides methods to interact with the simulation
 * 4. Tracks active packets for visualization
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import { useNetworkStore } from '../store/networkStore';
import { NetworkSimulator, NetworkEvent, NetworkEventListener } from '../core/network/NetworkSimulator';

// Active packet for visualization
export interface ActivePacket {
  id: string;
  connectionId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  progress: number;  // 0 to 1
  direction: 'forward' | 'backward';  // forward = source->target, backward = target->source
  type: 'arp' | 'icmp' | 'data' | 'broadcast';
  timestamp: number;
}

const PACKET_ANIMATION_DURATION = 300; // ms

export function useNetworkSimulator() {
  const deviceInstances = useNetworkStore(state => state.deviceInstances);
  const connections = useNetworkStore(state => state.connections);
  const isInitializedRef = useRef(false);
  const [activePackets, setActivePackets] = useState<ActivePacket[]>([]);
  const animationFrameRef = useRef<number | null>(null);

  // Initialize and update simulator when topology changes
  useEffect(() => {
    // Initialize or update the simulator
    NetworkSimulator.initialize(deviceInstances, connections);
    isInitializedRef.current = true;
  }, [deviceInstances, connections]);

  // Animation loop to update packet positions
  useEffect(() => {
    const animate = () => {
      const now = Date.now();

      setActivePackets(prev => {
        const updated = prev.map(packet => {
          const elapsed = now - packet.timestamp;
          const progress = Math.min(elapsed / PACKET_ANIMATION_DURATION, 1);
          return { ...packet, progress };
        }).filter(packet => packet.progress < 1);

        return updated;
      });

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Track packet events
  useEffect(() => {
    const handleEvent = (event: NetworkEvent) => {
      if (event.type === 'frame_sent' && event.destinationDeviceId) {
        // Find the connection between source and destination
        const connection = connections.find(c =>
          (c.sourceDeviceId === event.sourceDeviceId && c.targetDeviceId === event.destinationDeviceId) ||
          (c.targetDeviceId === event.sourceDeviceId && c.sourceDeviceId === event.destinationDeviceId)
        );

        if (connection) {
          // Determine packet type from frame
          let packetType: ActivePacket['type'] = 'data';
          if (event.frame) {
            if (event.frame.destinationMAC === 'FF:FF:FF:FF:FF:FF') {
              packetType = 'broadcast';
            }
            if (event.frame.etherType === 0x0806) {
              packetType = 'arp';
            } else if (event.frame.etherType === 0x0800) {
              // Check if ICMP
              const payload = event.frame.payload as any;
              if (payload?.protocol === 1) {
                packetType = 'icmp';
              }
            }
          }

          // Determine direction based on connection definition
          const direction = connection.sourceDeviceId === event.sourceDeviceId ? 'forward' : 'backward';

          const newPacket: ActivePacket = {
            id: `${event.timestamp}-${Math.random().toString(36).slice(2, 9)}`,
            connectionId: connection.id,
            sourceDeviceId: event.sourceDeviceId,
            targetDeviceId: event.destinationDeviceId,
            progress: 0,
            direction,
            type: packetType,
            timestamp: Date.now()
          };

          setActivePackets(prev => [...prev, newPacket]);
        }
      }
    };

    NetworkSimulator.addEventListener(handleEvent);
    return () => NetworkSimulator.removeEventListener(handleEvent);
  }, [connections]);

  // Add event listener
  const addEventListener = useCallback((listener: NetworkEventListener) => {
    NetworkSimulator.addEventListener(listener);
    return () => NetworkSimulator.removeEventListener(listener);
  }, []);

  // Get MAC table for a switch
  const getMACTable = useCallback((deviceId: string) => {
    return NetworkSimulator.getMACTable(deviceId);
  }, []);

  // Clear MAC table for a switch
  const clearMACTable = useCallback((deviceId: string) => {
    NetworkSimulator.clearMACTable(deviceId);
  }, []);

  // Check if simulator is ready
  const isReady = useCallback(() => {
    return NetworkSimulator.isReady();
  }, []);

  // Debug: Get connection info
  const getConnectionInfo = useCallback(() => {
    return NetworkSimulator.getConnectionInfo();
  }, []);

  return {
    addEventListener,
    getMACTable,
    clearMACTable,
    isReady,
    getConnectionInfo,
    activePackets,
    simulator: NetworkSimulator
  };
}

// Export the singleton for direct access if needed
export { NetworkSimulator };
