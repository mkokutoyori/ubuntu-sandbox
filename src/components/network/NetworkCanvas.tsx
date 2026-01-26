/**
 * NetworkCanvas - Main canvas for network topology design
 */

import { useRef, useCallback, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2, X } from 'lucide-react';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkDevice } from './NetworkDevice';
import { ConnectionLine } from './ConnectionLine';
import { PacketAnimation, PacketLegend } from './PacketAnimation';
import { DeviceType } from '@/domain/devices';
import { BaseDevice } from '@/domain/devices';
import { useNetworkSimulator } from '@/hooks/useNetworkSimulator';
import { cn } from '@/lib/utils';

interface NetworkCanvasProps {
  onOpenTerminal?: (device: BaseDevice) => void;
}

export function NetworkCanvas({ onOpenTerminal }: NetworkCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
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
    connectionSource
  } = useNetworkStore();

  const devices = getDevices();

  // Network simulation
  const { activePackets } = useNetworkSimulator();

  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = -e.deltaY * 0.001;
      setZoom(zoom + delta);
    }
  }, [zoom, setZoom]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      setStartPan({ x: e.clientX - panX, y: e.clientY - panY });
    } else if (e.button === 0 && e.target === e.currentTarget) {
      clearSelection();
      if (isConnecting) {
        cancelConnecting();
      }
    }
  }, [panX, panY, clearSelection, isConnecting, cancelConnecting]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    setMousePos({
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top) / zoom
    });

    if (isPanning) {
      setPan(e.clientX - startPan.x, e.clientY - startPan.y);
    }
  }, [isPanning, startPan, zoom, setPan]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);

    const deviceType = e.dataTransfer.getData('deviceType') as DeviceType;
    if (!deviceType || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - panX) / zoom;
    const y = (e.clientY - rect.top - panY) / zoom;

    addDevice(deviceType, x, y);
  }, [zoom, panX, panY, addDevice]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDraggingOver(false);
  }, []);

  // Get connection source device for drawing line
  const sourceDevice = connectionSource
    ? devices.find(d => d.id === connectionSource.deviceId)
    : null;

  return (
    <div className="relative flex-1 overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
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
          "absolute inset-0 cursor-default",
          isPanning && "cursor-grabbing",
          isConnecting && "cursor-crosshair"
        )}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDrop={handleDrop}
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
        >
          <ZoomIn className="w-4 h-4 text-white/70" />
        </button>
        <div className="w-px h-4 bg-white/20" />
        <button
          onClick={() => { setZoom(1); setPan(0, 0); }}
          className="p-2 hover:bg-white/10 rounded-md transition-colors"
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
