import { SettingsRegistry } from './settingsRegistry';
import { simulationSettingsSection } from './sections/simulationSection';

export const defaultSettingsRegistry = new SettingsRegistry().register(simulationSettingsSection);
