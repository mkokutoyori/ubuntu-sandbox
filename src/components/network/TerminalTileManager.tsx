/**
 * TerminalTileManager - Tiling window manager for device terminals
 *
 * Architecture for state persistence:
 *   Terminal components are rendered in a FLAT list at the root level
 *   (stable position in the React tree → stable component state).
 *   The tile layout creates empty "slot" divs with refs, and we use
 *   React.createPortal() to teleport each terminal's DOM into its slot.
 *   This means splitting, closing, resizing, or rearranging tiles
 *   NEVER causes terminal components to unmount — their React state
 *   (output lines, command history, cwd, boot state) is fully preserved.
 *
 * Keyboard shortcuts:
 *   Ctrl+Shift+H — split focused tile horizontally (side by side)
 *   Ctrl+Shift+V — split focused tile vertically (stacked)
 *   Ctrl+Shift+W — close focused tile
 *   Ctrl+Shift+Arrow — move focus between tiles
 *   Ctrl+Shift+M — minimize all tiles (return to canvas)
 *   Ctrl+Shift+F — toggle fullscreen on focused tile
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { X, Minus, Maximize2, Copy, Columns2, Rows2 } from 'lucide-react';
import { Equipment, isFullyImplemented } from '@/network';
import { Terminal } from '@/components/Terminal';
import { WindowsTerminal } from '@/components/WindowsTerminal';
import { CiscoTerminal } from '@/components/CiscoTerminal';
import { HuaweiTerminal } from '@/components/HuaweiTerminal';
import { preInstallForDevice } from '@/terminal/packages';
import { cn } from '@/lib/utils';

type BaseDevice = Equipment;

// ─── Tile Tree Types ────────────────────────────────────────────────

type SplitDirection = 'horizontal' | 'vertical';

interface TileLeaf {
  type: 'leaf';
  id: string;
  deviceId: string;
}

interface TileSplit {
  type: 'split';
  id: string;
  direction: SplitDirection;
  children: [TileNode, TileNode];
  ratio: number; // 0-100
}

type TileNode = TileLeaf | TileSplit;

let tileIdCounter = 0;
function nextTileId(): string { return `tile-${++tileIdCounter}`; }

// ─── Tree helpers ───────────────────────────────────────────────────

function getAllLeaves(node: TileNode): TileLeaf[] {
  if (node.type === 'leaf') return [node];
  return [...getAllLeaves(node.children[0]), ...getAllLeaves(node.children[1])];
}

function findLeaf(node: TileNode, tileId: string): TileLeaf | null {
  if (node.type === 'leaf') return node.id === tileId ? node : null;
  return findLeaf(node.children[0], tileId) || findLeaf(node.children[1], tileId);
}

function cloneTree(node: TileNode): TileNode {
  if (node.type === 'leaf') return { ...node };
  return { ...node, children: [cloneTree(node.children[0]), cloneTree(node.children[1])] };
}

function replaceInTree(root: TileNode, targetId: string, replacement: TileNode): TileNode {
  if (root.id === targetId) return replacement;
  if (root.type === 'leaf') return root;
  return {
    ...root,
    children: [
      replaceInTree(root.children[0], targetId, replacement),
      replaceInTree(root.children[1], targetId, replacement),
    ],
  };
}

function removeFromTree(root: TileNode, tileId: string): TileNode | null {
  if (root.type === 'leaf') return root.id === tileId ? null : root;
  if (root.children[0].id === tileId) return root.children[1];
  if (root.children[1].id === tileId) return root.children[0];
  const left = removeFromTree(root.children[0], tileId);
  if (left !== root.children[0]) {
    return left === null ? root.children[1] : { ...root, children: [left, root.children[1]] };
  }
  const right = removeFromTree(root.children[1], tileId);
  if (right !== root.children[1]) {
    return right === null ? root.children[0] : { ...root, children: [root.children[0], right] };
  }
  return root;
}

function updateRatio(node: TileNode, splitId: string, newRatio: number): TileNode {
  if (node.type === 'leaf') return node;
  if (node.id === splitId) return { ...node, ratio: newRatio };
  return {
    ...node,
    children: [
      updateRatio(node.children[0], splitId, newRatio),
      updateRatio(node.children[1], splitId, newRatio),
    ],
  };
}

function findAdjacentLeaf(root: TileNode, currentId: string, dir: 'left' | 'right' | 'up' | 'down'): TileLeaf | null {
  const leaves = getAllLeaves(root);
  const idx = leaves.findIndex(l => l.id === currentId);
  if (idx < 0) return null;
  if (dir === 'left' || dir === 'up') return leaves[(idx - 1 + leaves.length) % leaves.length];
  return leaves[(idx + 1) % leaves.length];
}

// ─── Title helper ───────────────────────────────────────────────────

function getTerminalTitle(device: BaseDevice): string {
  const dt = device.getDeviceType();
  const os = device.getOSType();
  if (os === 'cisco-ios') return `${device.getName()} — Cisco IOS`;
  if (os === 'huawei-vrp') return `${device.getName()} — Huawei VRP`;
  if (os === 'windows') return `${device.getName()} — Windows`;
  if (dt.startsWith('db-')) {
    const n = dt === 'db-oracle' ? 'Oracle' : dt === 'db-mysql' ? 'MySQL' : dt === 'db-postgres' ? 'PostgreSQL' : dt === 'db-sqlserver' ? 'SQL Server' : 'Database';
    return `${device.getName()} — ${n}`;
  }
  return `${device.getName()} — Ubuntu Linux`;
}

// ─── Main Component ─────────────────────────────────────────────────

interface Props {
  devices: Map<string, BaseDevice>;
  visible: boolean;
  onCloseDevice: (deviceId: string) => void;
  onAllClosed: () => void;
  onMinimizeAll: () => void;
}

export function TerminalTileManager({ devices, visible, onCloseDevice, onAllClosed, onMinimizeAll }: Props) {
  const [tileRoot, setTileRoot] = useState<TileNode | null>(null);
  const [focusedTileId, setFocusedTileId] = useState<string | null>(null);
  const [fullscreenTileId, setFullscreenTileId] = useState<string | null>(null);

  // Refs for tile slot DOM elements (tileId → div)
  const slotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [, forceUpdate] = useState(0);

  // ── Sync devices with tile tree ──
  useEffect(() => {
    if (devices.size === 0) {
      setTileRoot(null);
      setFocusedTileId(null);
      setFullscreenTileId(null);
      return;
    }

    setTileRoot(prev => {
      if (!prev) {
        // Build initial tree from all devices
        const ids = [...devices.keys()];
        let root: TileNode = { type: 'leaf', id: nextTileId(), deviceId: ids[0] };
        for (let i = 1; i < ids.length; i++) {
          const leaf: TileLeaf = { type: 'leaf', id: nextTileId(), deviceId: ids[i] };
          root = { type: 'split', id: nextTileId(), direction: 'horizontal', children: [root, leaf], ratio: 50 };
        }
        setFocusedTileId(getAllLeaves(root)[getAllLeaves(root).length - 1].id);
        return root;
      }

      const existingLeaves = getAllLeaves(prev);
      const existingIds = new Set(existingLeaves.map(l => l.deviceId));

      // Add new devices
      const newIds = [...devices.keys()].filter(id => !existingIds.has(id));
      let updated = prev;
      for (const newId of newIds) {
        const leaves = getAllLeaves(updated);
        const target = leaves[leaves.length - 1];
        const newLeaf: TileLeaf = { type: 'leaf', id: nextTileId(), deviceId: newId };
        const split: TileSplit = {
          type: 'split', id: nextTileId(), direction: 'horizontal',
          children: [{ ...target, id: target.id }, newLeaf], ratio: 50,
        };
        updated = replaceInTree(updated, target.id, split);
        setFocusedTileId(newLeaf.id);
      }

      // Remove devices that are no longer open
      const removedLeaves = getAllLeaves(updated).filter(l => l.deviceId && !devices.has(l.deviceId));
      for (const leaf of removedLeaves) {
        const result = removeFromTree(updated, leaf.id);
        if (!result) { setFocusedTileId(null); return null; }
        updated = result;
      }

      if (newIds.length === 0 && removedLeaves.length === 0) return prev;
      return updated;
    });
  }, [devices]);

  // ── Actions ──

  const splitFocused = useCallback((direction: SplitDirection) => {
    setTileRoot(prev => {
      if (!prev || !focusedTileId) return prev;
      const leaf = findLeaf(prev, focusedTileId);
      if (!leaf) return prev;
      // Create empty slot tile
      const newTile: TileLeaf = { type: 'leaf', id: nextTileId(), deviceId: '' };
      const split: TileSplit = {
        type: 'split', id: nextTileId(), direction,
        children: [{ ...leaf }, newTile], ratio: 50,
      };
      setFocusedTileId(newTile.id);
      return replaceInTree(prev, leaf.id, split);
    });
  }, [focusedTileId]);

  const closeTile = useCallback((tileId: string) => {
    setTileRoot(prev => {
      if (!prev) return prev;
      const leaf = findLeaf(prev, tileId);
      if (leaf?.deviceId) onCloseDevice(leaf.deviceId);
      const remaining = removeFromTree(prev, tileId);
      if (!remaining) { onAllClosed(); setFocusedTileId(null); return null; }
      if (focusedTileId === tileId) {
        const leaves = getAllLeaves(remaining);
        setFocusedTileId(leaves[0]?.id || null);
      }
      return remaining;
    });
  }, [focusedTileId, onCloseDevice, onAllClosed]);

  const navigateFocus = useCallback((dir: 'left' | 'right' | 'up' | 'down') => {
    if (!tileRoot || !focusedTileId) return;
    const adj = findAdjacentLeaf(tileRoot, focusedTileId, dir);
    if (adj) setFocusedTileId(adj.id);
  }, [tileRoot, focusedTileId]);

  const toggleFullscreen = useCallback(() => {
    setFullscreenTileId(prev => prev === focusedTileId ? null : focusedTileId);
  }, [focusedTileId]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    if (!visible) return;
    const handle = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === 'h') { e.preventDefault(); splitFocused('horizontal'); }
      else if (key === 'v') { e.preventDefault(); splitFocused('vertical'); }
      else if (key === 'w') { e.preventDefault(); if (focusedTileId) closeTile(focusedTileId); }
      else if (key === 'f') { e.preventDefault(); toggleFullscreen(); }
      else if (key === 'm') { e.preventDefault(); onMinimizeAll(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); navigateFocus('left'); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navigateFocus('right'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); navigateFocus('up'); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); navigateFocus('down'); }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [visible, focusedTileId, splitFocused, closeTile, navigateFocus, toggleFullscreen, onMinimizeAll]);

  // ── Register slot ref ──
  const registerSlot = useCallback((tileId: string, el: HTMLDivElement | null) => {
    if (el) {
      slotRefs.current.set(tileId, el);
    } else {
      slotRefs.current.delete(tileId);
    }
    forceUpdate(n => n + 1);
  }, []);

  // ── Render ──
  // CRITICAL: Always render the terminal container to keep components mounted.
  // Only the tile layout overlay is hidden — terminals live in a stable container.

  if (!tileRoot) return null;

  const leaves = getAllLeaves(tileRoot);

  // Fullscreen: show only the focused tile
  const fsLeaf = fullscreenTileId && visible ? findLeaf(tileRoot, fullscreenTileId) : null;
  const showFullscreen = fsLeaf && fsLeaf.deviceId && devices.has(fsLeaf.deviceId);

  return (
    <>
      {/* ── Stable terminal container — always mounted, hidden when tiles are hidden ── */}
      {/* Terminals render here with stable keys so state is never lost */}
      <div style={{ position: 'fixed', left: 0, top: 0, width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        {leaves.map(leaf => {
          if (!leaf.deviceId) return null;
          const device = devices.get(leaf.deviceId);
          if (!device) return null;
          const slotEl = slotRefs.current.get(leaf.id);
          // If the slot element exists and tiles are visible, portal into it.
          // Otherwise, render in the hidden container to keep state alive.
          if (slotEl && visible) {
            return ReactDOM.createPortal(
              <TerminalRenderer key={leaf.deviceId} device={device} onClose={() => closeTile(leaf.id)} />,
              slotEl,
            );
          }
          // Hidden: keep mounted for state but invisible
          return (
            <div key={leaf.deviceId} style={{ position: 'absolute', visibility: 'hidden', width: 0, height: 0, overflow: 'hidden' }}>
              <TerminalRenderer device={device} onClose={() => closeTile(leaf.id)} />
            </div>
          );
        })}
      </div>

      {/* ── Fullscreen overlay ── */}
      {showFullscreen && (() => {
        const device = devices.get(fsLeaf!.deviceId)!;
        return (
          <div className="fixed inset-0 z-50 flex flex-col bg-[#0c0c0c]">
            <TileBar
              device={device}
              isFocused={true}
              onClose={() => { setFullscreenTileId(null); closeTile(fsLeaf!.id); }}
              onSplitH={() => { setFullscreenTileId(null); splitFocused('horizontal'); }}
              onSplitV={() => { setFullscreenTileId(null); splitFocused('vertical'); }}
              onToggleFS={() => setFullscreenTileId(null)}
              onMinimize={onMinimizeAll}
              isFS={true}
            />
            <div
              ref={(el) => registerSlot(fsLeaf!.id, el)}
              className="flex-1 overflow-hidden"
            />
          </div>
        );
      })()}

      {/* ── Tile layout overlay (hidden when minimized or fullscreen) ── */}
      {visible && !showFullscreen && (
        <div className="fixed inset-0 z-50 bg-[#0c0c0c]">
          <TileLayout
            node={tileRoot}
            devices={devices}
            focusedTileId={focusedTileId}
            onFocusTile={setFocusedTileId}
            onCloseTile={closeTile}
            onSplitH={(id) => { setFocusedTileId(id); setTimeout(() => splitFocused('horizontal'), 0); }}
            onSplitV={(id) => { setFocusedTileId(id); setTimeout(() => splitFocused('vertical'), 0); }}
            onToggleFS={(id) => { setFocusedTileId(id); setFullscreenTileId(id); }}
            onMinimize={onMinimizeAll}
            registerSlot={registerSlot}
            onRatioChange={(splitId, r) => setTileRoot(prev => prev ? updateRatio(prev, splitId, r) : prev)}
          />
        </div>
      )}
    </>
  );
}

