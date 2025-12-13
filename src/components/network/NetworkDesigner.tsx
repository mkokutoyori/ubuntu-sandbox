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
  // Track the currently active (visible) terminal
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  // Track all open terminals (both active and minimized) - keeps them mounted
  const [openTerminals, setOpenTerminals] = useState<Map<string, BaseDevice>>(new Map());
  // Track which terminals are minimized
  const [minimizedTerminals, setMinimizedTerminals] = useState<Set<string>>(new Set());

  const handleOpenTerminal = useCallback((device: BaseDevice) => {
    if (device.getIsPoweredOn()) {
      const deviceId = device.getId();

      // If this terminal is already open and not minimized, do nothing
      if (openTerminals.has(deviceId) && !minimizedTerminals.has(deviceId)) {
        return;
      }

      // Minimize any currently visible terminal (except the one we're opening)
      setMinimizedTerminals(prev => {
        const newSet = new Set(prev);
        // Minimize all non-minimized terminals
        openTerminals.forEach((_, id) => {
          if (!prev.has(id) && id !== deviceId) {
            newSet.add(id);
          }
        });
        // Make sure the one we're opening is not minimized
        newSet.delete(deviceId);
        return newSet;
      });

      // Add to open terminals if not already open
      setOpenTerminals(prev => {
        if (!prev.has(deviceId)) {
          const newMap = new Map(prev);
          newMap.set(deviceId, device);
          return newMap;
        }
        return prev;
      });

      // Set as active terminal
      setActiveTerminalId(deviceId);
    }
  }, [openTerminals, minimizedTerminals]);

  const handleCloseTerminal = useCallback((deviceId: string) => {
    // Remove from all tracking
    setOpenTerminals(prev => {
      const newMap = new Map(prev);
      newMap.delete(deviceId);
      return newMap;
    });
    setMinimizedTerminals(prev => {
      const newSet = new Set(prev);
      newSet.delete(deviceId);
      return newSet;
    });
    if (activeTerminalId === deviceId) {
      setActiveTerminalId(null);
    }
  }, [activeTerminalId]);

  const handleMinimizeTerminal = useCallback(() => {
    if (activeTerminalId) {
      // Add to minimized set (terminal stays in openTerminals)
      setMinimizedTerminals(prev => {
        const newSet = new Set(prev);
        newSet.add(activeTerminalId);
        return newSet;
      });
      // No active terminal
      setActiveTerminalId(null);
    }
  }, [activeTerminalId]);

  const handleRestoreTerminal = useCallback((device: BaseDevice) => {
    const deviceId = device.getId();
    // Remove from minimized
    setMinimizedTerminals(prev => {
      const newSet = new Set(prev);
      newSet.delete(deviceId);
      return newSet;
    });
    // Set as active
    setActiveTerminalId(deviceId);
  }, []);

  // Get minimized terminals as Map for MinimizedTerminals component
  const minimizedTerminalsMap = new Map<string, BaseDevice>();
  minimizedTerminals.forEach(deviceId => {
    const device = openTerminals.get(deviceId);
    if (device) {
      minimizedTerminalsMap.set(deviceId, device);
    }
  });

  // Get the active device
  const activeDevice = activeTerminalId ? openTerminals.get(activeTerminalId) : null;

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

      {/* All open terminals - keep mounted for state preservation */}
      {Array.from(openTerminals.entries()).map(([deviceId, device]) => {
        const isMinimized = minimizedTerminals.has(deviceId);

        // Keep all terminals mounted but hide minimized ones
        // This preserves terminal state (history, output, etc.)
        return (
          <div
            key={deviceId}
            style={{ display: isMinimized ? 'none' : 'block' }}
          >
            <TerminalModal
              device={device}
              onClose={() => handleCloseTerminal(deviceId)}
              onMinimize={handleMinimizeTerminal}
            />
          </div>
        );
      })}

      {/* Minimized Terminals Taskbar */}
      {minimizedTerminalsMap.size > 0 && (
        <MinimizedTerminals
          terminals={minimizedTerminalsMap}
          onRestore={handleRestoreTerminal}
          onClose={handleCloseTerminal}
        />
      )}
    </div>
  );
}
