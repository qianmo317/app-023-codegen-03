// 时值按比例伸缩 —— 同一段锣鼓经「放慢一倍练 / 缩紧一半上台」。
// 做法：把全曲拍平成「段」（每个 step 一段，起音位置 = 段起点），段起点按比例换算后取整
// （四舍五入到最近格，并保持单调、每段至少 1 格），再按合法时值 {1,2,3,4,6} 重新切分。
// 切分优先对齐拍界，避免同一拍里出现生硬的跨拍碎片；拟音字 / 技法 / 力度随段原样保留；
// 小节不变式（每小节正好铺满）由重建过程保证，内容放不下时自动补小节而不是丢弃。
import { TICKS_PER_BEAT, type Bar, type Hit, type Score, type Step } from '../types';
import { barTicks } from './grid';
import { TECH_NAMES } from './glyphs';

/** 合法时值格（与 grid.DURATIONS 一致：¼拍 1 / 半拍 2 / 附点半 3 / 整拍 4 / 附点 6） */
export const LEGAL_TICKS: readonly number[] = [1, 2, 3, 4, 6];

/** 一次起音位置的改动记录（报告用，只记有击的段） */
export interface StretchChange {
  bar: number; // 新小节序号（0 起）
  tick: number; // 新小节内格偏移
  fromBar: number; // 原小节序号（0 起）
  fromTick: number; // 原小节内格偏移
  fromAbs: number; // 原绝对格
  ideal: number; // 按比例换算的精确位置（可能除不尽）
  toAbs: number; // 量化后的新绝对格
  text: string; // 拟音字+技法汇总，如 "哐+才(滚奏)"
  quantized: boolean; // 是否因除不尽做了取整
}

export interface StretchReport {
  ratio: number;
  beforeBars: number;
  afterBars: number;
  beforeTicks: number;
  afterTicks: number;
  changes: StretchChange[];
}

export type StretchOutcome =
  | { ok: true; score: Score; report: StretchReport }
  | { ok: false; error: string };

type SegKind = 'hit' | 'rest' | 'empty';
interface Seg {
  start: number; // 原绝对格
  end: number;
  kind: SegKind;
  hits: Hit[];
  tie: boolean; // 原 step 的连线（时值向后延伸）
}

/** 全曲拍平：每个 step 一段，起音位置 = 段起点（跨小节连续计格） */
function collectSegments(score: Score): Seg[] {
  const segs: Seg[] = [];
  let abs = 0;
  for (const bar of score.bars) {
    for (const st of bar.steps) {
      const kind: SegKind = st.hits.length > 0 ? 'hit' : st.rest ? 'rest' : 'empty';
      segs.push({ start: abs, end: abs + st.beats, kind, hits: st.hits, tie: !!st.tie });
      abs += st.beats;
    }
  }
  return segs;
}

/**
 * 把长度 len（起点在小节内 offset 处）切成合法时值序列。
 * 规则：整段恰好合法且不明显跨拍（附点 6 须拍首起）→ 不分；
 * 否则先补齐到下一拍界，再继续 —— 同一拍内的分割不生硬。
 */
export function decomposeTicks(offset: number, len: number): number[] {
  const out: number[] = [];
  let pos = offset;
  let rem = len;
  while (rem > 0) {
    const toBeat = TICKS_PER_BEAT - (pos % TICKS_PER_BEAT);
    const aligned = pos % TICKS_PER_BEAT === 0;
    let d: number;
    if (LEGAL_TICKS.includes(rem) && (rem <= toBeat || (rem === 6 && aligned))) d = rem;
    else d = Math.min(toBeat, rem);
    out.push(d);
    pos += d;
    rem -= d;
  }
  return out;
}

/** 解析比例输入：支持 "2"、"0.5"、"1/2"、"3/2" 等写法；非法返回 null */
export function parseRatio(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const frac = t.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  const v = frac ? Number(frac[1]) / Number(frac[2]) : Number(t);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
}

const MAX_BARS = 512;

/**
 * 按比例伸缩整首谱面。返回新 Score（不改原对象）与逐小节改动报告。
 * 起音位置 = 段起点 × 比例，四舍五入到最近格；除不尽时用相邻合法时值拼出最接近的写法。
 */
export function stretchScore(score: Score, ratio: number): StretchOutcome {
  if (!Number.isFinite(ratio) || ratio <= 0) return { ok: false, error: '比例必须是正数' };
  if (score.bars.length === 0) return { ok: false, error: '谱面为空' };
  const bpb = score.bars[0].beatsPerBar;
  const bt = barTicks(bpb);
  const segs = collectSegments(score);
  const beforeTicks = segs.length ? segs[segs.length - 1].end : 0;
  if (beforeTicks === 0) return { ok: false, error: '谱面为空' };

  // 目标小节数：按总格数换算后取整；内容放不下时自动补小节（一个击都不丢）
  let afterBars = Math.max(1, Math.round((beforeTicks * ratio) / bt));

  // 边界量化：等比换算 → 最近整数格 → 单调（每段至少 1 格）
  const q: number[] = [0];
  for (let i = 1; i < segs.length; i++) {
    q.push(Math.max(Math.round(segs[i].start * ratio), q[i - 1] + 1));
  }
  while (q.length > 1 && q[q.length - 1] >= afterBars * bt) afterBars += 1;
  if (afterBars > MAX_BARS) return { ok: false, error: `伸缩后超过 ${MAX_BARS} 小节，比例太大` };
  const afterTicks = afterBars * bt;
  q.push(afterTicks); // 末尾边界：末段吸收「取整到整小节」的零头

  // 重建：逐段按新位置落格，跨小节/非合法时值先切开再分解
  const bars: Bar[] = Array.from({ length: afterBars }, (_, i) => ({
    index: i,
    beatsPerBar: bpb,
    steps: [] as Step[],
  }));
  const changes: StretchChange[] = [];
  segs.forEach((seg, i) => {
    const segEnd = q[i + 1];
    let pos = q[i];
    let firstPiece = true;
    while (pos < segEnd) {
      const barIdx = Math.floor(pos / bt);
      const off = pos % bt;
      const room = Math.min(segEnd, (barIdx + 1) * bt) - pos; // 本小节内可容纳的长度
      for (const d of decomposeTicks(off, room)) {
        const isLast = pos + d >= segEnd;
        const step: Step = { beats: d, hits: [] };
        if (seg.kind === 'hit') {
          if (firstPiece) step.hits = seg.hits; // 拟音字/技法/力度只在首片，后续片为空步（时值延续）
          if (!isLast || seg.tie) step.tie = true; // 被切开或原本就连线 → 时值线向后延伸
        } else if (seg.kind === 'rest') {
          step.rest = true;
        }
        bars[barIdx].steps.push(step);
        pos += d;
        firstPiece = false;
      }
    }
    if (seg.kind === 'hit') {
      const toAbs = q[i];
      const ideal = seg.start * ratio;
      changes.push({
        bar: Math.floor(toAbs / bt),
        tick: toAbs % bt,
        fromBar: Math.floor(seg.start / bt),
        fromTick: seg.start % bt,
        fromAbs: seg.start,
        ideal,
        toAbs,
        text: seg.hits
          .map((h) => `${h.glyph ?? '?'}${(h.tech ?? []).map((t) => TECH_NAMES[t]).join('')}`)
          .join('+'),
        quantized: ideal !== toAbs,
      });
    }
  });

  const report: StretchReport = {
    ratio,
    beforeBars: score.bars.length,
    afterBars,
    beforeTicks,
    afterTicks,
    changes,
  };
  return { ok: true, score: { ...score, bars, updatedAt: Date.now() }, report };
}
