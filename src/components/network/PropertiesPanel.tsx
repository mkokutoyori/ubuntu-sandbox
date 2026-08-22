/**
 * PropertiesPanel - Right sidebar for device/connection properties
 */

import { useState } from 'react';
import { useMacTable, useConnectionPerf } from '@/react/hooks';
import { X, Power, Wifi, Settings, Network, ChevronDown, ChevronRight, Trash2, Cable, Activity } from 'lucide-react';
import { useNetworkStore, isConnectionActive } from '@/store/networkStore';
import { DeviceIcon } from './DeviceIcon';
import { isFullyImplemented } from '@/network';
import { getConnectionDetails } from './properties-panel-logic';
import { LiveDeviceStats } from './devtools/LiveDeviceStats';
import { cn } from '@/lib/utils';

interface MACTableEntry {
  macAddress: string;
  interfaceId: string;
  vlan: number;
  timestamp: number;
  type: 'dynamic' | 'static' | 'blackhole';
}

interface SwitchInstance {
  clearMACTable(): void;
}

function isSwitchInstance(obj: unknown): obj is SwitchInstance {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    typeof (obj as Record<string, unknown>)['clearMACTable'] === 'function'
  );
}

export function PropertiesPanel() {
  const {
    getDevices,
    connections,
    selectedDeviceId,
    selectedConnectionId,
    updateDevice,
    selectDevice,
    deviceInstances,
  } = useNetworkStore();

  const [expandedSections, setExpandedSections] = useState<string[]>(['general', 'interfaces']);

  const devices = getDevices();
  const selectedDevice = selectedDeviceId ? devices.find(d => d.id === selectedDeviceId) : null;
  const isSwitch = selectedDevice?.type === 'switch-cisco' || selectedDevice?.type === 'switch-huawei' || selectedDevice?.type === 'switch-generic';

  const macRows = useMacTable(isSwitch ? selectedDevice?.instance ?? null : null);
  const macTable: MACTableEntry[] = macRows.map(r => ({
    macAddress: r.mac,
    interfaceId: r.port,
    vlan: r.vlan,
    timestamp: r.timestamp,
    type: r.type,
  }));

  const handleClearMACTable = () => {
    if (selectedDevice && isSwitch && isSwitchInstance(selectedDevice.instance)) {
      selectedDevice.instance.clearMACTable();
    }
  };

  const selectedConnection = selectedConnectionId ? connections.find(c => c.id === selectedConnectionId) : null;

  // Hooks must run on every render (Rules of Hooks): calling this inside the
  // `if (selectedConnection)` branch below crashed the whole app the moment a
  // cable was selected ("Rendered more hooks than during the previous render").
  const perf = useConnectionPerf(
    selectedConnection ?? null,
    (id) => deviceInstances?.get(id),
  );

  const toggleSection = (section: string) => {
    setExpandedSections(prev =>
      prev.includes(section) ? prev.filter(s => s !== section) : [...prev, section]
    );
  };

  if (!selectedDevice && !selectedConnection) {
    return (
      <div className="w-72 bg-card/30 backdrop-blur-xl border-l border-white/10 flex flex-col">
        <div className="p-4 border-b border-white/10">
          <h2 className="text-sm font-semibold text-foreground/90">Properties</h2>
        </div>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center text-muted-foreground">
            <Settings className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">Select a device or connection to view properties</p>
          </div>
        </div>
      </div>
    );
  }

  if (selectedConnection) {
    const sourceDevice = devices.find(d => d.id === selectedConnection.sourceDeviceId);
    const targetDevice = devices.find(d => d.id === selectedConnection.targetDeviceId);
    const details = getConnectionDetails(selectedConnection);

    return (
      <div className="w-72 bg-card/30 backdrop-blur-xl border-l border-white/10 flex flex-col">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cable className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground/90">Connection</h2>
          </div>
          <button
            onClick={() => selectDevice(null)}
            title="Clear selection"
            aria-label="Clear selection"
            className="p-1 hover:bg-white/10 rounded transition-colors"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Connection type */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Type</label>
            <div className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm font-medium">
              {details.typeLabel}
            </div>
          </div>

          {/* Source device + interface */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Source</label>
            <div className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm">
              <div className="flex items-center gap-2">
                {sourceDevice && <DeviceIcon type={sourceDevice.type} size={16} />}
                <span>{sourceDevice?.name || 'Unknown'}</span>
              </div>
              <div className="text-xs text-blue-400 mt-1 font-mono">
                {details.sourceInterface}
              </div>
            </div>
          </div>

          {/* Target device + interface */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Target</label>
            <div className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm">
              <div className="flex items-center gap-2">
                {targetDevice && <DeviceIcon type={targetDevice.type} size={16} />}
                <span>{targetDevice?.name || 'Unknown'}</span>
              </div>
              <div className="text-xs text-blue-400 mt-1 font-mono">
                {details.targetInterface}
              </div>
            </div>
          </div>

          {/* Performance details */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              <Activity className="w-3 h-3" />
              Performance
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div className="px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                <div className="text-[10px] text-muted-foreground">Bandwidth</div>
                <div className="text-sm font-medium text-foreground/90">{perf.bandwidthLabel}</div>
              </div>
              <div className="px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                <div className="text-[10px] text-muted-foreground">Latency</div>
                <div className="text-sm font-medium text-foreground/90">{perf.latencyLabel}</div>
              </div>
            </div>
          </div>

          {/* Status */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Status</label>
            <div className={cn(
              "px-3 py-2 rounded-lg border text-sm flex items-center gap-2",
              isConnectionActive(selectedConnection)
                ? "bg-green-500/10 border-green-500/30 text-green-400"
                : "bg-red-500/10 border-red-500/30 text-red-400"
            )}>
              <div className={cn(
                "w-2 h-2 rounded-full",
                isConnectionActive(selectedConnection) ? "bg-green-500" : "bg-red-500"
              )} />
              {isConnectionActive(selectedConnection) ? 'Active' : 'Inactive'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!selectedDevice) return null;

  const isImplemented = isFullyImplemented(selectedDevice.type);

  return (
    <div className="w-72 bg-card/30 backdrop-blur-xl border-l border-white/10 flex flex-col">
      <div className="p-4 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <DeviceIcon type={selectedDevice.type} size={20} />
          <h2 className="text-sm font-semibold text-foreground/90 truncate">{selectedDevice.name}</h2>
        </div>
        <button
          onClick={() => selectDevice(null)}
          title="Clear selection"
          aria-label="Clear selection"
          className="p-1 hover:bg-white/10 rounded transition-colors"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Implementation status */}
        {!isImplemented && (
          <div className="mx-3 mt-3 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-xs text-yellow-400">
            This device type is not fully implemented yet
          </div>
        )}

        {/* General Section */}
        <div className="border-b border-white/10">
          <button
            onClick={() => toggleSection('general')}
            className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors"
          >
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">General</span>
            {expandedSections.includes('general') ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
          </button>

          {expandedSections.includes('general') && (
            <div className="px-3 pb-3 space-y-3">
              <div className="space-y-1">
                <label htmlFor="device-name" className="text-xs text-muted-foreground">Name</label>
                <input
                  id="device-name"
                  name="deviceName"
                  type="text"
                  autoComplete="off"
                  value={selectedDevice.name}
                  onChange={(e) => updateDevice(selectedDevice.id, { name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:border-primary/50 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="device-hostname" className="text-xs text-muted-foreground">Hostname</label>
                <input
                  id="device-hostname"
                  name="deviceHostname"
                  type="text"
                  autoComplete="off"
                  value={selectedDevice.hostname}
                  onChange={(e) => updateDevice(selectedDevice.id, { hostname: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:border-primary/50 focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Power</span>
                <button
                  onClick={() => updateDevice(selectedDevice.id, { isPoweredOn: !selectedDevice.isPoweredOn })}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors",
                    selectedDevice.isPoweredOn
                      ? "bg-green-500/20 text-green-400 border border-green-500/30"
                      : "bg-white/5 text-muted-foreground border border-white/10"
                  )}
                >
                  <Power className="w-3 h-3" />
                  {selectedDevice.isPoweredOn ? 'On' : 'Off'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Interfaces Section */}
        <div className="border-b border-white/10">
          <button
            onClick={() => toggleSection('interfaces')}
            className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors"
          >
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Interfaces ({selectedDevice.interfaces.length})
            </span>
            {expandedSections.includes('interfaces') ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
          </button>

          {expandedSections.includes('interfaces') && (
            <div className="px-3 pb-3 space-y-2 max-h-60 overflow-y-auto">
              {selectedDevice.interfaces.slice(0, 8).map(iface => {
                // A cable being drawn is not the link being up: the peer
                // may be shut down or switched off. The cable answers
                // "is it wired?", the carrier answers "does it carry?",
                // and the panel now says both instead of conflating them.
                const isCabled = connections.some(
                  c => (c.sourceDeviceId === selectedDevice.id && c.sourceInterfaceId === iface.id) ||
                       (c.targetDeviceId === selectedDevice.id && c.targetInterfaceId === iface.id)
                );
                const isConnected = isCabled && iface.isOperational !== false;
                const status = !isCabled ? null
                  : iface.isOperational !== false ? 'Connected'
                  : iface.isUp === false ? 'Admin down'
                  : 'No carrier';

                return (
                  <div
                    key={iface.id}
                    className={cn(
                      "px-3 py-2 rounded-lg border text-xs",
                      isConnected
                        ? "bg-blue-500/10 border-blue-500/30"
                        : "bg-white/5 border-white/10"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-foreground/90">{iface.name}</span>
                      {(iface.type as string) === 'wifi' && <Wifi className="w-3 h-3 text-green-400" />}
                      {iface.type === 'ethernet' && <Network className="w-3 h-3 text-blue-400" />}
                    </div>
                    <div className="text-muted-foreground mt-1">{iface.macAddress}</div>
                    {iface.ipAddress && (
                      <div className="text-green-400 mt-1">IP: {iface.ipAddress}</div>
                    )}
                    {status && (
                      <div
                        data-testid={`iface-status-${iface.name}`}
                        className={cn('mt-1', isConnected ? 'text-blue-400' : 'text-red-400')}
                      >
                        {status}
                      </div>
                    )}
                  </div>
                );
              })}
              {selectedDevice.interfaces.length > 8 && (
                <div className="text-xs text-muted-foreground text-center py-2">
                  +{selectedDevice.interfaces.length - 8} more interfaces
                </div>
              )}
            </div>
          )}
        </div>

        {/* MAC Table Section (only for switches) */}
        {isSwitch && (
          <div className="border-b border-white/10">
            <button
              onClick={() => toggleSection('macTable')}
              className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors"
            >
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                MAC Table ({macTable.length})
              </span>
              {expandedSections.includes('macTable') ? (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              )}
            </button>

            {expandedSections.includes('macTable') && (
              <div className="px-3 pb-3">
                {/* Action buttons */}
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={handleClearMACTable}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400 hover:bg-red-500/20 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    Clear
                  </button>
                </div>

                {/* MAC Table entries */}
                {macTable.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-4">
                    No MAC addresses learned yet
                  </div>
                ) : (
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {macTable.map((entry, idx) => (
                      <div
                        key={`${entry.macAddress}-${idx}`}
                        className="px-2 py-1.5 rounded bg-white/5 border border-white/10 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-foreground/90">{entry.macAddress}</span>
                          <span className={cn(
                            "px-1.5 py-0.5 rounded text-[10px]",
                            entry.type === 'static'
                              ? "bg-blue-500/20 text-blue-400"
                              : "bg-green-500/20 text-green-400"
                          )}>
                            {entry.type}
                          </span>
                        </div>
                        <div className="text-muted-foreground mt-0.5">
                          Port: {entry.interfaceId} | VLAN: {entry.vlan}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/*
          Section « Live » — le read-model réactif branché.

          `LiveDeviceStats` existait, testé, et son propre en-tête disait
          « intentionally untouched by the existing UI » : un pont
          complet vers l'état réel de l'équipement (ARP, routes, TCP,
          voisins OSPF, IPSec, NAT, DHCP) que rien n'ouvrait. Voir un
          voisinage OSPF monter en direct est ce que cet outil a de plus
          pédagogique, et cela ne coûtait qu'un point d'accroche.

          Repliée par défaut : ses hooks s'abonnent au bus, et un
          panneau fermé ne doit pas payer d'abonnement pour une donnée
          que personne ne regarde.
        */}
        <div className="border-b border-white/10">
          <button
            onClick={() => toggleSection('live')}
            aria-expanded={expandedSections.includes('live')}
            className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors"
          >
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Live state
            </span>
            {expandedSections.includes('live') ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
          </button>

          {expandedSections.includes('live') && (
            <div className="px-3 pb-3">
              <LiveDeviceStats deviceId={selectedDevice.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
