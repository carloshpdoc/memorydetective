/**
 * Types shared across parsers and tools.
 */

export interface LeaksHeader {
  hardwareModel?: string;
  process?: string;
  pid?: number;
  identifier?: string;
  version?: string;
  platform?: string;
  osVersion?: string;
  dateTime?: string;
  physicalFootprint?: string;
  physicalFootprintPeak?: string;
}

export interface LeaksTotals {
  nodesMalloced?: number;
  totalKB?: number;
  leakCount: number;
  totalLeakedBytes: number;
}

export type RetainKind = "__strong" | "weak" | "unowned" | "plain";

export interface CycleNode {
  /** Live count attached to this node (may be undefined for CYCLE BACK terminators). */
  count?: number;
  /** Human-readable size, e.g. "56.9K" / "32 bytes". */
  size?: string;
  /** Property/path that points to this object from its parent (e.g. "__strong _viewModel.wrappedValue"). */
  edge?: string;
  /** Strong/weak/unowned hint when explicit; otherwise "plain". */
  retainKind: RetainKind;
  /** Class name without `<...>` brackets, e.g. "DetailViewModel". May be empty for `0xADDR [SIZE]` style. */
  className: string;
  /** Hex address as it appeared, e.g. "0x15a9f1e00". */
  address: string;
  /** Instance size in bytes if shown in `[N]`. */
  instanceSize?: number;
  /** True when the line begins/contains "ROOT CYCLE". */
  isRootCycle: boolean;
  /** True when the line is a "CYCLE BACK TO" terminator. */
  isCycleBack: boolean;
  /** Indentation level (raw leading-space count) — useful for diagnostics. */
  indent: number;
  /** Children nested at deeper indentation. */
  children: CycleNode[];
}

export interface LeaksReport {
  header: LeaksHeader;
  totals: LeaksTotals;
  /** Top-level cycles (and standalone leaks) as parsed. */
  cycles: CycleNode[];
  /** True if the report contains zero ROOT CYCLE entries (independent of leakCount, since plain leaks may exist). */
  hasNoCycles: boolean;
}
