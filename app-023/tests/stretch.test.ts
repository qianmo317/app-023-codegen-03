// 时值伸缩用例 —— 比例换算、合法时值重切、拟音字/技法一个不丢、每小节铺满、改动报告
import { describe, expect, it } from 'vitest';
import type { Hit, Score } from '../src/types';
import { LEGAL_TICKS, decomposeTicks, parseRatio, stretchScore } from '../src/lib/stretch';
import { barTicks, isBarFull, validateScore } from '../src/lib/grid';
import { validateHitGlyphs } from '../src/lib/glyphs';
import { PATTERNS, newEmptyScore, scoreFromPattern } from '../src/lib/factory';

const mkScore = (beatsPerBar: number, bars: [string[], number][]): Score =>
  scoreFromPattern({ id: 't', name: '测试', style: '', bpm: 100, beatsPerBar, desc: '', bars });

/** 全部起音的绝对格位置 */
const onsets = (s: Score): number[] => {
  const out: number[] = [];
  let abs = 0;
  for (const b of s.bars)
    for (const st of b.steps) {
      if (st.hits.length) out.push(abs);
      abs += st.beats;
    }
  return out;
};

const allHits = (s: Score): Hit[] => s.bars.flatMap((b) => b.steps.flatMap((st) => st.hits));

const ok = (s: Score, r: number) => {
  const res = stretchScore(s, r);
  if (!res.ok) throw new Error(res.error);
  return res;
};

describe('S1-S8 decomposeTicks 合法时值重切（同拍内不生硬）', () => {
  it('S1 5 格（拍首起）→ 4+1', () => expect(decomposeTicks(0, 5)).toEqual([4, 1]));
  it('S2 6 格拍首起 = 附点整段，不拆', () => expect(decomposeTicks(0, 6)).toEqual([6]));
  it('S3 6 格拍中起 → 先补拍界 2+4', () => expect(decomposeTicks(2, 6)).toEqual([2, 4]));
  it('S4 4 格跨拍 → 2+2（不硬跨拍线）', () => expect(decomposeTicks(2, 4)).toEqual([2, 2]));
  it('S5 7 格 → 4+3', () => expect(decomposeTicks(0, 7)).toEqual([4, 3]));
  it('S6 9 格 → 4+4+1', () => expect(decomposeTicks(0, 9)).toEqual([4, 4, 1]));
  it('S7 10 格 → 4+6（附点收尾）', () => expect(decomposeTicks(0, 10)).toEqual([4, 6]));
  it('S8 任意起点/长度：每片皆合法时值且总长不变', () => {
    for (let off = 0; off < 16; off++)
      for (let len = 1; len <= 16; len++) {
        const parts = decomposeTicks(off, len);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(len);
        for (const p of parts) expect(LEGAL_TICKS).toContain(p);
      }
  });
});

describe('S9-S12 比例输入解析', () => {
  it('S9 整数与小数', () => {
    expect(parseRatio('2')).toBe(2);
    expect(parseRatio('0.5')).toBe(0.5);
  });
  it('S10 分数写法', () => {
    expect(parseRatio('1/2')).toBe(0.5);
    expect(parseRatio(' 3/2 ')).toBe(1.5);
  });
  it('S11 非法输入返回 null', () => {
    expect(parseRatio('')).toBeNull();
    expect(parseRatio('abc')).toBeNull();
    expect(parseRatio('1/0')).toBeNull();
  });
  it('S12 非正比例被 stretchScore 拒绝', () => {
    const s = mkScore(4, [[['哐'], 4]]);
    expect(stretchScore(s, 0).ok).toBe(false);
    expect(stretchScore(s, -1).ok).toBe(false);
    expect(stretchScore(s, NaN).ok).toBe(false);
  });
});

