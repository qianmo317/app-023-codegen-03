// 时值伸缩 —— 按比例换算整段锣鼓经的起音位置，再量化回整数格时值。
// 设计要点：
// - 全曲统一缩放：拍号不变，小节数随比例增减，每小节仍恰好铺满（不变式不破）。
// - 除不尽时用动态规划选整数边界：各段量化时值与理想时值的总误差最小；
//   段内再按合法时值（1/2/3/4/6 格）切片，切口优先落在拍界上 —— 同一拍里的分割不生硬。
// - 拟音字、技法、力度、连线全部保留；比例过小实在放不下时并入同格（齐奏），不丢字。
import { TICKS_PER_BEAT, type Bar, type Hit, type Score, type Step } from '../types';
import { barTicks } from './grid';

/** 合法时值（格）：¼拍1 / 半拍2 / 附点半拍3 / 整拍4 / 附点6 */
const LEGAL = [1, 2, 3, 4, 6];

/** 常用伸缩比例预设（缩紧上台 / 放慢练） */
export const RATIO_PRESETS: { label: string; num: number; den: number }[] = [
  { label: '×½ 缩紧一半', num: 1, den: 2 },
  { label: '×⅔', num: 2, den: 3 },
  { label: '×¾', num: 3, den: 4 },
  { label: '×4/3', num: 4, den: 3 },
  { label: '×3/2', num: 3, den: 2 },
  { label: '×2 放慢一倍', num: 2, den: 1 },
];

/** 一个原 step 伸缩后的去向（逐小节 diff 用） */
export interface SegMapping {
  fromBar: number; // 原小节（0 起）
  fromOffset: number; // 原小节内起始格
  fromBeats: number; // 原时值（格）
  idealBeats: number; // 按比例的理想时值（浮点，可能除不尽）
  toStart: number; // 量化后全曲绝对起始格
  toBeats: number; // 量化后时值（整数格；0 = 并入同格）
  slices: number[]; // 段内合法时值切分（和 = toBeats）
  merged: boolean; // 是否并入相邻同格（比例过小时）
  hits: Hit[];
  rest: boolean;
  placements: { bar: number; offset: number; beats: number }[]; // 装填去向（跨小节会多片）
}

export interface StretchOk {
  ok: true;
  score: Score;
  mappings: SegMapping[];
  changedBars: number[]; // 发生量化/切分/合并/跨小节的新小节号（0 起）
  newTotal: number; // 伸缩后总格数
}

export interface StretchErr {
  ok: false;
  error: string;
}

export type StretchResult = StretchOk | StretchErr;

interface SlicePlan {
  cost: number;
  cuts: number[];
}

const sliceMemo = new Map<string, SlicePlan>();

function slicePlan(len: number, phase: number): SlicePlan {
  if (len <= 0) return { cost: 0, cuts: [] };
  if (LEGAL.includes(len)) return { cost: 0, cuts: [len] };
  const key = `${len}:${phase}`;
  const hit = sliceMemo.get(key);
  if (hit) return hit;
  let best: SlicePlan = { cost: Number.POSITIVE_INFINITY, cuts: [len] };
  for (const k of LEGAL) {
    if (k >= len) continue;
    const sub = slicePlan(len - k, (phase + k) % TICKS_PER_BEAT);
    // 切口惩罚：落在拍界上便宜（自然），拍内切口贵；每多一片再加点
    const cut = ((phase + k) % TICKS_PER_BEAT === 0 ? 0.05 : 0.3) + 0.1;
    const cand = sub.cost + cut;
    if (cand < best.cost - 1e-12) best = { cost: cand, cuts: [k, ...sub.cuts] };
  }
  sliceMemo.set(key, best);
  return best;
}

/** 段内切片：把 len 格（从拍内相位 phase 起）切成合法时值序列，切口优先对齐拍界 */
export function sliceSegment(len: number, phase = 0): number[] {
  const p = ((phase % TICKS_PER_BEAT) + TICKS_PER_BEAT) % TICKS_PER_BEAT;
  return slicePlan(len, p).cuts;
}

/** 段切片代价（主 DP 用）：合法时值 0，否则为切口惩罚之和 */
function sliceCost(len: number, phase: number): number {
  return slicePlan(len, phase).cost;
}

/** 合并两组 hits：同乐器只留先者（同格齐奏不丢字，但同乐器同格只能留一个打法） */
function mergeHits(a: Hit[], b: Hit[]): Hit[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const seen = new Set(a.map((h) => h.instrumentId));
  return [...a, ...b.filter((h) => !seen.has(h.instrumentId))];
}

