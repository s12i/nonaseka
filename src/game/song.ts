import type { ChartNote } from './types';

// "ノナセカ" original theme -- fully synthesized, no sample assets.
// Composed as a diatonic chord-tone arpeggio over a classic J-pop progression
// (F - G - Em - Am), so it stays musical without hand-authoring every pitch.

export const BPM = 128;
export const BEAT_SEC = 60 / BPM;
const EIGHTH = BEAT_SEC / 2;
const C4 = 261.6255653005986;
const SCALE_STEPS = [0, 2, 4, 5, 7, 9, 11]; // major scale semitone offsets

/** Diatonic scale degree (any integer, octave-wrapping) -> frequency in Hz. */
function degreeToFreq(degree: number): number {
  const octave = Math.floor(degree / 7);
  const idx = ((degree % 7) + 7) % 7;
  const semitone = octave * 12 + SCALE_STEPS[idx];
  return C4 * Math.pow(2, semitone / 12);
}

interface Chord {
  /** [root, third, fifth, octave] as diatonic scale degrees from C4 */
  degrees: [number, number, number, number];
}

// F, G, Em, Am -- degrees are relative to C4 = degree 0
const PROGRESSION: Chord[] = [
  { degrees: [3, 5, 7, 10] }, // F
  { degrees: [4, 6, 8, 11] }, // G
  { degrees: [2, 4, 6, 9] }, // Em
  { degrees: [5, 7, 9, 12] }, // Am
];

const CHORD_BEATS = 8; // 2 bars of 4/4 per chord
// Arpeggio order into a chord's [root, third, fifth, octave]; also doubles as the note's lane.
const ARPEGGIO_LANES = [0, 2, 1, 3];

export interface ToneEvent {
  time: number;
  freq: number;
  dur: number;
}

export interface PercEvent {
  time: number;
  accent: boolean;
}

export interface SongData {
  melody: (ToneEvent & { lane: number })[];
  bass: ToneEvent[];
  hats: PercEvent[];
  kicks: { time: number }[];
  totalDuration: number;
}

/** Builds the full synthesized backing track plus the note-chart-aligned lead line. */
export function buildSong(loops = 2): SongData {
  const melody: (ToneEvent & { lane: number })[] = [];
  const bass: ToneEvent[] = [];
  const hats: PercEvent[] = [];
  const kicks: { time: number }[] = [];

  let t = 0;
  for (let loop = 0; loop < loops; loop++) {
    for (const chord of PROGRESSION) {
      for (let beat = 0; beat < CHORD_BEATS; beat++) {
        const beatTime = t + beat * BEAT_SEC;
        if (beat % 2 === 0) {
          bass.push({ time: beatTime, freq: degreeToFreq(chord.degrees[0] - 7), dur: BEAT_SEC * 1.8 });
        }
        if (beat === 0 || beat === 4) {
          kicks.push({ time: beatTime });
        }
        hats.push({ time: beatTime, accent: beat % 2 === 0 });
        hats.push({ time: beatTime + EIGHTH, accent: false });
      }

      const eighthsInChord = CHORD_BEATS * 2;
      for (let e = 0; e < eighthsInChord; e++) {
        const lane = ARPEGGIO_LANES[e % ARPEGGIO_LANES.length];
        const degree = chord.degrees[lane];
        melody.push({
          time: t + e * EIGHTH,
          freq: degreeToFreq(degree),
          dur: EIGHTH * 0.9,
          lane,
        });
      }

      t += CHORD_BEATS * BEAT_SEC;
    }
  }

  return { melody, bass, hats, kicks, totalDuration: t };
}

/** Derives the tappable note chart directly from the lead melody so audio and visuals always agree. */
export function buildChart(song: SongData): ChartNote[] {
  return song.melody.map((n) => ({ time: n.time, lane: n.lane }));
}
