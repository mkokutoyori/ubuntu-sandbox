import { useNetworkStore } from '@/store/networkStore';
import { LabWorkbench } from '../LabWorkbench';
import { buildAgency, type AgencyDevices } from './agency';
import { buildInternet, type InternetDevices } from './internet';
import { configureWebServer } from './web';

export interface DnsAgenceBancaireLab {
  readonly bench: LabWorkbench;
  readonly internet: InternetDevices;
  readonly agency: AgencyDevices;
}

export async function buildDnsAgenceBancaire(): Promise<DnsAgenceBancaireLab> {
  useNetworkStore.getState().clearAll();
  const bench = new LabWorkbench();
  const internet = await buildInternet(bench);
  await configureWebServer(bench, internet.webBank);
  const agency = await buildAgency(bench, internet.ispRouter);
  return { bench, internet, agency };
}
