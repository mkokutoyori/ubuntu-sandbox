/**
 * NetworkDesigner - Main component for network topology design
 * Integrates all UI components with Sprint 1 device classes
 */

import { useState, useCallback } from 'react';
import { DevicePalette } from './DevicePalette';
import { NetworkCanvas } from './NetworkCanvas';
import { PropertiesPanel } from './PropertiesPanel';
import { Toolbar } from './Toolbar';
import { TerminalModal } from './TerminalModal';
import { MinimizedTerminals } from './MinimizedTerminals';
import { DeviceType } from '@/devices/common/types';
import { BaseDevice } from '@/devices';

export function NetworkDesigner() {
  const [projectName, setProjectName] = useState('My Network');
  const [, setDraggingDevice] = useState<DeviceType | null>(null);
  const [terminalDevice, setTerminalDevice] = useState<BaseDevice | null>(null);
  // Track minimized terminals by device ID
  const [minimizedTerminals, setMinimizedTerminals] = useState<Map<string, BaseDevice>>(new Map());

  const handleOpenTerminal = useCallback((device: BaseDevice) => {
    if (device.getIsPoweredOn()) {
      const deviceId = device.getId();
      // If this device has a minimized terminal, restore it
      if (minimizedTerminals.has(deviceId)) {
        setMinimizedTerminals(prev => {
          const newMap = new Map(prev);
          newMap.delete(deviceId);
          return newMap;
        });
      }
      setTerminalDevice(device);
    }
  }, [minimizedTerminals]);

  const handleCloseTerminal = useCallback(() => {
    setTerminalDevice(null);
  }, []);

  const handleMinimizeTerminal = useCallback(() => {
    if (terminalDevice) {
      const deviceId = terminalDevice.getId();
      setMinimizedTerminals(prev => {
        const newMap = new Map(prev);
        newMap.set(deviceId, terminalDevice);
        return newMap;
      });
      setTerminalDevice(null);
    }
  }, [terminalDevice]);

  const handleRestoreTerminal = useCallback((device: BaseDevice) => {
    const deviceId = device.getId();
    setMinimizedTerminals(prev => {
      const newMap = new Map(prev);
      newMap.delete(deviceId);
      return newMap;
    });
    setTerminalDevice(device);
  }, []);

  const handleCloseMinimizedTerminal = useCallback((deviceId: string) => {
    setMinimizedTerminals(prev => {
      const newMap = new Map(prev);
      newMap.delete(deviceId);
      return newMap;
    });
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <Toolbar
        projectName={projectName}
        onProjectNameChange={setProjectName}
      />

      <div className="flex-1 flex overflow-hidden">
        <DevicePalette onDragStart={setDraggingDevice} />
        <NetworkCanvas onOpenTerminal={handleOpenTerminal} />
        <PropertiesPanel />
      </div>

      {/* Terminal Modal */}
      {terminalDevice && (
        <TerminalModal
          device={terminalDevice}
          onClose={handleCloseTerminal}
          onMinimize={handleMinimizeTerminal}
        />
      )}

      {/* Minimized Terminals Taskbar */}
      {minimizedTerminals.size > 0 && (
        <MinimizedTerminals
          terminals={minimizedTerminals}
          onRestore={handleRestoreTerminal}
          onClose={handleCloseMinimizedTerminal}
        />
      )}
    </div>
  );
}
