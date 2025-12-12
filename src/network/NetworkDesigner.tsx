import { useState } from 'react';
import { DevicePalette } from './components/DevicePalette';
import { NetworkCanvas } from './components/NetworkCanvas';
import { PropertiesPanel } from './components/PropertiesPanel';
import { Toolbar } from './components/Toolbar';
import { TerminalModal } from './components/TerminalModal';
import { DeviceType, NetworkDevice } from './types';

export function NetworkDesigner() {
  const [projectName, setProjectName] = useState('My Network');
  const [, setDraggingDevice] = useState<DeviceType | null>(null);
  const [terminalDevice, setTerminalDevice] = useState<NetworkDevice | null>(null);

  const handleOpenTerminal = (device: NetworkDevice) => {
    if (device.isPoweredOn) {
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