// ─── Terminal Renderer — selects the right terminal type ────────────

function TerminalRenderer({ device, onClose }: { device: BaseDevice; onClose: () => void }) {
  const os = device.getOSType();
  const dt = device.getDeviceType();
  if (dt.startsWith('db-')) preInstallForDevice(dt);

  if (os === 'cisco-ios') return <CiscoTerminal device={device} onRequestClose={onClose} />;
  if (os === 'huawei-vrp') return <HuaweiTerminal device={device} onRequestClose={onClose} />;
  if (os === 'windows') return <WindowsTerminal device={device} onRequestClose={onClose} />;
  return <Terminal device={device} onRequestClose={onClose} />;
}

// ─── Tile Title Bar ─────────────────────────────────────────────────

function TileBar({ device, isFocused, onClose, onSplitH, onSplitV, onToggleFS, onMinimize, isFS }: {
  device: BaseDevice; isFocused: boolean; onClose: () => void;
  onSplitH: () => void; onSplitV: () => void; onToggleFS: () => void;
  onMinimize: () => void; isFS: boolean;
}) {
  return (
    <div className={cn(
      "flex items-center justify-between h-7 shrink-0 select-none border-b",
      isFocused ? "bg-[#1f1f1f] border-blue-500/40" : "bg-[#181818] border-[#333]"
    )}>
      <div className="flex items-center gap-2 pl-3 min-w-0">
        <span className="text-[11px] font-medium text-white/80 truncate">
          {getTerminalTitle(device)}
        </span>
      </div>
      <div className="flex items-stretch h-full">
        <button onClick={onSplitH} className="w-7 h-full flex items-center justify-center hover:bg-white/10 transition-colors" title="Split horizontal (Ctrl+Shift+H)">
          <Columns2 className="w-3 h-3 text-white/50" />
        </button>
        <button onClick={onSplitV} className="w-7 h-full flex items-center justify-center hover:bg-white/10 transition-colors" title="Split vertical (Ctrl+Shift+V)">
          <Rows2 className="w-3 h-3 text-white/50" />
        </button>
        <button onClick={onMinimize} className="w-8 h-full flex items-center justify-center hover:bg-white/10 transition-colors" title="Minimize all (Ctrl+Shift+M)">
          <Minus className="w-3.5 h-3.5 text-white/70" />
        </button>
        <button onClick={onToggleFS} className="w-8 h-full flex items-center justify-center hover:bg-white/10 transition-colors" title={isFS ? 'Restore (Ctrl+Shift+F)' : 'Fullscreen (Ctrl+Shift+F)'}>
          {isFS ? <Copy className="w-3 h-3 text-white/70" /> : <Maximize2 className="w-3 h-3 text-white/70" />}
        </button>
        <button onClick={onClose} className="w-8 h-full flex items-center justify-center hover:bg-[#e81123] transition-colors group" title="Close (Ctrl+Shift+W)">
          <X className="w-3.5 h-3.5 text-white/70 group-hover:text-white" />
        </button>
      </div>
    </div>
  );
}

