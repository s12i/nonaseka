import type { Judgment } from './types';

export const PERFECT_WINDOW = 0.05;
export const GREAT_WINDOW = 0.09;
export const GOOD_WINDOW = 0.15;
/** Outer bound: a press within this many seconds of a note still consumes it (as a Miss). Beyond this, presses are ignored. */
export const MISS_WINDOW = 0.22;

export function classify(absDiff: number): Judgment {
  if (absDiff <= PERFECT_WINDOW) return 'perfect';
  if (absDiff <= GREAT_WINDOW) return 'great';
  if (absDiff <= GOOD_WINDOW) return 'good';
  return 'miss';
}

export function judgmentWeight(j: Judgment): number {
  switch (j) {
    case 'perfect':
      return 1;
    case 'great':
      return 0.7;
    case 'good':
      return 0.4;
    case 'miss':
      return 0;
  }
}

export function judgmentColor(j: Judgment): string {
  switch (j) {
    case 'perfect':
      return '#ffb347';
    case 'great':
      return '#4fc3f7';
    case 'good':
      return '#6ee7b7';
    case 'miss':
      return '#ff6f8f';
  }
}

export function rankFor(scoreRatio: number): string {
  if (scoreRatio >= 0.97) return 'S';
  if (scoreRatio >= 0.9) return 'A';
  if (scoreRatio >= 0.75) return 'B';
  if (scoreRatio >= 0.5) return 'C';
  return 'D';
}
