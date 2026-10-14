import type { MainRecon } from './bridge';
import type { Settings } from './settings';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DiagnosticCheck {
  module: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

/** What the content script returns for { type: 'diagnostics' }. */
export interface Diagnostics {
  version: string;
  url: string;
  collectedAt: string;
  checks: DiagnosticCheck[];
  settings: Settings;
  /** Compact tree of the watch page structure, for adapting to new layouts. */
  layoutTree: string | null;
  main: MainRecon | null;
}
