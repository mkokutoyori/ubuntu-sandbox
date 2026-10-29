import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { MessageKey } from '@/i18n';

export interface SettingsSection {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly labelKey?: MessageKey;
  readonly descriptionKey?: MessageKey;
  readonly icon: LucideIcon;
  readonly keywords: readonly string[];
  readonly component: ComponentType;
}

export class SettingsRegistry {
  private readonly sections = new Map<string, SettingsSection>();

  register(section: SettingsSection): this {
    if (this.sections.has(section.id)) {
      throw new Error(`Settings section "${section.id}" is already registered`);
    }
    this.sections.set(section.id, section);
    return this;
  }

  list(): SettingsSection[] {
    return [...this.sections.values()];
  }

  get(id: string): SettingsSection | undefined {
    return this.sections.get(id);
  }

  search(
    query: string,
    shown: (section: SettingsSection) => readonly string[] = (section) => [section.label, section.description],
  ): SettingsSection[] {
    const needle = query.trim().toLowerCase();
    if (needle === '') return this.list();
    return this.list().filter((section) =>
      [...shown(section), ...section.keywords].some((text) => text.toLowerCase().includes(needle)));
  }
}
