/**
 * NetworkDesigner - Main component for network topology design
 * Integrates all UI components with Sprint 1 device classes
 */

import { useState } from 'react';
import { DevicePalette } from './DevicePalette';
import { NetworkCanvas } from './NetworkCanvas';
import { PropertiesPanel } from './PropertiesPanel';
import { Toolbar } from './Toolbar';
import { TerminalModal } from './TerminalModal';
import { DeviceType } from '@/devices/common/types';
import { BaseDevice } from '@/devices';

export function NetworkDesigner() {
  const [projectName, setProjectName] = useState('My Network');
  const [, setDraggingDevice] = useState<DeviceType | null>(null);
  const [terminalDevice, setTerminalDevice] = useState<BaseDevice | null>(null);

  const handleOpenTerminal = (device: BaseDevice) => {
    if (device.getIsPoweredOn()) {
      setTerminalDevice(device);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <Toolbar
        projectName={projectName}
        onProjectNameChange={setProjectName}
      />

      <div className="flex-1 flex overflow-hidden">
        <DevicePalette onDragStart={setDraggingDevice} />
        <NetworkCanvas onOpenTerminal={handleOpenTerminal} />
        <PropertiesPanel />
      </div>

      {/* Terminal Modal */}
      {terminalDevice && (
        <TerminalModal
          device={terminalDevice}
          onClose={() => setTerminalDevice(null)}
        />
      )}
    </div>
  );
}
