/**
 * NetworkDesigner - Main component for network topology design
 * Integrates all UI components with Sprint 1 device classes
 *
 * Terminal tiling inspired by i3/sway/dwm:
 *   - Multiple layout modes: stack, split-h, split-v, grid, master-stack
 *   - Keyboard shortcuts: Mod+h/v/g/s/m to change layout
 *   - Focused terminal concept for stack/master modes
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
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

/** Available tiling layout modes */
export type TileLayout = 'stack' | 'split-h' | 'split-v' | 'grid' | 'master-stack';

export function NetworkDesigner() {
  const [projectName, setProjectName] = useState('My Network');
  const [, setDraggingDevice] = useState<DeviceType | null>(null);
  const [openTerminals, setOpenTerminals] = useState<Map<string, BaseDevice>>(new Map());
  const [minimizedTerminals, setMinimizedTerminals] = useState<Set<string>>(new Set());
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Tiling state
  const [tileLayout, setTileLayout] = useState<TileLayout>('grid');
  // Focused terminal index (for stack and master-stack modes)
  const [focusedIndex, setFocusedIndex] = useState(0);

  const { getDevices, clearAll } = useNetworkStore();
  const devices = getDevices();

  const handleOpenTerminal = useCallback((device: BaseDevice) => {
    if (device.getIsPoweredOn()) {
      const deviceId = device.getId();

      if (openTerminals.has(deviceId) && !minimizedTerminals.has(deviceId)) {
        return;
      }

      if (openTerminals.has(deviceId) && minimizedTerminals.has(deviceId)) {
        setMinimizedTerminals(prev => {
          const newSet = new Set(prev);
          newSet.delete(deviceId);
          return newSet;
        });
        return;
      }

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

  // Clamp focused index
  useEffect(() => {
    if (focusedIndex >= visibleTerminals.length) {
      setFocusedIndex(Math.max(0, visibleTerminals.length - 1));
    }
  }, [visibleTerminals.length, focusedIndex]);

  // Keyboard shortcuts for tiling (Alt+key)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only activate when terminals are visible
      if (visibleTerminals.length === 0) return;

      if (e.altKey) {
        switch (e.key.toLowerCase()) {
          case 'h': e.preventDefault(); setTileLayout('split-h'); break;
          case 'v': e.preventDefault(); setTileLayout('split-v'); break;
          case 'g': e.preventDefault(); setTileLayout('grid'); break;
          case 's': e.preventDefault(); setTileLayout('stack'); break;
          case 'm': e.preventDefault(); setTileLayout('master-stack'); break;
          case 'j': // Focus next
            e.preventDefault();
            setFocusedIndex(prev => (prev + 1) % visibleTerminals.length);
            break;
          case 'k': // Focus prev
            e.preventDefault();
            setFocusedIndex(prev => (prev - 1 + visibleTerminals.length) % visibleTerminals.length);
            break;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visibleTerminals.length]);

  const hasOpenTerminals = openTerminals.size > 0;
  const hasVisibleTerminals = visibleTerminals.length > 0;

  // ── Render tiled terminals based on layout mode ──
  const renderTiledTerminals = () => {
    const count = visibleTerminals.length;
    if (count === 0) return null;

    const renderTerminal = (deviceId: string, device: BaseDevice) => (
      <div key={deviceId} className="min-h-0 min-w-0 w-full h-full">
        <TerminalModal
          device={device}
          onClose={() => handleCloseTerminal(deviceId)}
          onMinimize={() => handleMinimizeTerminal(deviceId)}
          embedded
        />
      </div>
    );

    switch (tileLayout) {
      case 'stack': {
        // Only show focused terminal
        const idx = Math.min(focusedIndex, count - 1);
        const [deviceId, device] = visibleTerminals[idx];
        return (
          <div className="w-full h-full">
            {renderTerminal(deviceId, device)}
          </div>
        );
      }

      case 'split-h': {
        // All terminals side by side horizontally
        return (
          <div className="w-full h-full flex gap-1">
            {visibleTerminals.map(([id, dev]) => (
              <div key={id} className="flex-1 min-w-0 h-full">
                {renderTerminal(id, dev)}
              </div>
            ))}
          </div>
        );
      }

      case 'split-v': {
        // All terminals stacked vertically
        return (
          <div className="w-full h-full flex flex-col gap-1">
            {visibleTerminals.map(([id, dev]) => (
              <div key={id} className="flex-1 min-h-0 w-full">
                {renderTerminal(id, dev)}
              </div>
            ))}
          </div>
        );
      }

      case 'master-stack': {
        if (count === 1) {
          const [id, dev] = visibleTerminals[0];
          return <div className="w-full h-full">{renderTerminal(id, dev)}</div>;
        }
        // Master on the left (60%), stack on the right (40%)
        const masterIdx = Math.min(focusedIndex, count - 1);
        const [masterId, masterDev] = visibleTerminals[masterIdx];
        const stackTerminals = visibleTerminals.filter((_, i) => i !== masterIdx);

        return (
          <div className="w-full h-full flex gap-1">
            {/* Master pane */}
            <div className="h-full min-w-0" style={{ flex: '0 0 60%' }}>
              {renderTerminal(masterId, masterDev)}
            </div>
            {/* Stack pane */}
            <div className="h-full min-w-0 flex flex-col gap-1" style={{ flex: '0 0 calc(40% - 4px)' }}>
              {stackTerminals.map(([id, dev]) => (
                <div key={id} className="flex-1 min-h-0 w-full">
                  {renderTerminal(id, dev)}
                </div>
              ))}
            </div>
          </div>
        );
      }

      case 'grid':
      default: {
        // Auto grid
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
            {visibleTerminals.map(([id, dev]) => renderTerminal(id, dev))}
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

      {/* Keep minimized terminals mounted but hidden */}
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
          tileLayout={tileLayout}
          onLayoutChange={setTileLayout}
          focusedIndex={focusedIndex}
          visibleCount={visibleTerminals.length}
          onFocusChange={setFocusedIndex}
        />
      )}
    </div>
  );
}
