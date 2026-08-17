export const LANES = 4;

export interface ChartNote {
  time: number; // seconds from song start
  lane: number; // 0..LANES-1
}

export type Judgment = 'perfect' | 'great' | 'good' | 'miss';

export type GameState = 'title' | 'countdown' | 'playing' | 'result';

export interface JudgeCounts {
  perfect: number;
  great: number;
  good: number;
  miss: number;
}
