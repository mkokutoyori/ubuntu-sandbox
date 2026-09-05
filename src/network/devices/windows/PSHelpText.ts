import { renderCmdletHelp, helpTopicNotFound, HELP_SYSTEM_TOPIC } from '@/powershell/help/renderHelp';

export function formatGetHelp(
  topic?: string,
  opts?: {
    examples?: boolean; detailed?: boolean; full?: boolean; parameter?: string;
    online?: boolean; showWindow?: boolean; category?: string; component?: string;
    role?: string; functionality?: string;
  },
): string {
  if (!topic) return HELP_SYSTEM_TOPIC;
  const cleaned = topic.replace(/^["']|["']$/g, '');
  return renderCmdletHelp(cleaned, opts) ?? `${HELP_SYSTEM_TOPIC}\n\n${helpTopicNotFound(cleaned)}`;
}
