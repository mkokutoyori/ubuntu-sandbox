/**
 * NetworkDesigner - Main component for network topology design
 * Integrates all UI components with Sprint 1 device classes
 */

import { useState, useCallback, useMemo } from 'react';
import { DevicePalette } from './DevicePalette';
import { NetworkCanvas } from './NetworkCanvas';
import { PropertiesPanel } from './PropertiesPanel';
import { Toolbar } from './Toolbar';
import { TerminalModal } from './TerminalModal';
import { TerminalTaskbar } from './MinimizedTerminals';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Equipment } from '@/network';
import type { DeviceType } from '@/network';
type BaseDevice = Equipment;
import { useNetworkStore } from '@/store/networkStore';
import { cn } from '@/lib/utils';

export function NetworkDesigner() {
  const [projectName, setProjectName] = useState('My Network');
  const [, setDraggingDevice] = useState<DeviceType | null>(null);
  // Track all open terminals (both active and minimized) - keeps them mounted
  const [openTerminals, setOpenTerminals] = useState<Map<string, BaseDevice>>(new Map());
  // Track which terminals are minimized (not visible in tile area)
  const [minimizedTerminals, setMinimizedTerminals] = useState<Set<string>>(new Set());
  // Sidepane collapse state
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Get clearAll and devices from store
  const { getDevices, clearAll } = useNetworkStore();
  const devices = getDevices();

  const handleOpenTerminal = useCallback((device: BaseDevice) => {
    if (device.getIsPoweredOn()) {
      const deviceId = device.getId();

      // If already open and visible, do nothing
      if (openTerminals.has(deviceId) && !minimizedTerminals.has(deviceId)) {
        return;
      }

      // If already open but minimized, restore it
      if (openTerminals.has(deviceId) && minimizedTerminals.has(deviceId)) {
        setMinimizedTerminals(prev => {
          const newSet = new Set(prev);
          newSet.delete(deviceId);
          return newSet;
        });
        return;
      }

      // Add to open terminals (visible by default)
      setOpenTerminals(prev => {
        const newMap = new Map(prev);
        newMap.set(deviceId, device);
        return newMap;
      });
    }
  }, [openTerminals, minimizedTerminals]);

  const handleCloseTerminal = useCallback((deviceId: string) => {
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
  }, []);

  const handleToggleTerminal = useCallback((device: BaseDevice) => {
    const deviceId = device.getId();
    setMinimizedTerminals(prev => {
      const newSet = new Set(prev);
      if (newSet.has(deviceId)) {
        newSet.delete(deviceId);
      } else {
        newSet.add(deviceId);
      }
      return newSet;
    });
  }, []);

  const handleMinimizeTerminal = useCallback((deviceId: string) => {
    setMinimizedTerminals(prev => {
      const newSet = new Set(prev);
      newSet.add(deviceId);
      return newSet;
    });
  }, []);

  // Get visible (non-minimized) terminals
  const visibleTerminals = useMemo(() => {
    const result: Array<[string, BaseDevice]> = [];
    openTerminals.forEach((device, id) => {
      if (!minimizedTerminals.has(id)) {
        result.push([id, device]);
      }
    });
    return result;
  }, [openTerminals, minimizedTerminals]);

  // Determine tile grid class based on number of visible terminals
  const tileGridClass = useMemo(() => {
    const count = visibleTerminals.length;
    if (count <= 1) return 'grid-cols-1 grid-rows-1';
    if (count === 2) return 'grid-cols-2 grid-rows-1';
    if (count <= 4) return 'grid-cols-2 grid-rows-2';
    if (count <= 6) return 'grid-cols-3 grid-rows-2';
    return 'grid-cols-3 grid-rows-3';
  }, [visibleTerminals.length]);

  const hasOpenTerminals = openTerminals.size > 0;
  const hasVisibleTerminals = visibleTerminals.length > 0;

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <Toolbar
        projectName={projectName}
        onProjectNameChange={setProjectName}
        onClearAll={clearAll}
        hasDevices={devices.length > 0}
      />

      <div className={cn(
        "flex-1 flex overflow-hidden",
        hasOpenTerminals && "pb-10" // Leave room for taskbar
      )}>
        {/* Left sidepane collapse toggle */}
        <div className="relative flex">
          <div
            className={`transition-all duration-300 ease-in-out overflow-hidden ${
              leftCollapsed ? 'w-0' : 'w-auto'
            }`}
          >
            <DevicePalette onDragStart={setDraggingDevice} />
          </div>
          <button
            onClick={() => setLeftCollapsed(prev => !prev)}
            className="absolute -right-3 top-3 z-10 p-1 rounded-md bg-card/80 border border-white/10 hover:bg-white/10 transition-colors backdrop-blur-sm"
            title={leftCollapsed ? 'Show equipment panel' : 'Hide equipment panel'}
          >
            {leftCollapsed ? (
              <PanelLeftOpen className="w-3.5 h-3.5 text-muted-foreground" />
            ) : (
              <PanelLeftClose className="w-3.5 h-3.5 text-muted-foreground" />
            )}
          </button>
        </div>

        <NetworkCanvas onOpenTerminal={handleOpenTerminal} />

        {/* Right sidepane collapse toggle */}
        <div className="relative flex">
          <button
            onClick={() => setRightCollapsed(prev => !prev)}
            className="absolute -left-3 top-3 z-10 p-1 rounded-md bg-card/80 border border-white/10 hover:bg-white/10 transition-colors backdrop-blur-sm"
            title={rightCollapsed ? 'Show properties panel' : 'Hide properties panel'}
          >
            {rightCollapsed ? (
              <PanelRightOpen className="w-3.5 h-3.5 text-muted-foreground" />
            ) : (
              <PanelRightClose className="w-3.5 h-3.5 text-muted-foreground" />
            )}
          </button>
          <div
            className={`transition-all duration-300 ease-in-out overflow-hidden ${
              rightCollapsed ? 'w-0' : 'w-auto'
            }`}
          >
            <PropertiesPanel />
          </div>
        </div>
      </div>

      {/* ── Terminal tile overlay ── */}
      {hasVisibleTerminals && (
        <div className={cn(
          "fixed inset-0 z-50",
          "bg-black/60 backdrop-blur-sm",
          hasOpenTerminals && "bottom-10" // Leave room for taskbar
        )}>
          <div className={cn("grid w-full h-full gap-1 p-1", tileGridClass)}>
            {visibleTerminals.map(([deviceId, device]) => (
              <div key={deviceId} className="min-h-0 min-w-0">
                <TerminalModal
                  device={device}
                  onClose={() => handleCloseTerminal(deviceId)}
                  onMinimize={() => handleMinimizeTerminal(deviceId)}
                  embedded
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Keep minimized terminals mounted but hidden (to preserve state) */}
      {Array.from(openTerminals.entries()).map(([deviceId, device]) => {
        if (!minimizedTerminals.has(deviceId)) return null;
        return (
          <div key={deviceId} style={{ display: 'none' }}>
            <TerminalModal
              device={device}
              onClose={() => handleCloseTerminal(deviceId)}
              onMinimize={() => handleMinimizeTerminal(deviceId)}
              embedded
            />
          </div>
        );
      })}

      {/* ── Always-visible terminal taskbar ── */}
      {hasOpenTerminals && (
        <TerminalTaskbar
          terminals={openTerminals}
          minimizedIds={minimizedTerminals}
          onToggle={handleToggleTerminal}
          onClose={handleCloseTerminal}
        />
      )}
    </div>
  );
}