/**
 * 按比例伸缩整谱：每击起音位置 × num/den，再量化回整数格。
 * 返回新谱与逐段映射（diff 用）；无法伸缩时返回错误文案。
 */
export function stretchScore(score: Score, num: number, den: number): StretchResult {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
    return { ok: false, error: '比例必须是正整数之比（如 3/2）' };
  }
  const ratio = num / den;
  if (ratio < 1 / 4 || ratio > 4) return { ok: false, error: '比例需在 1/4 ~ 4 倍之间' };
  if (score.bars.length === 0) return { ok: false, error: '空谱无需伸缩' };
  const beatsPerBar = score.bars[0].beatsPerBar;
  const barT = barTicks(beatsPerBar);

  // 1) 展开为全曲段序列（每段 = 一个原 step）
  interface Seg {
    hits: Hit[];
    rest: boolean;
    tie: boolean;
    beats: number;
    absStart: number;
    fromBar: number;
    fromOffset: number;
  }
  const segs: Seg[] = [];
  let abs = 0;
  for (const bar of score.bars) {
    let off = 0;
    for (const st of bar.steps) {
      segs.push({
        hits: st.hits,
        rest: !!st.rest,
        tie: !!st.tie,
        beats: st.beats,
        absStart: abs + off,
        fromBar: bar.index,
        fromOffset: off,
      });
      off += st.beats;
    }
    abs += barTicks(bar.beatsPerBar);
  }
  const n = segs.length;
  const newTotal = Math.max(1, Math.round((abs * num) / den));
  if (n * (newTotal + 1) > 2_000_000) return { ok: false, error: '谱面过大，请分段伸缩' };

  // 2) DP 选整数边界：min Σ |起音位置−理想位置| + 切片代价；Lᵢ=0 表示该段并入下一段同格
  const MERGE_PENALTY = 2; // 并入同格的额外惩罚：只在实在放不下时才划算
  const dp: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(newTotal + 1).fill(Infinity));
  const parent: Int16Array[] = Array.from({ length: n + 1 }, () => new Int16Array(newTotal + 1).fill(-1));
  dp[0][0] = 0;
  for (let i = 0; i < n; i++) {
    const w = (segs[i].beats * num) / den;
    const idealStart = (segs[i].absStart * num) / den;
    const lo = Math.max(1, Math.floor(w) - 1);
    const hi = Math.min(newTotal, Math.ceil(w) + 1);
    const row = dp[i];
    const nxt = dp[i + 1];
    const prow = parent[i + 1];
    for (let b = 0; b <= newTotal; b++) {
      const base = row[b];
      if (base === Infinity) continue;
      const posErr = Math.abs(b - idealStart); // 起音位置尽量贴近按比例换算的理想位置
      const c0 = base + posErr + MERGE_PENALTY;
      if (c0 < nxt[b]) {
        nxt[b] = c0;
        prow[b] = 0;
      }
      for (let L = lo; L <= hi && b + L <= newTotal; L++) {
        const c = base + posErr + sliceCost(L, b % TICKS_PER_BEAT);
        if (c < nxt[b + L]) {
          nxt[b + L] = c;
          prow[b + L] = L;
        }
      }
    }
  }
  if (dp[n][newTotal] === Infinity) return { ok: false, error: '该比例下无法铺满小节，请换相邻比例' };

  // 3) 回溯每段量化时值与起始格
  const lens = new Array<number>(n);
  const starts = new Array<number>(n);
  let b = newTotal;
  for (let i = n; i >= 1; i--) {
    const L = parent[i][b];
    lens[i - 1] = L;
    b -= L;
    starts[i - 1] = b;
  }

  // 4) 生成新 step 流：段内切片，首片继承 hits/rest，余片空步（有 hits 则前片 tie 连打）
  const out: (Step & { seg: number })[] = [];
  let pending: Hit[] = []; // L=0 段待并入的 hits
  for (let i = 0; i < n; i++) {
    const L = lens[i];
    if (L === 0) {
      pending = mergeHits(pending, segs[i].hits);
      continue;
    }
    const hits = mergeHits(pending, segs[i].hits);
    pending = [];
    const slices = sliceSegment(L, starts[i] % TICKS_PER_BEAT);
    slices.forEach((k, j) => {
      out.push({
        beats: k,
        hits: j === 0 ? hits : [],
        ...(segs[i].rest ? { rest: true } : {}),
        ...(j < slices.length - 1 ? (hits.length ? { tie: true } : {}) : segs[i].tie ? { tie: true } : {}),
        seg: i,
      });
    });
  }
  if (pending.length && out.length) out[out.length - 1].hits = mergeHits(out[out.length - 1].hits, pending);

  // 5) 装填小节：跨小节切分（前片 tie、后片空步），末尾补休止铺满 —— 与 factory 同一套路
  const bars: Bar[] = [{ index: 0, beatsPerBar, steps: [] }];
  const placements: { bar: number; offset: number; beats: number }[][] = segs.map(() => []);
  let acc = 0;
  for (const step of out) {
    let s = step;
    if (acc + s.beats > barT) {
      const remain = barT - acc;
      if (remain > 0) {
        bars[bars.length - 1].steps.push({
          beats: remain,
          hits: s.hits,
          ...(s.rest ? { rest: true } : {}),
          ...(s.hits.length ? { tie: true } : {}),
        });
        placements[step.seg].push({ bar: bars.length - 1, offset: acc, beats: remain });
        s = { ...s, beats: s.beats - remain, hits: [] };
      }
      bars.push({ index: bars.length, beatsPerBar, steps: [] });
      acc = 0;
    }
    bars[bars.length - 1].steps.push({
      beats: s.beats,
      hits: s.hits,
      ...(s.rest ? { rest: true } : {}),
      ...(s.tie ? { tie: true } : {}),
    });
    placements[step.seg].push({ bar: bars.length - 1, offset: acc, beats: s.beats });
    acc += s.beats;
    if (acc === barT) {
      bars.push({ index: bars.length, beatsPerBar, steps: [] });
      acc = 0;
    }
  }
  if (acc > 0) bars[bars.length - 1].steps.push({ beats: barT - acc, hits: [], rest: true });
  else if (bars.length > 1 && bars[bars.length - 1].steps.length === 0) bars.pop();
  bars.forEach((bar, i) => (bar.index = i));

  // 6) 逐段映射与改动小节集合
  const mappings: SegMapping[] = segs.map((seg, i) => ({
    fromBar: seg.fromBar,
    fromOffset: seg.fromOffset,
    fromBeats: seg.beats,
    idealBeats: (seg.beats * num) / den,
    toStart: starts[i],
    toBeats: lens[i],
    slices: lens[i] > 0 ? sliceSegment(lens[i], starts[i] % TICKS_PER_BEAT) : [],
    merged: lens[i] === 0,
    hits: seg.hits,
    rest: seg.rest,
    placements: placements[i],
  }));
  const changed = new Set<number>();
  for (const m of mappings) {
    const quantized = Math.abs(m.toBeats - m.idealBeats) > 1e-9;
    const crossBar = new Set(m.placements.map((p) => p.bar)).size > 1;
    if (quantized || m.slices.length > 1 || m.merged || crossBar) {
      if (m.placements.length) m.placements.forEach((p) => changed.add(p.bar));
      else changed.add(Math.min(bars.length - 1, Math.floor(m.toStart / barT))); // 并入同格的段
    }
  }
  return {
    ok: true,
    score: { ...score, bars, updatedAt: Date.now() },
    mappings,
    changedBars: [...changed].sort((a, z) => a - z),
    newTotal,
  };
}

function glyphsText(hits: Hit[]): string {
  return hits.map((h) => h.glyph ?? h.instrumentId).join('·');
}

function trimNum(x: number): string {
  return (Math.round(x * 100) / 100).toString();
}

/** 逐小节 diff 的一行描述：拟音字 原格→新格（≈理想值 / ＝切片 / 跨小节 / 并入同格） */
export function describeMapping(m: SegMapping): string | null {
  if (m.merged) return m.hits.length ? `${glyphsText(m.hits)} 并入同格` : null;
  if (m.hits.length === 0 && !m.rest) return null; // 纯空步不逐条列
  const head = m.hits.length === 0 ? '休止' : glyphsText(m.hits);
  const parts = [`${head} ${m.fromBeats}→${m.toBeats}格`];
  if (Math.abs(m.idealBeats - m.toBeats) > 1e-9) parts.push(`≈理想${trimNum(m.idealBeats)}`);
  if (m.slices.length > 1) parts.push(`＝${m.slices.join('+')}`);
  if (new Set(m.placements.map((p) => p.bar)).size > 1) parts.push('（跨小节）');
  return parts.join(' ');
}
