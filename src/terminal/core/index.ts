/**
 * Core terminal architecture — barrel export
 */

// Types
export type {
  TextSegment, TextStyle, RichOutputLine, LineType,
  TerminalResponse,
  InputDirective, InputDirectiveType,
  CommandDirective, PasswordDirective, TextPromptDirective,
  ConfirmationDirective, ChoiceDirective, PagerDirective,
  EditorDirective, BlockedDirective, ReverseSearchDirective,
  PagerControls, InputValidation,
  InteractiveStep, InteractiveStepType,
  FlowContext, ValidationResult,
} from './types';

// Output formatters
export type { IOutputFormatter } from './OutputFormatter';
export {
  AnsiOutputFormatter, PlainOutputFormatter, WindowsOutputFormatter,
  parseAnsiToSegments,
} from './OutputFormatter';

// Interactive flow engine
export { InteractiveFlowEngine } from './InteractiveFlow';