describe('S13-S16 整倍换算（除得尽）', () => {
  it('S13 ×2 放慢一倍：起音全部翻倍，小节数翻倍', () => {
    const s = mkScore(2, [[['哐', '才', '七'], 2], [['才'], 2], [['哐'], 2], [['才'], 2]]); // 冲头骨架 2 小节
    const { score: out, report } = ok(s, 2);
    expect(report.afterBars).toBe(report.beforeBars * 2);
    expect(onsets(out)).toEqual(onsets(s).map((o) => o * 2));
    expect(validateScore(out)).toEqual([]);
    expect(validateHitGlyphs(out)).toEqual([]);
  });
  it('S14 ×½ 缩紧一半：偶数格起音全部精确减半', () => {
    const s = scoreFromPattern(PATTERNS.find((p) => p.name === '急急风')!);
    const { score: out, report } = ok(s, 0.5);
    expect(report.afterBars).toBe(2);
    expect(onsets(out)).toEqual(onsets(s).map((o) => o / 2));
    expect(report.changes.every((c) => !c.quantized)).toBe(true);
  });
  it('S15 ×2 后每小节正好铺满、无半格', () => {
    const s = scoreFromPattern(PATTERNS.find((p) => p.name === '四击头')!);
    const { score: out } = ok(s, 2);
    for (const bar of out.bars) {
      expect(isBarFull(bar)).toBe(true);
      for (const st of bar.steps) {
        expect(Number.isInteger(st.beats)).toBe(true);
        expect(LEGAL_TICKS).toContain(st.beats);
      }
    }
  });
  it('S16 ×½ 后拟音字序列不变（字序即锣鼓经）', () => {
    const s = scoreFromPattern(PATTERNS.find((p) => p.name === '冲头')!);
    const { score: out } = ok(s, 0.5);
    const glyphs = (sc: Score) => allHits(sc).map((h) => h.glyph).join('');
    expect(glyphs(out)).toBe(glyphs(s));
  });
});

describe('S17-S20 除不尽：最近格取整', () => {
  const frac = () => mkScore(4, [[['咚'], 1], [['八'], 1], [['哒'], 1], [['才'], 1]]); // 4 个 ¼ 拍 + 自动补休止
  it('S17 ×1.5：起音 0/1.5/3/4.5 → 最近整数格', () => {
    const { score: out, report } = ok(frac(), 1.5);
    expect(onsets(out)).toEqual([0, 2, 3, 5]); // 1.5→2、4.5→5（四舍五入）
    report.changes.forEach((c) => expect(Math.abs(c.ideal - c.toAbs)).toBeLessThanOrEqual(0.5));
  });
  it('S18 取整后保持先后次序、每击至少 1 格', () => {
    const { score: out } = ok(frac(), 1.5);
    const o = onsets(out);
    for (let i = 1; i < o.length; i++) expect(o[i]).toBeGreaterThan(o[i - 1]);
    expect(validateScore(out)).toEqual([]);
  });
  it('S19 报告标记哪些起音被取整', () => {
    const { report } = ok(frac(), 1.5);
    expect(report.changes.filter((c) => c.quantized).length).toBe(2); // 1.5 与 4.5 两处
    expect(report.changes.map((c) => c.toAbs)).toEqual(onsets(ok(frac(), 1.5).score));
  });
  it('S20 ×2/3 内容放不下时自动补小节，一个击都不丢', () => {
    const s = scoreFromPattern(PATTERNS.find((p) => p.name === '四击头')!); // 末击换算后恰顶到小节末
    const { score: out, report } = ok(s, 2 / 3);
    expect(report.afterBars).toBe(2); // 1 小节放不下 → 自动补
    expect(allHits(out).length).toBe(allHits(s).length);
    expect(validateScore(out)).toEqual([]);
  });
});

