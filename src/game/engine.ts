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
const LANE_FLASH_DURATION = 0.28;
const GRAVITY = 260; // px/s^2, particle fall acceleration

interface Popup {
  text: string;
  color: string;
  x: number;
  y: number;
  spawnAt: number;
  life: number;
  fontSize: number;
  glow?: boolean;
}

interface Particle {
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  shape: 'diamond' | 'star';
  spawnAt: number;
  life: number;
  rotation: number;
  rotSpeed: number;
}

interface Ring {
  x: number;
  y: number;
  color: string;
  spawnAt: number;
  life: number;
  maxRadius: number;
}

interface Flash {
  spawnAt: number;
  life: number;
  color: string;
  peak: number;
}

interface Shake {
  spawnAt: number;
  life: number;
  magnitude: number;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
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
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private flashes: Flash[] = [];
  private shake: Shake | null = null;
  private laneFlashAt: number[] = [-999, -999, -999, -999];

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
    this.particles = [];
    this.rings = [];
    this.flashes = [];
    this.shake = null;
    this.laneFlashAt = [-999, -999, -999, -999];

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
    this.laneFlashAt[lane] = now;

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
    this.applyJudgment(bestIdx, classify(bestDiff), now, true);
  }

  private applyJudgment(idx: number, judgment: Judgment, now: number, fromPress: boolean): void {
    this.judged[idx] = judgment;
    this.counts[judgment]++;
    const lane = this.chart[idx].lane;

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
      x: this.laneX(lane),
      y: JUDGE_Y - 70,
      spawnAt: now,
      life: 0.55,
      fontSize: judgment === 'perfect' ? 30 : 24,
      glow: judgment === 'perfect',
    });

    if (fromPress) {
      this.spawnHitEffect(lane, judgment, now);
      if (judgment !== 'miss' && this.combo > 0 && this.combo % 10 === 0) {
        this.spawnComboMilestone(now);
      }
    }
  }

  private spawnHitEffect(lane: number, judgment: Judgment, now: number): void {
    const x = this.laneX(lane);
    const color = LANE_COLORS[lane];

    if (judgment === 'miss') {
      this.rings.push({ x, y: JUDGE_Y, color: '#ff6f8f', spawnAt: now, life: 0.3, maxRadius: 34 });
      this.shake = { spawnAt: now, life: 0.12, magnitude: 3 };
      return;
    }

    const tier = judgment === 'perfect' ? 1.3 : judgment === 'great' ? 1.05 : 0.85;
    const count = Math.round((judgment === 'perfect' ? 24 : judgment === 'great' ? 15 : 9) * (0.8 + Math.random() * 0.4));

    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
      const speed = (130 + Math.random() * 220) * tier;
      this.particles.push({
        x0: x,
        y0: JUDGE_Y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: Math.random() < 0.35 ? '#ffffff' : color,
        size: 4 + Math.random() * 6 * tier,
        shape: judgment === 'perfect' && Math.random() < 0.45 ? 'star' : 'diamond',
        spawnAt: now,
        life: 0.45 + Math.random() * 0.35,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 12,
      });
    }

    this.rings.push({ x, y: JUDGE_Y, color, spawnAt: now, life: 0.4, maxRadius: 40 * tier });
    if (judgment === 'perfect') {
      this.rings.push({ x, y: JUDGE_Y, color: '#ffffff', spawnAt: now, life: 0.3, maxRadius: 26 });
      this.flashes.push({ spawnAt: now, life: 0.18, color: '#ffffff', peak: 0.22 });
    }
  }

  private spawnComboMilestone(now: number): void {
    this.popups.push({
      text: `${this.combo} COMBO!`,
      color: '#ffd166',
      x: BASE_WIDTH / 2,
      y: BASE_HEIGHT / 2 - 40,
      spawnAt: now,
      life: 0.7,
      fontSize: 40,
      glow: true,
    });
    this.shake = { spawnAt: now, life: 0.3, magnitude: 10 };
    this.flashes.push({ spawnAt: now, life: 0.25, color: '#ffd166', peak: 0.18 });
  }

  private loop(_t: number): void {
    requestAnimationFrame((nt) => this.loop(nt));
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

    if (this.state === 'countdown' || this.state === 'playing') {
      const now = this.synth.currentTime - this.startTime;

      if (this.state === 'countdown' && now >= 0) {
        this.state = 'playing';
      }
      if (this.state === 'playing' && now > this.song.totalDuration + 1.2) {
        this.endGame();
        ctx.restore();
        return;
      }

      this.applyShake(now);
      this.drawLanes(now);
      this.drawNotes(now);
      this.drawRings(now);
      this.drawParticles(now);
      this.drawPopups(now);
      this.drawFlashes(now);

      if (this.state === 'countdown') {
        this.drawCountdown(now);
      } else {
        this.checkAutoMiss(now);
        this.hudScore.textContent = String(this.score);
        this.hudCombo.textContent = this.combo >= 2 ? `${this.combo} COMBO` : '';
      }
    }
    ctx.restore();
  }

  private applyShake(now: number): void {
    if (!this.shake) return;
    const t = now - this.shake.spawnAt;
    if (t > this.shake.life) {
      this.shake = null;
      return;
    }
    const frac = 1 - t / this.shake.life;
    const dx = (Math.random() - 0.5) * this.shake.magnitude * frac;
    const dy = (Math.random() - 0.5) * this.shake.magnitude * frac;
    this.ctx.translate(dx, dy);
  }

  private checkAutoMiss(now: number): void {
    for (let i = 0; i < this.chart.length; i++) {
      if (this.judged[i] !== null) continue;
      if (this.chart[i].time + MISS_WINDOW < now) {
        this.applyJudgment(i, 'miss', now, false);
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

      const flashAge = now - this.laneFlashAt[lane];
      if (flashAge >= 0 && flashAge < LANE_FLASH_DURATION) {
        const alpha = 1 - flashAge / LANE_FLASH_DURATION;
        const grad = ctx.createLinearGradient(0, JUDGE_Y, 0, 0);
        grad.addColorStop(0, `${LANE_COLORS[lane]}${Math.round(alpha * 0x99).toString(16).padStart(2, '0')}`);
        grad.addColorStop(1, `${LANE_COLORS[lane]}00`);
        ctx.fillStyle = grad;
        ctx.fillRect(x, 0, laneWidth, JUDGE_Y);
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
      const flashAge = now - this.laneFlashAt[lane];
      const active = flashAge >= 0 && flashAge < LANE_FLASH_DURATION;
      const pulse = active ? 1 - flashAge / LANE_FLASH_DURATION : 0;
      const radius = 22 + pulse * 8;

      if (active) {
        ctx.save();
        ctx.shadowColor = LANE_COLORS[lane];
        ctx.shadowBlur = 18 * pulse;
        ctx.beginPath();
        ctx.arc(x, JUDGE_Y + 46, radius, 0, Math.PI * 2);
        ctx.fillStyle = LANE_COLORS[lane];
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(x, JUDGE_Y + 46, radius, 0, Math.PI * 2);
        ctx.fillStyle = `${LANE_COLORS[lane]}55`;
        ctx.fill();
      }

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

  private drawRings(now: number): void {
    const ctx = this.ctx;
    this.rings = this.rings.filter((r) => now - r.spawnAt < r.life);
    for (const r of this.rings) {
      const t = (now - r.spawnAt) / r.life;
      const radius = r.maxRadius * easeOutCubic(t);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, radius, radius * 0.45, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawParticles(now: number): void {
    const ctx = this.ctx;
    this.particles = this.particles.filter((p) => now - p.spawnAt < p.life);
    for (const p of this.particles) {
      const t = now - p.spawnAt;
      const alpha = 1 - t / p.life;
      const x = p.x0 + p.vx * t;
      const y = p.y0 + p.vy * t + 0.5 * GRAVITY * t * t;
      const size = p.size * (0.5 + alpha * 0.5);
      const rot = p.rotation + p.rotSpeed * t;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = p.color;

      if (p.shape === 'star') {
        this.drawStar(size);
      } else {
        ctx.beginPath();
        ctx.roundRect(-size / 2, -size / 2, size, size, 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawStar(size: number): void {
    const ctx = this.ctx;
    const spikes = 4;
    const outer = size;
    const inner = size * 0.4;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (Math.PI / spikes) * i;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  }

  private drawPopups(now: number): void {
    const ctx = this.ctx;
    this.popups = this.popups.filter((p) => now - p.spawnAt < p.life);
    for (const p of this.popups) {
      const age = now - p.spawnAt;
      const t = age / p.life;

      // punch-in bounce for the first 25% of life, then hold, then fade in the last 55%
      let scale: number;
      if (t < 0.25) {
        const bt = t / 0.25;
        scale = 0.4 + Math.sin(bt * Math.PI * 0.5) * 0.9;
      } else {
        scale = 1;
      }
      const alpha = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;
      const y = p.y - t * 34;

      ctx.save();
      ctx.translate(p.x, y);
      ctx.scale(scale, scale);
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.font = `900 ${p.fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (p.glow) {
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 20;
      }
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(58, 47, 69, 0.55)';
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
  }

  private drawFlashes(now: number): void {
    const ctx = this.ctx;
    this.flashes = this.flashes.filter((f) => now - f.spawnAt < f.life);
    for (const f of this.flashes) {
      const t = (now - f.spawnAt) / f.life;
      const alpha = f.peak * (1 - t);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = f.color;
      ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);
      ctx.restore();
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
