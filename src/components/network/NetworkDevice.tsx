/**
 * NetworkDevice - Visual representation of a device on the canvas
 *
 * When the user clicks "Connect", an InterfaceSelectorPopover appears
 * to let them pick the source interface and cable type.
 * When clicking a target device in connection mode, another popover
 * appears for the target interface selection.
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { Power, Settings, Terminal, Trash2, Link } from 'lucide-react';
import { DeviceIcon } from './DeviceIcon';
import { InterfaceSelectorPopover } from './InterfaceSelectorPopover';
import { NetworkDeviceUI, useNetworkStore } from '@/store/networkStore';
import { DeviceFactory } from '@/domain/devices/DeviceFactory';
import { BaseDevice, ConnectionType } from '@/domain/devices';
import { cn } from '@/lib/utils';

interface NetworkDeviceProps {
  device: NetworkDeviceUI;
  zoom: number;
  onOpenTerminal?: (device: BaseDevice) => void;
}

export function NetworkDevice({ device, zoom, onOpenTerminal }: NetworkDeviceProps) {
  const {
    selectedDeviceId,
    selectDevice,
    moveDevice,
    removeDevice,
    updateDevice,
    isConnecting,
    startConnecting,
    finishConnecting,
    cancelConnecting,
    connectionSource,
    connections
  } = useNetworkStore();

  const [isDragging, setIsDragging] = useState(false);
  const [showSourceSelector, setShowSourceSelector] = useState(false);
  const [showTargetSelector, setShowTargetSelector] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState({ x: 0, y: 0 });
  const dragOffset = useRef({ x: 0, y: 0 });
  const deviceRef = useRef<HTMLDivElement>(null);

  const isSelected = selectedDeviceId === device.id;
  const isConnectionSource = connectionSource?.deviceId === device.id;
  const hasTerminal = DeviceFactory.hasTerminalSupport(device.type);

  const getPopoverPosition = useCallback(() => {
    if (!deviceRef.current) return { x: 0, y: 0 };
    const rect = deviceRef.current.getBoundingClientRect();
    return {
      x: rect.right + 8,
      y: rect.top
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    if (isConnecting && !isConnectionSource) {
      // Show target interface selector instead of auto-selecting
      setPopoverPosition(getPopoverPosition());
      setShowTargetSelector(true);
      return;
    }

    selectDevice(device.id);
    setIsDragging(true);

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffset.current = {
      x: e.clientX - rect.left - rect.width / 2,
      y: e.clientY - rect.top - rect.height / 2
    };
  }, [device, isConnecting, isConnectionSource, selectDevice, getPopoverPosition]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const canvas = document.getElementById('network-canvas');
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / zoom - dragOffset.current.x;
      const y = (e.clientY - rect.top) / zoom - dragOffset.current.y;

      moveDevice(device.id, Math.max(0, x), Math.max(0, y));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, device.id, zoom, moveDevice]);

  // Open source interface selector (instead of auto-selecting first free)
  const handleStartConnection = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPopoverPosition(getPopoverPosition());
    setShowSourceSelector(true);
  };

  const handleSourceSelect = (interfaceId: string, connectionType: ConnectionType) => {
    setShowSourceSelector(false);
    startConnecting(device.id, interfaceId, connectionType);
  };

  const handleTargetSelect = (interfaceId: string) => {
    setShowTargetSelector(false);
    finishConnecting(device.id, interfaceId);
  };

  const handleDoubleClick = () => {
    if (hasTerminal && onOpenTerminal) {
      onOpenTerminal(device.instance);
    }
  };

  const handleTogglePower = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateDevice(device.id, { isPoweredOn: !device.isPoweredOn });
  };

  return (
    <>
      <div
        ref={deviceRef}
        className={cn(
          "absolute flex flex-col items-center gap-1 cursor-pointer select-none",
          "transition-transform duration-75",
          isDragging && "z-50"
        )}
        style={{
          left: device.x,
          top: device.y,
          transform: 'translate(-50%, -50%)'
        }}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      >
        {/* Device Card */}
        <div
          className={cn(
            "relative p-3 rounded-xl backdrop-blur-md transition-all",
            "bg-gradient-to-br from-white/10 to-white/5",
            "border shadow-lg",
            isSelected
              ? "border-primary/60 shadow-primary/20 ring-2 ring-primary/30"
              : "border-white/20 hover:border-white/30",
            isConnectionSource && "border-green-500 ring-2 ring-green-500/50",
            isConnecting && !isConnectionSource && "hover:border-green-400 hover:ring-2 hover:ring-green-400/50",
            !device.isPoweredOn && "opacity-50"
          )}
        >
          {/* Power indicator */}
          <div
            className={cn(
              "absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border border-black/20",
              device.isPoweredOn
                ? "bg-green-500 shadow-green-500/50 shadow-sm"
                : "bg-gray-500"
            )}
          />

          <DeviceIcon type={device.type} size={36} />
        </div>

        {/* Device Label */}
        <div className={cn(
          "px-2 py-0.5 rounded-md text-[10px] font-medium",
          "bg-black/40 backdrop-blur-sm text-white/90",
          "max-w-[80px] truncate"
        )}>
          {device.name}
        </div>

        {/* Quick Actions (on selection) */}
        {isSelected && !isConnecting && (
          <div className={cn(
            "absolute -bottom-10 left-1/2 -translate-x-1/2",
            "flex items-center gap-1 p-1 rounded-lg",
            "bg-black/60 backdrop-blur-md border border-white/20",
            "animate-in fade-in slide-in-from-top-2 duration-200"
          )}>
            <button
              onClick={handleTogglePower}
              className={cn(
                "p-1.5 rounded-md hover:bg-white/10 transition-colors",
                device.isPoweredOn ? "text-green-400" : "text-gray-400"
              )}
              title="Toggle Power"
            >
              <Power className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleStartConnection}
              className="p-1.5 rounded-md hover:bg-white/10 text-blue-400 transition-colors"
              title="Connect"
            >
              <Link className="w-3.5 h-3.5" />
            </button>
            {hasTerminal && onOpenTerminal && (
              <button
                onClick={(e) => { e.stopPropagation(); onOpenTerminal(device.instance); }}
                className="p-1.5 rounded-md hover:bg-white/10 text-green-400 transition-colors"
                title="Open Terminal"
              >
                <Terminal className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={(e) => e.stopPropagation()}
              className="p-1.5 rounded-md hover:bg-white/10 text-white/60 transition-colors"
              title="Settings"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); removeDevice(device.id); }}
              className="p-1.5 rounded-md hover:bg-white/10 text-red-400 transition-colors"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Source Interface Selector Popover */}
      {showSourceSelector && (
        <InterfaceSelectorPopover
          deviceId={device.id}
          deviceName={device.name}
          interfaces={device.interfaces}
          connections={connections}
          position={popoverPosition}
          isSource={true}
          onSelect={handleSourceSelect}
          onCancel={() => setShowSourceSelector(false)}
        />
      )}

      {/* Target Interface Selector Popover */}
      {showTargetSelector && connectionSource && (
        <InterfaceSelectorPopover
          deviceId={device.id}
          deviceName={device.name}
          interfaces={device.interfaces}
          connections={connections}
          position={popoverPosition}
          isSource={false}
          connectionType={connectionSource.connectionType}
          onSelect={(interfaceId) => handleTargetSelect(interfaceId)}
          onCancel={() => {
            setShowTargetSelector(false);
            cancelConnecting();
          }}
        />
      )}
    </>
  );
}