// ─── Empty Tile ─────────────────────────────────────────────────────

function EmptyTile({ isFocused, onFocus, onClose, availableDevices, onSelectDevice }: {
  isFocused: boolean; onFocus: () => void; onClose: () => void;
  availableDevices: BaseDevice[]; onSelectDevice: (d: BaseDevice) => void;
}) {
  return (
    <div className={cn("h-full flex flex-col", isFocused ? "ring-1 ring-blue-500/40" : "")} onClick={onFocus}>
      <div className={cn(
        "flex items-center justify-between h-7 shrink-0 select-none border-b",
        isFocused ? "bg-[#1f1f1f] border-blue-500/40" : "bg-[#181818] border-[#333]"
      )}>
        <span className="text-[11px] text-white/40 pl-3">Empty tile</span>
        <button onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="w-8 h-full flex items-center justify-center hover:bg-[#e81123] transition-colors group">
          <X className="w-3.5 h-3.5 text-white/70 group-hover:text-white" />
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center bg-[#0c0c0c]">
        {availableDevices.length > 0 ? (
          <div className="text-center">
            <p className="text-white/40 text-sm mb-3">Select a device:</p>
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto px-4">
              {availableDevices.map(dev => (
                <button key={dev.getId()} onClick={() => onSelectDevice(dev)}
                  className="px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded text-xs text-white/70 hover:text-white transition-colors text-left">
                  {dev.getName()} <span className="text-white/30">[{dev.getDeviceType()}]</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-white/30 text-sm">No available devices</p>
        )}
      </div>
    </div>
  );
}

// ─── Tile Layout (recursive, creates slot divs) ─────────────────────

interface TileLayoutProps {
  node: TileNode;
  devices: Map<string, BaseDevice>;
  focusedTileId: string | null;
  onFocusTile: (id: string) => void;
  onCloseTile: (id: string) => void;
  onSplitH: (id: string) => void;
  onSplitV: (id: string) => void;
  onToggleFS: (id: string) => void;
  onMinimize: () => void;
  registerSlot: (tileId: string, el: HTMLDivElement | null) => void;
  onRatioChange: (splitId: string, ratio: number) => void;
}

function TileLayout(props: TileLayoutProps) {
  const { node } = props;
  if (node.type === 'leaf') return <TileLeafLayout {...props} leaf={node} />;
  return <TileSplitLayout {...props} split={node} />;
}

function TileLeafLayout({ leaf, devices, focusedTileId, onFocusTile, onCloseTile, onSplitH, onSplitV, onToggleFS, onMinimize, registerSlot }: TileLayoutProps & { leaf: TileLeaf }) {
  const device = leaf.deviceId ? devices.get(leaf.deviceId) : undefined;
  const isFocused = leaf.id === focusedTileId;

  if (!device || !leaf.deviceId) {
    return (
      <EmptyTile
        isFocused={isFocused}
        onFocus={() => onFocusTile(leaf.id)}
        onClose={() => onCloseTile(leaf.id)}
        availableDevices={[...devices.values()]}
        onSelectDevice={(dev) => {
          (leaf as any).deviceId = dev.getId();
          onFocusTile(leaf.id);
        }}
      />
    );
  }

  return (
    <div className={cn("h-full flex flex-col overflow-hidden", isFocused ? "ring-1 ring-blue-500/40 ring-inset" : "")}>
      <TileBar
        device={device}
        isFocused={isFocused}
        onClose={() => onCloseTile(leaf.id)}
        onSplitH={() => onSplitH(leaf.id)}
        onSplitV={() => onSplitV(leaf.id)}
        onToggleFS={() => onToggleFS(leaf.id)}
        onMinimize={onMinimize}
        isFS={false}
      />
      {/* Terminal slot — portal target */}
      <div
        ref={(el) => registerSlot(leaf.id, el)}
        className="flex-1 overflow-hidden"
        onMouseDown={() => onFocusTile(leaf.id)}
      />
    </div>
  );
}

function TileSplitLayout({ split, ...rest }: TileLayoutProps & { split: TileSplit }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      let r: number;
      if (split.direction === 'horizontal') {
        r = ((e.clientX - rect.left) / rect.width) * 100;
      } else {
        r = ((e.clientY - rect.top) / rect.height) * 100;
      }
      rest.onRatioChange(split.id, Math.max(10, Math.min(90, r)));
    };
    const handleUp = () => setIsDragging(false);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => { document.removeEventListener('mousemove', handleMove); document.removeEventListener('mouseup', handleUp); };
  }, [isDragging, split.direction, split.id, rest.onRatioChange]);

  const isH = split.direction === 'horizontal';

  return (
    <div ref={containerRef} className={cn("h-full w-full flex", isH ? "flex-row" : "flex-col", isDragging && "select-none")}>
      <div style={isH ? { width: `${split.ratio}%` } : { height: `${split.ratio}%` }} className="overflow-hidden">
        <TileLayout node={split.children[0]} {...rest} />
      </div>
      <div
        className={cn(
          "flex-shrink-0 z-20",
          isH ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
          isDragging ? "bg-blue-500/60" : "bg-[#333] hover:bg-blue-500/40",
          "transition-colors"
        )}
        onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
      />
      <div style={isH ? { width: `${100 - split.ratio}%` } : { height: `${100 - split.ratio}%` }} className="overflow-hidden">
        <TileLayout node={split.children[1]} {...rest} />
      </div>
    </div>
  );
}
