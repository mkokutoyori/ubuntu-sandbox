/**
 * NetworkDesigner - Main component for network topology design
 * Integrates all UI components with Sprint 1 device classes
 *
 * Terminal tiling inspired by i3/sway/dwm:
 *   - Multiple layout modes: stack, split-h, split-v, grid, master-stack
 *   - Keyboard shortcuts: Mod+h/v/g/s/m to change layout
 *   - Focused terminal concept for stack/master modes
 *
 * Terminal state managed by TerminalManager singleton — sessions survive
 * mount/unmount and are consistent across all tile views.
 */

import { useState, useCallback, useMemo, useEffect, useSyncExternalStore } from 'react';
import { DevicePalette } from './DevicePalette';
import { NetworkCanvas } from './NetworkCanvas';
import { PropertiesPanel } from './PropertiesPanel';
import { Toolbar } from './Toolbar';
import { TerminalModal } from './TerminalModal';
import { TerminalTaskbar } from './MinimizedTerminals';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Equipment } from '@/network';
import type { DeviceType } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { exportTopology, importTopology, downloadTopologyJSON, openTopologyFile } from '@/store/topologySerializer';
import { cn } from '@/lib/utils';
import { getTerminalManager } from '@/terminal/sessions';

/** Available tiling layout modes */
export type TileLayout = 'stack' | 'split-h' | 'split-v' | 'grid' | 'master-stack';

