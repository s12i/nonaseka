import type { SongData } from '../game/song';

/** A tiny Web Audio synthesizer -- generates every sound at runtime, no audio files. */
export class Synth {
  private ctx: AudioContext;
  private master: GainNode;
  private noiseBufferCache: AudioBuffer | null = null;

  constructor() {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  }

  get currentTime(): number {
    return this.ctx.currentTime;
  }

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  private getNoiseBuffer(): AudioBuffer {
    if (this.noiseBufferCache) return this.noiseBufferCache;
    const length = this.ctx.sampleRate * 0.3;
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBufferCache = buffer;
    return buffer;
  }

  private playTone(freq: number, startTime: number, dur: number, type: OscillatorType, peakGain: number, attack = 0.006, release = 0.08): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = this.ctx.createGain();
    const releaseStart = Math.max(startTime + attack, startTime + dur - release);
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    gain.gain.setValueAtTime(peakGain, releaseStart);
    gain.gain.linearRampToValueAtTime(0, startTime + dur);
    osc.connect(gain).connect(this.master);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.02);
  }

  private playHat(startTime: number, accent: boolean): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    const gain = this.ctx.createGain();
    const peak = accent ? 0.16 : 0.08;
    gain.gain.setValueAtTime(peak, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.045);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(startTime);
    src.stop(startTime + 0.06);
  }

  private playKick(startTime: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    const gain = this.ctx.createGain();
    osc.frequency.setValueAtTime(130, startTime);
    osc.frequency.exponentialRampToValueAtTime(45, startTime + 0.13);
    gain.gain.setValueAtTime(0.55, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.16);
    osc.connect(gain).connect(this.master);
    osc.start(startTime);
    osc.stop(startTime + 0.18);
  }

  /** Schedules an entire pre-composed song at once, anchored at `startTime` (an AudioContext time). */
  scheduleSong(song: SongData, startTime: number): void {
    for (const n of song.melody) this.playTone(n.freq, startTime + n.time, n.dur, 'square', 0.16);
    for (const b of song.bass) this.playTone(b.freq, startTime + b.time, b.dur, 'triangle', 0.22, 0.01, 0.2);
    for (const h of song.hats) this.playHat(startTime + h.time, h.accent);
    for (const k of song.kicks) this.playKick(startTime + k.time);
  }
}
