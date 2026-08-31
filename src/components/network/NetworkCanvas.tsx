/**
 * NetworkCanvas - Main canvas for network topology design
 */

import { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import { ZoomIn, ZoomOut, Maximize2, X } from 'lucide-react';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkDevice } from './NetworkDevice';
import { ConnectionLine } from './ConnectionLine';
import { computeBundleSlots } from './connection-line-logic';
import { PacketAnimation, PacketLegend } from './PacketAnimation';
import { useActivePackets } from '@/react/hooks/useActivePackets';
import { Equipment } from '@/network';
import type { DeviceType } from '@/network';
type BaseDevice = Equipment;
import { cn } from '@/lib/utils';

interface NetworkCanvasProps {
  onOpenTerminal?: (device: BaseDevice) => void;
}

export function NetworkCanvas({ onOpenTerminal }: NetworkCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const {
    getDevices,
    connections,
    zoom,
    panX,
    panY,
    setZoom,
    setPan,
    addDevice,
    clearSelection,
    clearAll,
    isConnecting,
    cancelConnecting,
    connectionSource,
    selectedDeviceId,
    selectedConnectionId,
  } = useNetworkStore();

  const devices = getDevices();

  const activePackets = useActivePackets();

  // Screen-reader status line: the canvas had no non-visual feedback for
  // add/remove/select/connect — a keyboard/AT user got no confirmation an
  // action actually happened (rapport 09 audit). Diffing against the
  // previous render's counts/selection keeps this to real state changes,
  // not a message on every re-render.
  const [announcement, setAnnouncement] = useState('');
  const prevDeviceCount = useRef(devices.length);
  const bundleSlots = useMemo(() => computeBundleSlots(connections), [connections]);

  const prevConnectionCount = useRef(connections.length);
  const prevSelectedDeviceId = useRef(selectedDeviceId);
  const prevSelectedConnectionId = useRef(selectedConnectionId);

  useEffect(() => {
    if (devices.length > prevDeviceCount.current) {
      const added = devices[devices.length - 1];
      setAnnouncement(added ? `${added.name} added to canvas` : 'Device added to canvas');
    } else if (devices.length < prevDeviceCount.current) {
      setAnnouncement('Device removed from canvas');
    } else if (connections.length > prevConnectionCount.current) {
      setAnnouncement('Devices connected');
    } else if (connections.length < prevConnectionCount.current) {
      setAnnouncement('Connection removed');
    } else if (selectedDeviceId && selectedDeviceId !== prevSelectedDeviceId.current) {
      const selected = devices.find(d => d.id === selectedDeviceId);
      if (selected) setAnnouncement(`${selected.name} selected`);
    } else if (selectedConnectionId && selectedConnectionId !== prevSelectedConnectionId.current) {
      setAnnouncement('Connection selected');
    }
    prevDeviceCount.current = devices.length;
    prevConnectionCount.current = connections.length;
    prevSelectedDeviceId.current = selectedDeviceId;
    prevSelectedConnectionId.current = selectedConnectionId;
  }, [devices, connections.length, selectedDeviceId, selectedConnectionId]);

  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  // Tracks the in-progress pan gesture so a plain click on the empty
  // background (no drag past the threshold) still clears the selection,
  // while a drag pans the map. Distance in px before a press becomes a pan.
  const panGestureRef = useRef<{ startX: number; startY: number; moved: boolean; fromBackground: boolean } | null>(null);
  const PAN_CLICK_THRESHOLD = 4;

  // Once a source interface is picked the popover (and its Escape handler)
  // is gone, so without this the only ways out of connect mode were clicking
  // empty canvas or the banner's X button.
  useEffect(() => {
    if (!isConnecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelConnecting();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isConnecting, cancelConnecting]);

  // React registers `onWheel` as a passive listener, so preventDefault()
  // there is silently ignored and ctrl+wheel zoomed the whole browser page
  // on top of the canvas. Bind manually with { passive: false }.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = -e.deltaY * 0.001;
        setZoom(useNetworkStore.getState().zoom + delta);
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [setZoom]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const middleOrAlt = e.button === 1 || (e.button === 0 && e.altKey);
    const leftOnBackground = e.button === 0 && !e.altKey && e.target === e.currentTarget;
    if (middleOrAlt || leftOnBackground) {
      setIsPanning(true);
      setStartPan({ x: e.clientX - panX, y: e.clientY - panY });
      panGestureRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        // Only a plain left-press on the empty background can resolve to a
        // "click" (clear selection). Middle/Alt drags are pans, never clicks.
        fromBackground: leftOnBackground && !middleOrAlt,
      };
    }
  }, [panX, panY]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // mousePos only feeds the elastic connection-drawing line below —
    // updating it on every idle mouse movement re-rendered the whole
    // canvas subtree for no visible effect (rapport 09 audit).
    if (isConnecting) {
      const rect = canvas.getBoundingClientRect();
      setMousePos({
        x: (e.clientX - rect.left) / zoom,
        y: (e.clientY - rect.top) / zoom
      });
    }

    if (!isPanning) return;
    const gesture = panGestureRef.current;
    if (gesture && !gesture.moved) {
      const dist = Math.abs(e.clientX - gesture.startX) + Math.abs(e.clientY - gesture.startY);
      if (dist > PAN_CLICK_THRESHOLD) gesture.moved = true;
    }
    // Hold a sub-threshold background press perfectly still so a click
    // stays a click; middle/Alt pans (fromBackground=false) move at once.
    if (!gesture || gesture.moved || !gesture.fromBackground) {
      setPan(e.clientX - startPan.x, e.clientY - startPan.y);
    }
  }, [isConnecting, isPanning, startPan, zoom, setPan]);

  const handleMouseUp = useCallback(() => {
    const gesture = panGestureRef.current;
    panGestureRef.current = null;
    setIsPanning(false);
    // A plain click on the empty background (no drag) clears the selection
    // and cancels an in-progress connection — the drag path pans instead.
    if (gesture?.fromBackground && !gesture.moved) {
      clearSelection();
      if (isConnecting) cancelConnecting();
    }
  }, [clearSelection, isConnecting, cancelConnecting]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingOver(false);

    const deviceType = e.dataTransfer.getData('deviceType') as DeviceType;
    if (!deviceType || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - panX) / zoom;
    const y = (e.clientY - rect.top - panY) / zoom;

    addDevice(deviceType, x, y);
  }, [zoom, panX, panY, addDevice]);

  // HTML5 DnD spec: a drop is only accepted if BOTH `dragenter` and
  // `dragover` call preventDefault on the would-be target. The previous
  // implementation only handled `dragover`, which races with the first
  // `dragenter` Chromium fires on page load — that race is what made
  // the very first drag look ignored until the user retried. Handle
  // both events and ref-count enter/leave so children of the canvas
  // (the inner zoom/pan div, the SVG layer) don't flicker the visual
  // indicator off while the cursor is still over the canvas.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!isDraggingOver) setIsDraggingOver(true);
  }, [isDraggingOver]);

  const handleDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingOver(false);
  }, []);

  // Get connection source device for drawing line
  const sourceDevice = connectionSource
    ? devices.find(d => d.id === connectionSource.deviceId)
    : null;

  return (
    <div
      role="application"
      aria-label="Network topology canvas"
      className="relative flex-1 overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900"
    >
      {/* Screen-reader-only status announcements for add/remove/select/connect. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {/* Grid background */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(255,255,255,0.1) 1px, transparent 1px)
          `,
          backgroundSize: `${50 * zoom}px ${50 * zoom}px`,
          backgroundPosition: `${panX}px ${panY}px`
        }}
      />

      {/* Drop zone indicator */}
      {isDraggingOver && (
        <div className="absolute inset-4 border-2 border-dashed border-primary/50 rounded-xl bg-primary/5 pointer-events-none z-10 flex items-center justify-center">
          <span className="text-primary/70 text-lg font-medium">Drop here to add device</span>
        </div>
      )}

      {/* Connection mode indicator */}
      {isConnecting && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-4 py-2 bg-green-500/20 backdrop-blur-md border border-green-500/50 rounded-full">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-green-400 text-sm font-medium">Click on a device to connect</span>
          <button
            onClick={cancelConnecting}
            className="ml-2 p-1 hover:bg-white/10 rounded-full transition-colors"
          >
            <X className="w-4 h-4 text-green-400" />
          </button>
        </div>
      )}

      {/* Canvas area */}
      <div
        id="network-canvas"
        ref={canvasRef}
        className={cn(
          "absolute inset-0 cursor-grab",
          isPanning && "cursor-grabbing",
          isConnecting && "cursor-crosshair"
        )}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDrop={handleDrop}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div
          style={{
            transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
            transformOrigin: '0 0'
          }}
          className="absolute inset-0"
        >
          {/* Connections SVG layer */}
          <svg className="absolute inset-0 w-full h-full pointer-events-auto" style={{ overflow: 'visible' }}>
            {connections.map(connection => (
              <ConnectionLine
                key={connection.id}
                connection={connection}
                devices={devices}
                slot={bundleSlots.get(connection.id)}
              />
            ))}

            {/* Drawing connection line */}
            {isConnecting && sourceDevice && (
              <line
                x1={sourceDevice.x}
                y1={sourceDevice.y}
                x2={mousePos.x}
                y2={mousePos.y}
                stroke="#22c55e"
                strokeWidth={2}
                strokeDasharray="5,5"
                className="pointer-events-none animate-pulse"
              />
            )}

            {/* Packet animations */}
            {activePackets.map(packet => {
              const connection = connections.find(c => c.id === packet.connectionId);
              if (!connection) return null;
              return (
                <PacketAnimation
                  slot={bundleSlots.get(connection.id)}
                  key={packet.id}
                  packet={packet}
                  connection={connection}
                  devices={devices}
                />
              );
            })}
          </svg>

          {/* Devices layer */}
          {devices.map(device => (
            <NetworkDevice
              key={device.id}
              device={device}
              zoom={zoom}
              onOpenTerminal={onOpenTerminal}
            />
          ))}
        </div>
      </div>

      {/* Packet legend */}
      {connections.length > 0 && (
        <div className="absolute bottom-4 left-4 p-2 bg-black/40 backdrop-blur-md rounded-lg border border-white/10">
          <PacketLegend />
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 p-1 bg-black/40 backdrop-blur-md rounded-lg border border-white/10">
        <button
          onClick={() => setZoom(zoom - 0.1)}
          className="p-2 hover:bg-white/10 rounded-md transition-colors"
          disabled={zoom <= 0.25}
          aria-label="Zoom out"
        >
          <ZoomOut className="w-4 h-4 text-white/70" />
        </button>
        <span className="text-xs text-white/70 min-w-[40px] text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => setZoom(zoom + 0.1)}
          className="p-2 hover:bg-white/10 rounded-md transition-colors"
          disabled={zoom >= 2}
          aria-label="Zoom in"
        >
          <ZoomIn className="w-4 h-4 text-white/70" />
        </button>
        <div className="w-px h-4 bg-white/20" />
        <button
          onClick={() => { setZoom(1); setPan(0, 0); }}
          className="p-2 hover:bg-white/10 rounded-md transition-colors"
          aria-label="Reset zoom and pan"
        >
          <Maximize2 className="w-4 h-4 text-white/70" />
        </button>
      </div>

      {/* Empty state */}
      {devices.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-center space-y-3">
            <div className="w-20 h-20 mx-auto rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
              <svg className="w-10 h-10 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-white/50">No devices yet</h3>
            <p className="text-sm text-white/30">Drag equipment from the sidebar to get started</p>
          </div>
        </div>
      )}
    </div>
  );
}
