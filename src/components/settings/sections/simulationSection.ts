import { Timer } from 'lucide-react';
import type { SettingsSection } from '../settingsRegistry';
import { SimulationSettings } from './SimulationSettings';

export const simulationSettingsSection: SettingsSection = {
  id: 'simulation',
  label: 'Simulation',
  description: 'How the simulated infrastructure behaves over time.',
  labelKey: 'settings.simulation.label',
  descriptionKey: 'settings.simulation.description',
  icon: Timer,
  keywords: ['time', 'clock', 'pause', 'speed', 'advance', 'timers', 'scheduler'],
  component: SimulationSettings,
};
