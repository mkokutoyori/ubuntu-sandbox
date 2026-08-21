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
import { NetworkLogsPanel } from './NetworkLogsPanel';
import { Toolbar } from './Toolbar';
import { HelpDialog } from './HelpDialog';
import { SaveTopologyDialog } from './SaveTopologyDialog';
import { OpenTopologyDialog } from './OpenTopologyDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { MessageDialog } from './MessageDialog';
import { TerminalModal } from './TerminalModal';
import { TerminalTaskbar } from './MinimizedTerminals';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Equipment } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { exportTopology, importTopology, downloadTopologyJSON, openTopologyFile, TOPOLOGY_SAVE_CAVEATS } from '@/store/topologySerializer';
import { saveTopologyToBrowser, loadTopologyFromBrowser } from '@/store/localStorageTopology';
import { cn } from '@/lib/utils';
import { getTerminalManager } from '@/terminal/sessions';

/** Available tiling layout modes */
export type TileLayout = 'stack' | 'split-h' | 'split-v' | 'grid' | 'master-stack';

export function NetworkDesigner() {
  const [projectName, setProjectName] = useState('My Network');
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  // Tiling state
  const [tileLayout, setTileLayout] = useState<TileLayout>('grid');
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Minimized sessions (by session ID)
  const [minimizedSessions, setMinimizedSessions] = useState<Set<string>>(new Set());

  // "Show desktop" peek — hides the terminal overlay to reveal the
  // topology without closing or minimizing any session.
  const [desktopPeek, setDesktopPeek] = useState(false);

  // Help dialog
  const [helpOpen, setHelpOpen] = useState(false);

  // Save/Open/Clear-All/Reset dialogs — replace window.prompt/alert/confirm
  // (rapport 09 audit, item #54).
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [openDialogOpen, setOpenDialogOpen] = useState(false);
  const [clearAllConfirmOpen, setClearAllConfirmOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [message, setMessage] = useState<{ title: string; description: string } | null>(null);

  const { getDevices, clearAll, deviceInstances, connections } = useNetworkStore();
  const devices = getDevices();
  const undo = useNetworkStore(s => s.undo);
  const redo = useNetworkStore(s => s.redo);
  const canUndo = useNetworkStore(s => s.historyPast.length > 0);
  const canRedo = useNetworkStore(s => s.historyFuture.length > 0);

  // Subscribe to TerminalManager for reactive updates
  const manager = getTerminalManager();
  useSyncExternalStore(manager.subscribe, manager.getVersion);

  // Derive session list from manager
  const allSessions = useMemo(() => {
    return Array.from(manager.getAllSessions().entries());
  }, [manager.getVersion()]);

  // ── Export/Import handlers ──
  // Export/Import both hand back a file that only captures configurable
  // device state, not live sessions/protocol state — surfaced up front
  // via a confirm dialog rather than silently, per rapport 09 item #55.
  const runExport = useCallback(() => {
    const topology = exportTopology(projectName, deviceInstances, connections);
    downloadTopologyJSON(topology);
  }, [projectName, deviceInstances, connections]);

  const handleExport = useCallback(() => setExportConfirmOpen(true), []);

  const runImport = useCallback(async () => {
    try {
      const data = await openTopologyFile();
      const result = await importTopology(data);

      // Clear current state first (disconnect existing cables). clearAll()
      // now publishes `registry.cleared` which causes the TerminalManager
      // to dispose every open session reactively — no manual close loop.
      clearAll();

      // Apply imported state directly to the store
      useNetworkStore.setState({
        deviceInstances: result.deviceInstances,
        connections: result.connections,
        selectedDeviceId: null,
        selectedConnectionId: null,
      });

      setProjectName(result.projectName);
      setMinimizedSessions(new Set());
    } catch (err) {
      if (err instanceof Error && err.message !== 'No file selected') {
        setMessage({ title: 'Import failed', description: err.message });
      }
    }
  }, [clearAll, allSessions, manager]);

  const handleImport = useCallback(() => {
    if (deviceInstances.size > 0) {
      setImportConfirmOpen(true);
      return;
    }
    runImport();
  }, [deviceInstances, runImport]);

  // ── Save / Open via localStorage — dialogs, not window.prompt ──
  const handleSave = useCallback(() => setSaveDialogOpen(true), []);

  const handleSaveTopology = useCallback((name: string) => {
    try {
      const topology = exportTopology(name, deviceInstances, connections);
      saveTopologyToBrowser(name, topology);
      setProjectName(name);
    } catch (err) {
      setMessage({ title: 'Save failed', description: err instanceof Error ? err.message : String(err) });
    }
  }, [deviceInstances, connections]);

  const handleOpen = useCallback(() => setOpenDialogOpen(true), []);

  const handleOpenTopology = useCallback(async (name: string) => {
    const topology = loadTopologyFromBrowser(name);
    if (!topology) {
      setMessage({ title: 'Open failed', description: 'Could not read this topology from storage (corrupted entry).' });
      return;
    }
    try {
      const result = await importTopology(topology);
      clearAll();
      useNetworkStore.setState({
        deviceInstances: result.deviceInstances,
        connections: result.connections,
        selectedDeviceId: null,
        selectedConnectionId: null,
      });
      setProjectName(result.projectName);
      setMinimizedSessions(new Set());
    } catch (err) {
      setMessage({ title: 'Open failed', description: err instanceof Error ? err.message : String(err) });
    }
  }, [clearAll]);

  // ── Clear All: destructive, so ask first (Reset already does) ──
  const handleClearAll = useCallback(() => {
    if (deviceInstances.size === 0) return;
    setClearAllConfirmOpen(true);
  }, [deviceInstances]);

  // ── Reset: power-cycle every device on the canvas ──
  const handleReset = useCallback(() => {
    if (deviceInstances.size === 0) return;
    setResetConfirmOpen(true);
  }, [deviceInstances]);

  const handleResetConfirmed = useCallback(() => {
    deviceInstances.forEach((device) => {
      try { device.powerOff(); } catch { /* ignore */ }
    });
    deviceInstances.forEach((device) => {
      try { device.powerOn(); } catch { /* ignore */ }
    });
  }, [deviceInstances]);

  const handleOpenTerminal = useCallback((device: Equipment) => {
    if (!device.getIsPoweredOn()) return;

    const sessionId = manager.openTerminal(device);
    if (sessionId) {
      // Opening a terminal should surface it, even if the user was
      // peeking at the desktop.
      setDesktopPeek(false);
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
    // Clicking a tab while peeking at the desktop brings the terminals
    // back with that session shown, rather than toggling its minimized state.
    if (desktopPeek) {
      setDesktopPeek(false);
      setMinimizedSessions(prev => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      return;
    }
    setMinimizedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, [desktopPeek]);

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

  // Prune dangling entries from minimizedSessions whenever the live session
  // set shrinks (e.g. device removed via bus event, clearAll, etc.). Without
  // this, the React-only Set keeps stale ids forever.
  useEffect(() => {
    const liveIds = new Set(allSessions.map(([id]) => id));
    setMinimizedSessions(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (liveIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allSessions]);

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

  // Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z (or +Y) — graph undo/redo (rapport 09
  // audit, item #54). Skipped while a text input/textarea/contenteditable
  // has focus (terminal input, Save dialog's name field, …) so this
  // doesn't hijack the browser's own text-edit undo there.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const active = document.activeElement;
      const isTextInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        || (active instanceof HTMLElement && active.isContentEditable);
      if (isTextInput) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

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
        onClearAll={handleClearAll}
        hasDevices={devices.length > 0}
        onExport={handleExport}
        onImport={handleImport}
        onSave={handleSave}
        onOpen={handleOpen}
        onReset={handleReset}
        onHelp={() => setHelpOpen(true)}
        logsOpen={logsOpen}
        onToggleLogs={() => setLogsOpen(o => !o)}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <SaveTopologyDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        defaultName={projectName}
        onSave={handleSaveTopology}
      />
      <OpenTopologyDialog
        open={openDialogOpen}
        onOpenChange={setOpenDialogOpen}
        onOpen={handleOpenTopology}
        confirmReplace={deviceInstances.size > 0}
      />
      <ConfirmDialog
        open={exportConfirmOpen}
        onOpenChange={setExportConfirmOpen}
        title="Export topology?"
        description={TOPOLOGY_SAVE_CAVEATS}
        confirmLabel="Export"
        onConfirm={runExport}
      />
      <ConfirmDialog
        open={importConfirmOpen}
        onOpenChange={setImportConfirmOpen}
        title="Replace current topology?"
        description="Importing a file will replace everything on the canvas now. Any unsaved changes will be lost."
        confirmLabel="Replace"
        destructive
        onConfirm={runImport}
      />
      <ConfirmDialog
        open={clearAllConfirmOpen}
        onOpenChange={setClearAllConfirmOpen}
        title="Remove all devices?"
        description={`Remove all ${deviceInstances.size} device(s) and their connections? This cannot be undone.`}
        confirmLabel="Remove all"
        destructive
        onConfirm={clearAll}
      />
      <ConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title="Power-cycle all devices?"
        description={`Power-cycle ${deviceInstances.size} device(s)? Running protocol state will be reset.`}
        confirmLabel="Power-cycle"
        onConfirm={handleResetConfirmed}
      />
      <MessageDialog
        open={message !== null}
        onOpenChange={(o) => { if (!o) setMessage(null); }}
        title={message?.title ?? ''}
        description={message?.description ?? ''}
      />

      <div className={cn(
        "flex-1 flex overflow-hidden",
        hasOpenTerminals && "pb-10"
      )}>
        {/* Left sidepane */}
        <div className="relative flex">
          <div className={`transition-all duration-300 ease-in-out overflow-hidden ${leftCollapsed ? 'w-0' : 'w-auto'}`}>
            <DevicePalette />
          </div>
          <button
            onClick={() => setLeftCollapsed(prev => !prev)}
            className="absolute -right-3 top-3 z-10 p-1 rounded-md bg-card/80 border border-white/10 hover:bg-white/10 transition-colors backdrop-blur-sm"
            title={leftCollapsed ? 'Show equipment panel' : 'Hide equipment panel'}
            aria-label={leftCollapsed ? 'Show equipment panel' : 'Hide equipment panel'}
            aria-expanded={!leftCollapsed}
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
            aria-label={rightCollapsed ? 'Show properties panel' : 'Hide properties panel'}
            aria-expanded={!rightCollapsed}
          >
            {rightCollapsed ? <PanelRightOpen className="w-3.5 h-3.5 text-muted-foreground" /> : <PanelRightClose className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
          <div className={`transition-all duration-300 ease-in-out overflow-hidden ${rightCollapsed ? 'w-0' : 'w-auto'}`}>
            <PropertiesPanel />
          </div>
        </div>

        {/* Network logs panel (slide-in from the right edge). Lives in the
            same column as Properties so opening it doesn't reflow the
            canvas. The Logger backend already buffers every event; we
            just surface it. */}
        {logsOpen && <NetworkLogsPanel />}
      </div>

      {/* ── Terminal tile overlay (hidden while peeking at the desktop) ── */}
      {hasVisibleTerminals && !desktopPeek && (
        <div
          /*
            La zone de tuilage couvre l'écran et prend la main : elle est
            annoncée comme telle. `aria-modal` n'est PAS posé, et c'est
            volontaire — contrairement à une fenêtre unique, cette zone
            n'exclut pas le reste de l'application : la barre des tâches
            en dessous reste utilisable, et le prétendre inaccessible
            tromperait un lecteur d'écran.
          */
          role="region"
          aria-label="Tiled terminals"
          className={cn(
            "fixed inset-0 z-50",
            "bg-black/60 backdrop-blur-sm",
            hasOpenTerminals && "bottom-10"
          )}
        >
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
          desktopPeek={desktopPeek}
          onToggleDesktop={() => setDesktopPeek(p => !p)}
        />
      )}
    </div>
  );
}
