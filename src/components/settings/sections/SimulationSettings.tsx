import { SimulationClockControls } from '@/components/network/SimulationClockControls';
import { SettingsCard } from '../SettingsLayout';
import { useLocale } from '@/i18n/useLocale';

export function SimulationSettings() {
  const { t } = useLocale();
  return (
    <div className="space-y-4">
      <SettingsCard
        title={t('settings.clock.title')}
        description={t('settings.clock.description')}
      >
        <SimulationClockControls />
      </SettingsCard>
    </div>
  );
}

