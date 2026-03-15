/**
 * NetworkDesigner - Main component for network topology design
 * Integrates all UI components with Sprint 1 device classes
 *
 * Terminal management uses a tiling system:
 *   - Multiple terminals visible simultaneously in a split layout
 *   - Tiles can be split horizontally/vertically, resized, closed
 *   - Terminal state (output, history, cwd) persists across all manipulations
 *   - Minimize hides the tile view and returns to the canvas
 *   - Minimized terminals can be restored from the taskbar
 */

import { useState, useCallback, useRef } from 'react';
import { DevicePalette } from './DevicePalette';
import { NetworkCanvas } from './NetworkCanvas';
import { PropertiesPanel } from './PropertiesPanel';
import { Toolbar } from './Toolbar';
import { TerminalTileManager } from './TerminalTileManager';
import { MinimizedTerminals } from './MinimizedTerminals';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Equipment } from '@/network';
import type { DeviceType } from '@/network';
type BaseDevice = Equipment;
import { useNetworkStore } from '@/store/networkStore';

export function NetworkDesigner() {
  const [projectName, setProjectName] = useState('My Network');
  const [, setDraggingDevice] = useState<DeviceType | null>(null);

  // Track all open terminals — used by both tiling view and minimized taskbar
  const [openTerminals, setOpenTerminals] = useState<Map<string, BaseDevice>>(new Map());
  // Whether the tile view is visible (false = minimized to taskbar)
  const [tilesVisible, setTilesVisible] = useState(false);

  // Sidepane collapse state
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Get clearAll and devices from store
  const { getDevices, clearAll } = useNetworkStore();
  const devices = getDevices();

  // ── Open a terminal (from canvas double-click or restore) ──
  const handleOpenTerminal = useCallback((device: BaseDevice) => {
    if (!device.getIsPoweredOn()) return;
    const deviceId = device.getId();

    setOpenTerminals(prev => {
      if (prev.has(deviceId)) return prev; // already open
      const newMap = new Map(prev);
      newMap.set(deviceId, device);
      return newMap;
    });
    // Show the tile view
    setTilesVisible(true);
  }, []);

  // ── Close a single terminal ──
  const handleCloseDevice = useCallback((deviceId: string) => {
    setOpenTerminals(prev => {
      const newMap = new Map(prev);
      newMap.delete(deviceId);
      return newMap;
    });
  }, []);

  // ── All tiles closed ──
  const handleAllClosed = useCallback(() => {
    setTilesVisible(false);
    setOpenTerminals(new Map());
  }, []);

  // ── Minimize all tiles (return to canvas, keep terminals alive) ──
  const handleMinimizeAll = useCallback(() => {
    setTilesVisible(false);
  }, []);

  // ── Restore from minimized taskbar ──
  const handleRestoreTerminal = useCallback((device: BaseDevice) => {
    setTilesVisible(true);
  }, []);

  // ── Close from minimized taskbar ──
  const handleCloseFromTaskbar = useCallback((deviceId: string) => {
    setOpenTerminals(prev => {
      const newMap = new Map(prev);
      newMap.delete(deviceId);
      if (newMap.size === 0) setTilesVisible(false);
      return newMap;
    });
  }, []);

  // Build minimized map: when tiles are hidden, all open terminals are "minimized"
  const minimizedTerminalsMap = !tilesVisible ? openTerminals : new Map<string, BaseDevice>();

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <Toolbar
        projectName={projectName}
        onProjectNameChange={setProjectName}
        onClearAll={clearAll}
        hasDevices={devices.length > 0}
      />

      <div className="flex-1 flex overflow-hidden">
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

      {/* Tile-based terminal manager */}
      <TerminalTileManager
        devices={openTerminals}
        visible={tilesVisible}
        onCloseDevice={handleCloseDevice}
        onAllClosed={handleAllClosed}
        onMinimizeAll={handleMinimizeAll}
      />

      {/* Minimized Terminals Taskbar — shown when tiles are hidden */}
      {minimizedTerminalsMap.size > 0 && (
        <MinimizedTerminals
          terminals={minimizedTerminalsMap}
          onRestore={handleRestoreTerminal}
          onClose={handleCloseFromTaskbar}
        />
      )}
    </div>
  );
}
