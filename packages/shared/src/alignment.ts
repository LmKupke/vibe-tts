import type { AlignmentEntry } from "./domain";

export interface AlignmentValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function comparable(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

export function validateAlignment(
  sourceText: string,
  entries: readonly AlignmentEntry[],
): AlignmentValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let previousCharEnd = 0;
  let previousStartMs = 0;
  let previousEndMs = 0;

  entries.forEach((entry, index) => {
    const label = `alignment[${index}]`;
    if (!Number.isFinite(entry.charStart) || !Number.isFinite(entry.charEnd)) {
      errors.push(`${label} has non-finite character offsets`);
      return;
    }
    if (entry.charStart < 0) errors.push(`${label}.charStart is negative`);
    if (entry.charEnd > sourceText.length) errors.push(`${label}.charEnd exceeds source text`);
    if (entry.charStart >= entry.charEnd)
      errors.push(`${label} has an empty or reversed source span`);
    if (entry.startMs < 0) errors.push(`${label}.startMs is negative`);
    if (entry.startMs > entry.endMs) errors.push(`${label} has reversed audio timing`);
    if (index > 0 && entry.charStart < previousCharEnd) {
      errors.push(`${label} overlaps the previous source span`);
    }
    if (index > 0 && entry.startMs < previousStartMs) {
      errors.push(`${label} is out of audio-time order`);
    }
    if (index > 0 && entry.startMs < previousEndMs) {
      errors.push(`${label} unexpectedly overlaps the previous audio span`);
    }

    const sourceSlice = sourceText.slice(entry.charStart, entry.charEnd);
    if (entry.text && comparable(sourceSlice) !== comparable(entry.text)) {
      warnings.push(`${label} text does not match its source slice`);
    }

    previousCharEnd = entry.charEnd;
    previousStartMs = entry.startMs;
    previousEndMs = entry.endMs;
  });

  return { valid: errors.length === 0, errors, warnings };
}

export function assertValidAlignment(sourceText: string, entries: readonly AlignmentEntry[]): void {
  const validation = validateAlignment(sourceText, entries);
  if (!validation.valid) {
    throw new Error(`Malformed alignment: ${validation.errors.join("; ")}`);
  }
}

export function findAlignmentAtTime(
  entries: readonly AlignmentEntry[],
  positionMs: number,
): AlignmentEntry | undefined {
  let low = 0;
  let high = entries.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = entries[middle];
    if (!entry) return undefined;
    if (positionMs < entry.startMs) {
      high = middle - 1;
    } else if (positionMs >= entry.endMs) {
      low = middle + 1;
    } else {
      return entry;
    }
  }

  return undefined;
}
