/**
 * InterfaceSelectorPopover - Popup for choosing a network interface
 * and connection type when creating a connection.
 *
 * Appears when clicking a device during connection mode.
 * Shows available interfaces grouped by type, with connection status.
 */

import { useState, useEffect, useRef } from 'react';
import { Network, Radio, Terminal, X, Check, Cable } from 'lucide-react';
import type { ConnectionType } from '@/network';
import { Connection, NetworkInterfaceConfig } from '@/store/networkStore';
import { buildInterfaceList, groupInterfacesByType, InterfaceListItem } from './interface-selector-logic';
import { getConnectionLabel } from './connection-helpers';
import { cn } from '@/lib/utils';

interface InterfaceSelectorPopoverProps {
  /** Device ID */
  deviceId: string;
  /** Device display name */
  deviceName: string;
  /** All interfaces on this device */
  interfaces: NetworkInterfaceConfig[];
  /** Current connections in the topology */
  connections: Connection[];
  /** Position to display the popover */
  position: { x: number; y: number };
  /** Whether we are selecting source (true) or target (false) */
  isSource: boolean;
  /** Pre-selected connection type (for target selection) */
  connectionType?: ConnectionType;
  /** Callback when user selects an interface */
  onSelect: (interfaceId: string, connectionType: ConnectionType) => void;
  /** Callback when user cancels */
  onCancel: () => void;
}

const TYPE_ICONS: Record<string, typeof Network> = {
  ethernet: Network,
  serial: Radio,
  console: Terminal
};

const TYPE_COLORS: Record<string, string> = {
  ethernet: 'text-blue-400 bg-blue-500/20 border-blue-500/30',
  serial: 'text-orange-400 bg-orange-500/20 border-orange-500/30',
  console: 'text-gray-400 bg-gray-500/20 border-gray-500/30'
};

export function InterfaceSelectorPopover({
  deviceId,
  deviceName,
  interfaces,
  connections,
  position,
  isSource,
  connectionType: preselectedType,
  onSelect,
  onCancel
}: InterfaceSelectorPopoverProps) {
  const [selectedType, setSelectedType] = useState<ConnectionType>(preselectedType || 'ethernet');
  const popoverRef = useRef<HTMLDivElement>(null);

  // Build interface list with availability info
  const filterType = isSource ? undefined : preselectedType;
  const interfaceList = buildInterfaceList(deviceId, interfaces, connections, filterType);
  const groups = groupInterfacesByType(interfaceList);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onCancel]);

  const handleInterfaceClick = (item: InterfaceListItem) => {
    if (!item.isAvailable) return;
    const type = isSource ? selectedType : (preselectedType || selectedType);
    onSelect(item.id, type);
  };

  // Available connection types for source selection
  const availableTypes: ConnectionType[] = isSource
    ? (['ethernet', 'serial', 'console'] as ConnectionType[]).filter(t =>
        interfaces.some(i => i.type === t)
      )
    : preselectedType ? [preselectedType] : ['ethernet'];

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 animate-in fade-in slide-in-from-top-2 duration-150"
      style={{ left: position.x, top: position.y }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className={cn(
        "w-72 rounded-xl overflow-hidden",
        "bg-slate-900/95 backdrop-blur-xl",
        "border border-white/15 shadow-2xl shadow-black/50"
      )}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Cable className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-white/90">
              {isSource ? 'Source' : 'Target'}: {deviceName}
            </span>
          </div>
          <button
            onClick={onCancel}
            className="p-1 hover:bg-white/10 rounded transition-colors"
          >
            <X className="w-3.5 h-3.5 text-white/50" />
          </button>
        </div>

        {/* Connection type selector (source only) */}
        {isSource && availableTypes.length > 1 && (
          <div className="px-4 py-2 border-b border-white/10">
            <label className="text-[10px] text-white/40 uppercase tracking-wider font-medium">
              Cable type
            </label>
            <div className="flex gap-1.5 mt-1.5">
              {availableTypes.map(type => {
                const Icon = TYPE_ICONS[type] || Network;
                const isActive = selectedType === type;
                return (
                  <button
                    key={type}
                    onClick={() => setSelectedType(type)}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg",
                      "text-xs font-medium border transition-all",
                      isActive
                        ? TYPE_COLORS[type]
                        : "text-white/40 bg-white/5 border-white/10 hover:bg-white/10"
                    )}
                  >
                    <Icon className="w-3 h-3" />
                    {getConnectionLabel(type)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Interface list */}
        <div className="max-h-60 overflow-y-auto p-2">
          {Object.entries(groups).map(([type, items]) => {
            const Icon = TYPE_ICONS[type] || Network;
            const typeMatch = isSource
              ? type === selectedType
              : !preselectedType || type === preselectedType;

            return (
              <div key={type} className="mb-1 last:mb-0">
                {/* Type group header */}
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <Icon className="w-3 h-3 text-white/30" />
                  <span className="text-[10px] text-white/30 uppercase tracking-wider font-medium">
                    {getConnectionLabel(type as ConnectionType)}
                  </span>
                </div>

                {/* Interfaces */}
                {items.map(item => (
                  <button
                    key={item.id}
                    onClick={() => handleInterfaceClick(item)}
                    disabled={!item.isAvailable || (isSource && type !== selectedType)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left",
                      "transition-all text-xs",
                      item.isAvailable && (isSource ? type === selectedType : typeMatch)
                        ? "hover:bg-white/10 cursor-pointer"
                        : "opacity-40 cursor-not-allowed"
                    )}
                  >
                    {/* Status indicator */}
                    <div className={cn(
                      "w-2 h-2 rounded-full flex-shrink-0",
                      item.isConnected
                        ? "bg-blue-500"
                        : item.isAvailable && (isSource ? type === selectedType : typeMatch)
                          ? "bg-green-500"
                          : "bg-gray-600"
                    )} />

                    {/* Interface info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-white/90 truncate">{item.name}</span>
                        {item.isConnected && (
                          <span className="text-[10px] text-blue-400 ml-2 flex-shrink-0">Connected</span>
                        )}
                      </div>
                      {item.ipAddress && (
                        <div className="text-[10px] text-green-400 mt-0.5">{item.ipAddress}</div>
                      )}
                      {item.macAddress && (
                        <div className="text-[10px] text-white/30 mt-0.5 font-mono">{item.macAddress}</div>
                      )}
                    </div>

                    {/* Select indicator */}
                    {item.isAvailable && (isSource ? type === selectedType : typeMatch) && (
                      <Check className="w-3.5 h-3.5 text-white/20 flex-shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            );
          })}

          {interfaceList.length === 0 && (
            <div className="text-center py-4 text-xs text-white/40">
              No interfaces available
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
