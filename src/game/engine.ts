import { Synth } from '../audio/synth';
import { buildChart, buildSong, type SongData } from './song';
import { classify, judgmentColor, judgmentWeight, MISS_WINDOW, rankFor } from './judge';
import { LANES, type ChartNote, type GameState, type JudgeCounts, type Judgment } from './types';

const BASE_WIDTH = 480;
const BASE_HEIGHT = 800;
const JUDGE_Y = 660;
const NOTE_TOP_Y = 30;
const APPROACH_SEC = 1.05;
const NOTE_RADIUS = 24;
const COUNTDOWN_SEC = 3;
const LANE_COLORS = ['#ff6fa5', '#4fc3f7', '#6ee7b7', '#c79bff'];
const KEY_LABELS = ['D', 'F', 'J', 'K'];
const KEY_TO_LANE: Record<string, number> = { d: 0, f: 1, j: 2, k: 3 };
const MAX_SCORE = 1_000_000;

interface Popup {
  text: string;
  color: string;
  lane: number;
  spawnAt: number; // engine "now" seconds
}

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private synth = new Synth();

  private song: SongData;
  private chart: ChartNote[];
  private judged: (Judgment | null)[];

  private state: GameState = 'title';
  private startTime = 0;
  private score = 0;
  private combo = 0;
  private maxCombo = 0;
  private counts: JudgeCounts = { perfect: 0, great: 0, good: 0, miss: 0 };
  private popups: Popup[] = [];
  private laneFlashUntil: number[] = [0, 0, 0, 0];

  private titleScreen = document.getElementById('title-screen') as HTMLElement;
  private resultScreen = document.getElementById('result-screen') as HTMLElement;
  private hud = document.getElementById('hud') as HTMLElement;
  private hudScore = document.getElementById('hud-score') as HTMLElement;
  private hudCombo = document.getElementById('hud-combo') as HTMLElement;
  private startButton = document.getElementById('start-button') as HTMLButtonElement;
  private retryButton = document.getElementById('retry-button') as HTMLButtonElement;

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.song = buildSong();
    this.chart = buildChart(this.song);
    this.judged = this.chart.map(() => null);

    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.startButton.addEventListener('click', () => this.startGame());
    this.retryButton.addEventListener('click', () => this.startGame());
    this.canvas.addEventListener('pointerdown', (e) => this.onPointer(e));
    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    requestAnimationFrame((t) => this.loop(t));
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const availW = window.innerWidth;
    const availH = window.innerHeight;
    const scale = Math.min(availW / BASE_WIDTH, availH / BASE_HEIGHT);
    const cssW = BASE_WIDTH * scale;
    const cssH = BASE_HEIGHT * scale;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = BASE_WIDTH * dpr;
    this.canvas.height = BASE_HEIGHT * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private async startGame(): Promise<void> {
    await this.synth.resume();

    this.song = buildSong();
    this.chart = buildChart(this.song);
    this.judged = this.chart.map(() => null);
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.popups = [];
    this.laneFlashUntil = [0, 0, 0, 0];

    this.titleScreen.classList.add('hidden');
    this.resultScreen.classList.add('hidden');
    this.hud.classList.remove('hidden');

    this.startTime = this.synth.currentTime + COUNTDOWN_SEC;
    this.synth.scheduleSong(this.song, this.startTime);
    this.state = 'countdown';
  }

  private endGame(): void {
    this.state = 'result';
    this.hud.classList.add('hidden');
    this.resultScreen.classList.remove('hidden');

    (document.getElementById('result-score') as HTMLElement).textContent = String(this.score);
    (document.getElementById('result-rank') as HTMLElement).textContent = rankFor(this.score / MAX_SCORE);
    (document.getElementById('result-combo') as HTMLElement).textContent = String(this.maxCombo);
    (document.getElementById('count-perfect') as HTMLElement).textContent = String(this.counts.perfect);
    (document.getElementById('count-great') as HTMLElement).textContent = String(this.counts.great);
    (document.getElementById('count-good') as HTMLElement).textContent = String(this.counts.good);
    (document.getElementById('count-miss') as HTMLElement).textContent = String(this.counts.miss);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const lane = KEY_TO_LANE[e.key.toLowerCase()];
    if (lane !== undefined) this.tryHit(lane);
  }

  private onPointer(e: PointerEvent): void {
    if (this.state !== 'playing') return;
    const rect = this.canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const lane = Math.min(LANES - 1, Math.max(0, Math.floor(relX * LANES)));
    this.tryHit(lane);
  }

  private tryHit(lane: number): void {
    if (this.state !== 'playing') return;
    const now = this.synth.currentTime - this.startTime;
    this.laneFlashUntil[lane] = now + 0.1;

    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < this.chart.length; i++) {
      const note = this.chart[i];
      if (note.lane !== lane || this.judged[i] !== null) continue;
      if (note.time - now > MISS_WINDOW) break; // chart is time-ordered; nothing closer ahead
      const diff = Math.abs(note.time - now);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    if (bestIdx === -1 || bestDiff > MISS_WINDOW) return;
    this.applyJudgment(bestIdx, classify(bestDiff), now);
  }

  private applyJudgment(idx: number, judgment: Judgment, now: number): void {
    this.judged[idx] = judgment;
    this.counts[judgment]++;

    if (judgment === 'miss') {
      this.combo = 0;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    }
    this.score += Math.round((MAX_SCORE / this.chart.length) * judgmentWeight(judgment));

    this.popups.push({
      text: judgment.toUpperCase(),
      color: judgmentColor(judgment),
      lane: this.chart[idx].lane,
      spawnAt: now,
    });
  }

  private loop(_t: number): void {
    requestAnimationFrame((nt) => this.loop(nt));
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

    if (this.state === 'countdown' || this.state === 'playing') {
      const now = this.synth.currentTime - this.startTime;

      if (this.state === 'countdown' && now >= 0) {
        this.state = 'playing';
      }
      if (this.state === 'playing' && now > this.song.totalDuration + 1.2) {
        this.endGame();
        return;
      }

      this.drawLanes(now);
      this.drawNotes(now);
      this.drawPopups(now);

      if (this.state === 'countdown') {
        this.drawCountdown(now);
      } else {
        this.checkAutoMiss(now);
        this.hudScore.textContent = String(this.score);
        this.hudCombo.textContent = this.combo >= 2 ? `${this.combo} COMBO` : '';
      }
    }
  }

  private checkAutoMiss(now: number): void {
    for (let i = 0; i < this.chart.length; i++) {
      if (this.judged[i] !== null) continue;
      if (this.chart[i].time + MISS_WINDOW < now) {
        this.applyJudgment(i, 'miss', now);
      }
    }
  }

  private laneX(lane: number): number {
    const laneWidth = BASE_WIDTH / LANES;
    return lane * laneWidth + laneWidth / 2;
  }

  private drawLanes(now: number): void {
    const ctx = this.ctx;
    const laneWidth = BASE_WIDTH / LANES;

    for (let lane = 0; lane < LANES; lane++) {
      const x = lane * laneWidth;
      ctx.fillStyle = lane % 2 === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)';
      ctx.fillRect(x, 0, laneWidth, BASE_HEIGHT);

      if (now < this.laneFlashUntil[lane]) {
        ctx.fillStyle = `${LANE_COLORS[lane]}33`;
        ctx.fillRect(x, 0, laneWidth, BASE_HEIGHT);
      }
    }

    ctx.strokeStyle = 'rgba(122, 108, 138, 0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, JUDGE_Y);
    ctx.lineTo(BASE_WIDTH, JUDGE_Y);
    ctx.stroke();

    for (let lane = 0; lane < LANES; lane++) {
      const x = this.laneX(lane);
      const active = now < this.laneFlashUntil[lane];
      ctx.beginPath();
      ctx.arc(x, JUDGE_Y + 46, 22, 0, Math.PI * 2);
      ctx.fillStyle = active ? LANE_COLORS[lane] : `${LANE_COLORS[lane]}55`;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(KEY_LABELS[lane], x, JUDGE_Y + 46);
    }
  }

  private drawNotes(now: number): void {
    const ctx = this.ctx;
    for (let i = 0; i < this.chart.length; i++) {
      if (this.judged[i] !== null) continue;
      const note = this.chart[i];
      const progress = (now - (note.time - APPROACH_SEC)) / APPROACH_SEC;
      if (progress < -0.05 || progress > 1.05) continue;
      const y = NOTE_TOP_Y + (JUDGE_Y - NOTE_TOP_Y) * Math.min(1, Math.max(0, progress));
      const x = this.laneX(note.lane);

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      const size = NOTE_RADIUS;
      ctx.fillStyle = LANE_COLORS[note.lane];
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(-size / 2, -size / 2, size, size, 6);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawPopups(now: number): void {
    const ctx = this.ctx;
    const DURATION = 0.5;
    this.popups = this.popups.filter((p) => now - p.spawnAt < DURATION);
    for (const p of this.popups) {
      const age = now - p.spawnAt;
      const t = age / DURATION;
      const x = this.laneX(p.lane);
      const y = JUDGE_Y - 60 - t * 30;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = p.color;
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, x, y);
      ctx.globalAlpha = 1;
    }
  }

  private drawCountdown(now: number): void {
    const ctx = this.ctx;
    const remaining = Math.ceil(-now);
    if (remaining <= 0) return;
    ctx.fillStyle = 'rgba(58, 47, 69, 0.85)';
    ctx.font = 'bold 96px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(remaining), BASE_WIDTH / 2, BASE_HEIGHT / 2);
  }
}
