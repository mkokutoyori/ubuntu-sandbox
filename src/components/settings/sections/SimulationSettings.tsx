import { SimulationClockControls } from '@/components/network/SimulationClockControls';
import { SettingsCard } from '../SettingsLayout';

export function SimulationSettings() {
  return (
    <div className="space-y-4">
      <SettingsCard
        title="Clock"
        description="Pause the clock of the whole infrastructure, run it faster than real time, or jump forward to see timers, schedulers, certificates and sessions expire."
      >
        <SimulationClockControls />
      </SettingsCard>
    </div>
  );
}