describe('S21-S24 拟音字/技法/力度保留', () => {
  const techScore = (): Score => ({
    ...newEmptyScore('技法', 4, 1),
    bars: [
      {
        index: 0,
        beatsPerBar: 4,
        steps: [
          { beats: 1, hits: [{ instrumentId: 'gu', velocity: 3, glyph: '八', tech: ['flam'] }] },
          { beats: 3, hits: [] },
          {
            beats: 2,
            hits: [
              { instrumentId: 'xiaoluo', velocity: 1, glyph: '台', tech: ['roll'] },
              { instrumentId: 'daluo', velocity: 2, glyph: '哐' },
            ],
          },
          { beats: 10, hits: [], rest: true },
        ],
      },
    ],
  });
  it('S21 技法与力度原样保留（×1.5）', () => {
    const s = techScore();
    const { score: out } = ok(s, 1.5);
    expect(JSON.stringify(allHits(out))).toBe(JSON.stringify(allHits(s)));
  });
  it('S22 齐奏不拆散：同步多乐器伸缩后仍同格', () => {
    const s = techScore();
    const { score: out } = ok(s, 2 / 3);
    const chord = out.bars.flatMap((b) => b.steps).find((st) => st.hits.length === 2);
    expect(chord).toBeDefined();
    expect(chord!.hits.map((h) => h.instrumentId).sort()).toEqual(['daluo', 'xiaoluo']);
  });
  it('S23 六个内置曲牌 × 六种比例：击数守恒、结构合法、字不串乐器', () => {
    for (const p of PATTERNS) {
      const s = scoreFromPattern(p);
      for (const r of [0.5, 2 / 3, 0.75, 4 / 3, 1.5, 2]) {
        const { score: out } = ok(s, r);
        expect(allHits(out).length, `${p.name} ×${r} 击数`).toBe(allHits(s).length);
        expect(validateScore(out), `${p.name} ×${r} 铺满`).toEqual([]);
        expect(validateHitGlyphs(out), `${p.name} ×${r} 拟音字`).toEqual([]);
      }
    }
  });
  it('S24 休止段按比例保留（rest 标记不丢）', () => {
    const s = techScore(); // 末尾 10 格休止
    const { score: out } = ok(s, 2);
    const restTicks = out.bars
      .flatMap((b) => b.steps)
      .filter((st) => st.rest)
      .reduce((a, st) => a + st.beats, 0);
    expect(restTicks).toBeGreaterThanOrEqual(20); // 10×2，末段吸收取整零头只会更多
  });
});

describe('S25-S28 连线、报告与撤销', () => {
  it('S25 时值跨小节被切开时前段连线延伸', () => {
    const s = mkScore(4, [[['哐'], 12]]); // 12 格长音 + 补休止
    const { score: out } = ok(s, 2); // → 24 格，跨第 1/2 小节
    expect(out.bars.length).toBe(2);
    expect(out.bars[0].steps[out.bars[0].steps.length - 1].tie).toBe(true);
    expect(out.bars[1].steps[0].tie).toBe(true);
    expect(out.bars[1].steps.every((st) => st.hits.length === 0)).toBe(true);
    expect(isBarFull(out.bars[0]) && isBarFull(out.bars[1])).toBe(true);
  });
  it('S26 报告逐小节可定位：bar/tick 与绝对格一致', () => {
    const s = scoreFromPattern(PATTERNS.find((p) => p.name === '马腿儿')!);
    const { report } = ok(s, 1.5);
    const bt = barTicks(4);
    for (const c of report.changes) {
      expect(c.bar * bt + c.tick).toBe(c.toAbs);
      expect(c.fromBar * bt + c.fromTick).toBe(c.fromAbs);
      expect(c.text.length).toBeGreaterThan(0);
    }
    expect(report.changes.length).toBe(onsets(s).length);
  });
  it('S27 伸缩不改动原谱（纯函数）', () => {
    const s = scoreFromPattern(PATTERNS.find((p) => p.name === '威风锣鼓·排山')!);
    const snapshot = JSON.stringify(s.bars);
    ok(s, 0.5);
    ok(s, 1.5);
    expect(JSON.stringify(s.bars)).toBe(snapshot);
  });
  it('S28 撤销：伸缩前的 bars 快照可原样还原', () => {
    const s = scoreFromPattern(PATTERNS.find((p) => p.name === '收头')!);
    const backup = structuredClone(s.bars);
    const { score: out } = ok(s, 2);
    expect(JSON.stringify(out.bars)).not.toBe(JSON.stringify(backup));
    const restored: Score = { ...out, bars: backup };
    expect(restored.bars).toEqual(s.bars);
    expect(validateScore(restored)).toEqual([]);
  });
});