export function NetworkDesigner() {
  const [projectName, setProjectName] = useState('My Network');
  const [, setDraggingDevice] = useState<DeviceType | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Tiling state
  const [tileLayout, setTileLayout] = useState<TileLayout>('grid');
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Minimized sessions (by session ID)
  const [minimizedSessions, setMinimizedSessions] = useState<Set<string>>(new Set());

  const { getDevices, clearAll, deviceInstances, connections } = useNetworkStore();
  const devices = getDevices();

  // Subscribe to TerminalManager for reactive updates
  const manager = getTerminalManager();
  useSyncExternalStore(manager.subscribe, manager.getVersion);

  // Derive session list from manager
  const allSessions = useMemo(() => {
    return Array.from(manager.getAllSessions().entries());
  }, [manager.getVersion()]);

  // ── Export/Import handlers ──
  const handleExport = useCallback(() => {
    const topology = exportTopology(projectName, deviceInstances, connections);
    downloadTopologyJSON(topology);
  }, [projectName, deviceInstances, connections]);

  const handleImport = useCallback(async () => {
    try {
      const data = await openTopologyFile();
      const result = importTopology(data);

      // Clear current state first (disconnect existing cables)
      clearAll();

      // Apply imported state directly to the store
      useNetworkStore.setState({
        deviceInstances: result.deviceInstances,
        connections: result.connections,
        selectedDeviceId: null,
        selectedConnectionId: null,
      });

      setProjectName(result.projectName);

      // Close all open terminals
      for (const [sessionId] of allSessions) {
        manager.closeTerminal(sessionId);
      }
      setMinimizedSessions(new Set());
    } catch (err) {
      if (err instanceof Error && err.message !== 'No file selected') {
        alert(`Import failed: ${err.message}`);
      }
    }
  }, [clearAll, allSessions, manager]);

  const handleOpenTerminal = useCallback((device: Equipment) => {
    if (!device.getIsPoweredOn()) return;

    // Open a new session (multi-terminal per device is supported)
    const sessionId = manager.openTerminal(device);
    if (sessionId) {
      // If it was somehow minimized, un-minimize it
      setMinimizedSessions(prev => {
        if (prev.has(sessionId)) {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        }
        return prev;
      });
    }
  }, [manager]);

  const handleCloseTerminal = useCallback((sessionId: string) => {
    manager.closeTerminal(sessionId);
    setMinimizedSessions(prev => {
      if (prev.has(sessionId)) {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      }
      return prev;
    });
  }, [manager]);

  const handleToggleTerminal = useCallback((sessionId: string) => {
    setMinimizedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleMinimizeTerminal = useCallback((sessionId: string) => {
    setMinimizedSessions(prev => {
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
  }, []);

  // Get visible (non-minimized) sessions
  const visibleSessions = useMemo(() => {
    return allSessions.filter(([id]) => !minimizedSessions.has(id));
  }, [allSessions, minimizedSessions]);

  // Clamp focused index
  useEffect(() => {
    if (focusedIndex >= visibleSessions.length) {
      setFocusedIndex(Math.max(0, visibleSessions.length - 1));
    }
  }, [visibleSessions.length, focusedIndex]);

  // Keyboard shortcuts for tiling (Alt+key)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (visibleSessions.length === 0) return;

      if (e.altKey) {
        switch (e.key.toLowerCase()) {
          case 'h': e.preventDefault(); setTileLayout('split-h'); break;
          case 'v': e.preventDefault(); setTileLayout('split-v'); break;
          case 'g': e.preventDefault(); setTileLayout('grid'); break;
          case 's': e.preventDefault(); setTileLayout('stack'); break;
          case 'm': e.preventDefault(); setTileLayout('master-stack'); break;
          case 'j':
            e.preventDefault();
            setFocusedIndex(prev => (prev + 1) % visibleSessions.length);
            break;
          case 'k':
            e.preventDefault();
            setFocusedIndex(prev => (prev - 1 + visibleSessions.length) % visibleSessions.length);
            break;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visibleSessions.length]);

  const hasOpenTerminals = allSessions.length > 0;
  const hasVisibleTerminals = visibleSessions.length > 0;

  // ── Render tiled terminals based on layout mode ──
  const renderTiledTerminals = () => {
    const count = visibleSessions.length;
    if (count === 0) return null;

    const renderTerminal = (sessionId: string) => {
      const session = manager.getSession(sessionId);
      if (!session) return null;
      return (
        <div key={sessionId} className="min-h-0 min-w-0 w-full h-full">
          <TerminalModal
            session={session}
            onClose={() => handleCloseTerminal(sessionId)}
            onMinimize={() => handleMinimizeTerminal(sessionId)}
            embedded
          />
        </div>
      );
    };

    switch (tileLayout) {
      case 'stack': {
        const idx = Math.min(focusedIndex, count - 1);
        const [sessionId] = visibleSessions[idx];
        return (
          <div className="w-full h-full">
            {renderTerminal(sessionId)}
          </div>
        );
      }

      case 'split-h': {
        return (
          <div className="w-full h-full flex gap-1">
            {visibleSessions.map(([id]) => (
              <div key={id} className="flex-1 min-w-0 h-full">
                {renderTerminal(id)}
              </div>
            ))}
          </div>
        );
      }

      case 'split-v': {
        return (
          <div className="w-full h-full flex flex-col gap-1">
            {visibleSessions.map(([id]) => (
              <div key={id} className="flex-1 min-h-0 w-full">
                {renderTerminal(id)}
              </div>
            ))}
          </div>
        );
      }

      case 'master-stack': {
        if (count === 1) {
          const [id] = visibleSessions[0];
          return <div className="w-full h-full">{renderTerminal(id)}</div>;
        }
        const masterIdx = Math.min(focusedIndex, count - 1);
        const [masterId] = visibleSessions[masterIdx];
        const stackSessions = visibleSessions.filter((_, i) => i !== masterIdx);

        return (
          <div className="w-full h-full flex gap-1">
            <div className="h-full min-w-0" style={{ flex: '0 0 60%' }}>
              {renderTerminal(masterId)}
            </div>
            <div className="h-full min-w-0 flex flex-col gap-1" style={{ flex: '0 0 calc(40% - 4px)' }}>
              {stackSessions.map(([id]) => (
                <div key={id} className="flex-1 min-h-0 w-full">
                  {renderTerminal(id)}
                </div>
              ))}
            </div>
          </div>
        );
      }

      case 'grid':
      default: {
        const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
        const rows = Math.ceil(count / cols);
        return (
          <div
            className="w-full h-full grid gap-1"
            style={{
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gridTemplateRows: `repeat(${rows}, 1fr)`,
            }}
          >
            {visibleSessions.map(([id]) => renderTerminal(id))}
          </div>
        );
      }
    }
  };

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <Toolbar
        projectName={projectName}
        onProjectNameChange={setProjectName}
        onClearAll={clearAll}
        hasDevices={devices.length > 0}
        onExport={handleExport}
        onImport={handleImport}
      />

      <div className={cn(
        "flex-1 flex overflow-hidden",
        hasOpenTerminals && "pb-10"
      )}>
        {/* Left sidepane */}
        <div className="relative flex">
          <div className={`transition-all duration-300 ease-in-out overflow-hidden ${leftCollapsed ? 'w-0' : 'w-auto'}`}>
            <DevicePalette onDragStart={setDraggingDevice} />
          </div>
          <button
            onClick={() => setLeftCollapsed(prev => !prev)}
            className="absolute -right-3 top-3 z-10 p-1 rounded-md bg-card/80 border border-white/10 hover:bg-white/10 transition-colors backdrop-blur-sm"
            title={leftCollapsed ? 'Show equipment panel' : 'Hide equipment panel'}
          >
            {leftCollapsed ? <PanelLeftOpen className="w-3.5 h-3.5 text-muted-foreground" /> : <PanelLeftClose className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
        </div>

        <NetworkCanvas onOpenTerminal={handleOpenTerminal} />

        {/* Right sidepane */}
        <div className="relative flex">
          <button
            onClick={() => setRightCollapsed(prev => !prev)}
            className="absolute -left-3 top-3 z-10 p-1 rounded-md bg-card/80 border border-white/10 hover:bg-white/10 transition-colors backdrop-blur-sm"
            title={rightCollapsed ? 'Show properties panel' : 'Hide properties panel'}
          >
            {rightCollapsed ? <PanelRightOpen className="w-3.5 h-3.5 text-muted-foreground" /> : <PanelRightClose className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
          <div className={`transition-all duration-300 ease-in-out overflow-hidden ${rightCollapsed ? 'w-0' : 'w-auto'}`}>
            <PropertiesPanel />
          </div>
        </div>
      </div>

      {/* ── Terminal tile overlay ── */}
      {hasVisibleTerminals && (
        <div className={cn(
          "fixed inset-0 z-50",
          "bg-black/60 backdrop-blur-sm",
          hasOpenTerminals && "bottom-10"
        )}>
          <div className="w-full h-full p-1">
            {renderTiledTerminals()}
          </div>
        </div>
      )}

      {/* No hidden divs needed — session state lives in TerminalManager, not React */}

      {/* ── Always-visible terminal taskbar ── */}
      {hasOpenTerminals && (
        <TerminalTaskbar
          sessions={allSessions}
          minimizedIds={minimizedSessions}
          onToggle={handleToggleTerminal}
          onClose={handleCloseTerminal}
          tileLayout={tileLayout}
          onLayoutChange={setTileLayout}
          focusedIndex={focusedIndex}
          visibleCount={visibleSessions.length}
          onFocusChange={setFocusedIndex}
        />
      )}
    </div>
  );
}
