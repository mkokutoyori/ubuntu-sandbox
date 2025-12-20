/**
 * useNetworkSimulator - Hook to integrate NetworkSimulator with the React app
 *
 * This hook:
 * 1. Initializes the NetworkSimulator when the component mounts
 * 2. Keeps the simulator in sync with the network store
 * 3. Provides methods to interact with the simulation
 */

import { useEffect, useCallback, useRef } from 'react';
import { useNetworkStore } from '../store/networkStore';
import { NetworkSimulator, NetworkEvent, NetworkEventListener } from '../core/network/NetworkSimulator';

export function useNetworkSimulator() {
  const deviceInstances = useNetworkStore(state => state.deviceInstances);
  const connections = useNetworkStore(state => state.connections);
  const isInitializedRef = useRef(false);

  // Initialize and update simulator when topology changes
  useEffect(() => {
    // Initialize or update the simulator
    NetworkSimulator.initialize(deviceInstances, connections);
    isInitializedRef.current = true;

    console.log(`[useNetworkSimulator] Simulator updated: ${deviceInstances.size} devices, ${connections.length} connections`);
  }, [deviceInstances, connections]);

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
    simulator: NetworkSimulator
  };
}

// Export the singleton for direct access if needed
export { NetworkSimulator };
