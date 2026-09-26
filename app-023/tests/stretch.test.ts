// 时值伸缩用例 —— 比例换算、合法时值切片、铺满不变式、拟音字/技法保留、逐小节 diff
import { describe, expect, it } from 'vitest';
import type { Bar, Hit, Score, Step } from '../src/types';
import { isBarFull, validateScore } from '../src/lib/grid';
import { newEmptyScore, scoreFromPattern, PATTERNS } from '../src/lib/factory';
import { validateHitGlyphs } from '../src/lib/glyphs';
import { describeMapping, RATIO_PRESETS, sliceSegment, stretchScore, type StretchOk } from '../src/lib/stretch';

const hit = (instrumentId: string, glyph?: string, extra: Partial<Hit> = {}): Hit => ({
  instrumentId,
  velocity: 2,
  glyph,
  ...extra,
});
const st = (beats: number, extra: Partial<Step> = {}): Step => ({ beats, hits: [], ...extra });
const mkScore = (beatsPerBar: number, stepsPerBar: Step[][]): Score => ({
  ...newEmptyScore('伸缩测试', beatsPerBar, stepsPerBar.length),
  bars: stepsPerBar.map((steps, i): Bar => ({ index: i, beatsPerBar, steps })),
});

const allHits = (s: Score): Hit[] => s.bars.flatMap((b) => b.steps.flatMap((x) => x.hits));
const glyphBag = (s: Score): string[] => allHits(s).map((h) => `${h.instrumentId}:${h.glyph}`).sort();
const ok = (r: ReturnType<typeof stretchScore>): StretchOk => {
  if (!r.ok) throw new Error(`伸缩失败：${r.error}`);
  return r;
};

describe('S1-S6 段内合法时值切片（同一拍里的分割不生硬）', () => {
  it('S1 合法时值不切：1/2/3/4/6 原样返回', () => {
    for (const k of [1, 2, 3, 4, 6]) expect(sliceSegment(k, 0)).toEqual([k]);
  });
  it('S2 拍首起 5 格 → 4+1（整拍延伸，而非 1+4 生硬切入）', () => {
    expect(sliceSegment(5, 0)).toEqual([4, 1]);
  });
  it('S3 拍内相位 2 起 5 格 → 2+3（先对齐拍界再续）', () => {
    expect(sliceSegment(5, 2)).toEqual([2, 3]);
  });
  it('S4 拍首起 7 格 → 4+3（切口落在拍界）', () => {
    expect(sliceSegment(7, 0)).toEqual([4, 3]);
  });
  it('S5 拍首起 8 格 → 4+4（两整拍）', () => {
    expect(sliceSegment(8, 0)).toEqual([4, 4]);
  });
  it('S6 任意长度切片和 = 原长且每片都是合法时值', () => {
    for (let len = 1; len <= 24; len++) {
      for (let phase = 0; phase < 4; phase++) {
        const cuts = sliceSegment(len, phase);
        expect(cuts.reduce((s, x) => s + x, 0)).toBe(len);
        for (const c of cuts) expect([1, 2, 3, 4, 6]).toContain(c);
      }
    }
  });
});

describe('S7-S10 整倍伸缩（起音位置按比例换算）', () => {
  const score = mkScore(2, [[st(4, { hits: [hit('daluo', '哐'), hit('xiaoluo', '才'), hit('bo', '七')] }), st(2, { hits: [hit('xiaoluo', '才')] }), st(2, { hits: [hit('daluo', '仓')] })]]);

  it('S7 放慢一倍：每击位置与时值 ×2，小节数 ×2，每小节铺满', () => {
    const r = ok(stretchScore(score, 2, 1));
    expect(r.score.bars.length).toBe(2);
    expect(validateScore(r.score)).toEqual([]);
    // 哐才七 8 格（4+4 连线）；才 4 格落在第 2 小节首；仓 4 格
    const m = r.mappings.filter((x) => x.hits.length > 0);
    expect(m[0].toStart).toBe(0);
    expect(m[0].toBeats).toBe(8);
    expect(m[0].slices).toEqual([4, 4]);
    expect(m[1].toStart).toBe(8);
    expect(m[1].toBeats).toBe(4);
    expect(m[2].toStart).toBe(12);
    expect(glyphBag(r.score)).toEqual(glyphBag(score));
  });

  it('S8 缩紧一半：位置与时值减半，小节数减半', () => {
    const s2 = mkScore(4, [
      [st(4, { hits: [hit('gu', '咚')] }), st(4, { hits: [hit('gu', '咚')] }), st(4, { hits: [hit('daluo', '哐')] }), st(4, { hits: [hit('daluo', '仓')] })],
      [st(4, { hits: [hit('bo', '七')] }), st(4), st(4), st(4)],
    ]);
    const r = ok(stretchScore(s2, 1, 2));
    expect(r.newTotal).toBe(16);
    expect(r.score.bars.length).toBe(1);
    expect(validateScore(r.score)).toEqual([]);
    const m = r.mappings.filter((x) => x.hits.length > 0);
    expect(m.map((x) => x.toStart)).toEqual([0, 2, 4, 6, 8]);
    expect(m.every((x) => x.toBeats === 2)).toBe(true);
    expect(glyphBag(r.score)).toEqual(glyphBag(s2));
  });

  it('S9 缩紧后末尾不足一小节自动补休止铺满', () => {
    const s2 = mkScore(4, [[st(4, { hits: [hit('gu', '咚')] }), st(4), st(4), st(4)]]); // 16 格 ×½ = 8 格
    const r = ok(stretchScore(s2, 1, 2));
    expect(r.score.bars.length).toBe(1);
    expect(isBarFull(r.score.bars[0])).toBe(true);
    expect(r.score.bars[0].steps.some((x) => x.rest)).toBe(true);
  });

  it('S10 比例预设覆盖「缩紧一半」与「放慢一倍」', () => {
    expect(RATIO_PRESETS.some((p) => p.num === 1 && p.den === 2)).toBe(true);
    expect(RATIO_PRESETS.some((p) => p.num === 2 && p.den === 1)).toBe(true);
  });
});

describe('S11-S15 除不尽的量化（相邻合法时值拼接近似）', () => {
  it('S11 ×3/2 时 1 格段理想 1.5 → 拼成相邻合法时值 1 或 2，总误差最小', () => {
    const s2 = mkScore(2, [[st(1, { hits: [hit('gu', '哒')] }), st(1, { hits: [hit('gu', '咚')] }), st(2, { hits: [hit('xiaoluo', '才')] }), st(4, { hits: [hit('daluo', '仓')] })]]);
    const r = ok(stretchScore(s2, 3, 2));
    expect(r.newTotal).toBe(12);
    expect(validateScore(r.score)).toEqual([]);
    const m = r.mappings.filter((x) => x.hits.length > 0);
    expect(m[0].idealBeats).toBe(1.5);
    expect([1, 2]).toContain(m[0].toBeats); // 相邻合法时值
    expect([1, 2]).toContain(m[1].toBeats);
    // 两个 1.5 段合起来正好 3 格：一个 1 一个 2，总误差最小
    expect(m[0].toBeats + m[1].toBeats).toBe(3);
    expect(m[2].toBeats).toBe(3);
    expect(m[3].toBeats).toBe(6);
    // 起音位置尽量贴近理想：哒@0、咚@1.5→1或2、才@3、仓@6
    expect(m[2].toStart).toBe(3);
    expect(m[3].toStart).toBe(6);
    expect(glyphBag(r.score)).toEqual(glyphBag(s2));
  });

  it('S12 ×3/2 的量化段在 diff 里标注理想值', () => {
    const s2 = mkScore(2, [[st(1, { hits: [hit('gu', '哒')] }), st(1, { hits: [hit('gu', '咚')] }), st(6, { hits: [hit('daluo', '仓')] })]]);
    const r = ok(stretchScore(s2, 3, 2));
    const quantized = r.mappings.filter((m) => Math.abs(m.toBeats - m.idealBeats) > 1e-9 && m.hits.length);
    expect(quantized.length).toBeGreaterThan(0);
    const text = describeMapping(quantized[0])!;
    expect(text).toContain('≈理想');
    expect(text).toContain('哒');
  });

  it('S13 长段切成合法时值拼接（8 格 ×3/2 = 12 → 合法时值之和）', () => {
    const s2 = mkScore(4, [[st(4, { hits: [hit('daluo', '哐')] }), st(4), st(4), st(4)]]);
    const r = ok(stretchScore(s2, 3, 2));
    const m = r.mappings[0];
    expect(m.toBeats).toBe(6);
    expect(m.slices).toEqual([6]); // 附点本身是合法时值
    const rest = r.mappings.filter((x) => x.rest || x.hits.length === 0);
    for (const x of rest) expect(x.slices.reduce((s, k) => s + k, 0)).toBe(x.toBeats);
  });

  it('S14 比例过小放不下时并入同格，拟音字一个不丢', () => {
    // 16 个 ¼ 拍连打 ×½：新总格 8 < 16 段，至少 8 段要并入同格
    const hits16 = [hit('gu', '咚'), hit('daluo', '哐'), hit('xiaoluo', '才'), hit('bo', '七')];
    const s2 = mkScore(4, [Array.from({ length: 16 }, (_, i) => st(1, { hits: [hits16[i % 4]] }))]);
    const r = ok(stretchScore(s2, 1, 2));
    expect(r.newTotal).toBe(8);
    expect(validateScore(r.score)).toEqual([]);
    const glyphs = glyphBag(r.score);
    for (const g of glyphBag(s2)) expect(glyphs).toContain(g); // 字都在
    expect(r.mappings.filter((m) => m.merged).length).toBeGreaterThanOrEqual(8);
    expect(describeMapping(r.mappings.find((m) => m.merged && m.hits.length)!)!).toContain('并入同格');
  });

  it('S15 非法比例与越界比例报错', () => {
    const s2 = mkScore(2, [[st(4), st(4)]]);
    expect(stretchScore(s2, 0, 1).ok).toBe(false);
    expect(stretchScore(s2, 1, 0).ok).toBe(false);
    expect(stretchScore(s2, 1.5, 1).ok).toBe(false);
    expect(stretchScore(s2, 1, 5).ok).toBe(false); // < 1/4
    expect(stretchScore(s2, 5, 1).ok).toBe(false); // > 4
  });
});

describe('S16-S19 拟音字 / 技法 / 连线保留', () => {
  it('S16 技法与力度原样保留（滚/闷/双、velocity）', () => {
    const s2 = mkScore(4, [
      [
        st(2, { hits: [hit('xiaoluo', '台', { tech: ['roll'], velocity: 3 })] }),
        st(2, { hits: [hit('gu', '哒', { tech: ['mute'] })] }),
        st(4, { hits: [hit('daluo', '仓', { tech: ['flam'], velocity: 1 })] }),
        st(4),
        st(4),
      ],
    ]);
    const r = ok(stretchScore(s2, 3, 2));
    const byGlyph = new Map(allHits(r.score).map((h) => [h.glyph, h]));
    expect(byGlyph.get('台')!.tech).toEqual(['roll']);
    expect(byGlyph.get('台')!.velocity).toBe(3);
    expect(byGlyph.get('哒')!.tech).toEqual(['mute']);
    expect(byGlyph.get('仓')!.tech).toEqual(['flam']);
    expect(byGlyph.get('仓')!.velocity).toBe(1);
  });

  it('S17 连线（tie）保留在段的最后一片，仍指向原下一段', () => {
    const s2 = mkScore(2, [[st(4, { hits: [hit('daluo', '哐')], tie: true }), st(4, { hits: [hit('daluo', '仓')] })]]);
    const r = ok(stretchScore(s2, 2, 1));
    // 哐 8 格 → 4+4，末片 tie 指向下一步（仓的首片）
    const steps = r.score.bars.flatMap((b) => b.steps);
    const kuangTail = steps.filter((x) => x.hits.length === 0 && x.tie)[0];
    expect(kuangTail).toBeTruthy();
    const idx = steps.indexOf(kuangTail);
    expect(steps[idx + 1].hits[0].glyph).toBe('仓');
  });

  it('S18 段内切片的前片带 hits 与连线，后片转空步（连打听感不断）', () => {
    const s2 = mkScore(4, [[st(4, { hits: [hit('gu', '咚')] }), st(4), st(4), st(4)]]);
    const r = ok(stretchScore(s2, 2, 1)); // 咚 4→8 = 4+4
    const m = r.mappings[0];
    expect(m.slices).toEqual([4, 4]);
    const steps = r.score.bars[0].steps;
    expect(steps[0].hits[0].glyph).toBe('咚');
    expect(steps[0].tie).toBe(true);
    expect(steps[1].hits.length).toBe(0);
  });

  it('S19 伸缩不改动原谱（不可变更新，撤销快照即原引用）', () => {
    const s2 = mkScore(2, [[st(4, { hits: [hit('gu', '咚')] }), st(2, { hits: [hit('bo', '七')] }), st(2)]]);
    const snapshot = JSON.parse(JSON.stringify(s2)) as Score;
    const r = ok(stretchScore(s2, 3, 2));
    expect(s2).toEqual(snapshot); // 入参未被 mutate
    expect(r.score).not.toBe(s2);
    expect(r.score.bars).not.toBe(s2.bars);
  });
});

describe('S20-S22 逐小节 diff 与改动标记', () => {
  it('S20 mappings 覆盖每个原 step，placements 落在新小节内', () => {
    const s2 = mkScore(2, [[st(4, { hits: [hit('gu', '咚')] }), st(4, { hits: [hit('daluo', '哐')] })]]);
    const r = ok(stretchScore(s2, 2, 1));
    expect(r.mappings.length).toBe(2);
    for (const m of r.mappings) {
      expect(m.placements.length).toBeGreaterThan(0);
      for (const p of m.placements) {
        expect(p.bar).toBeGreaterThanOrEqual(0);
        expect(p.bar).toBeLessThan(r.score.bars.length);
        expect(p.offset + p.beats).toBeLessThanOrEqual(8);
      }
    }
  });

  it('S21 changedBars 标出量化/切分小节，describeMapping 逐条可读', () => {
    const s2 = mkScore(2, [[st(1, { hits: [hit('gu', '哒')] }), st(1, { hits: [hit('gu', '咚')] }), st(2, { hits: [hit('xiaoluo', '才')] }), st(4, { hits: [hit('daluo', '仓')] })]]);
    const r = ok(stretchScore(s2, 3, 2));
    expect(r.changedBars.length).toBeGreaterThan(0);
    const lines = r.mappings.map(describeMapping).filter((x): x is string => !!x);
    expect(lines.some((l) => l.includes('哒'))).toBe(true);
    expect(lines.some((l) => l.includes('→'))).toBe(true);
  });

  it('S22 跨小节段在 diff 里标注「跨小节」', () => {
    // 哐 6 格 ×2 = 12 格 > 2/4 小节 8 格 → 必跨小节
    const s2 = mkScore(2, [[st(6, { hits: [hit('daluo', '哐')] }), st(2, { hits: [hit('xiaoluo', '才')] })]]);
    const r = ok(stretchScore(s2, 2, 1));
    expect(validateScore(r.score)).toEqual([]);
    const cross = r.mappings.find((m) => m.placements.length > 1)!;
    expect(cross).toBeTruthy();
    expect(describeMapping(cross)!).toContain('跨小节');
    expect(glyphBag(r.score)).toEqual(glyphBag(s2));
  });
});

describe('S23-S24 六个内置曲牌实战', () => {
  it('S23 全部曲牌 ×{½, 3/2, 2} 后结构有效、拟音字不丢', () => {
    for (const p of PATTERNS) {
      const score = scoreFromPattern(p);
      for (const [num, den] of [[1, 2], [3, 2], [2, 1]]) {
        const r = stretchScore(score, num, den);
        if (!r.ok) throw new Error(`${p.name} ×${num}/${den} 失败：${r.error}`);
        expect(validateScore(r.score), `${p.name} ×${num}/${den} 应铺满`).toEqual([]);
        expect(validateHitGlyphs(r.score), `${p.name} ×${num}/${den} 不串乐器`).toEqual([]);
        const after = glyphBag(r.score);
        for (const g of glyphBag(score)) expect(after, `${p.name} 丢字 ${g}`).toContain(g);
      }
    }
  });

  it('S24 急急风 ×2 小节数翻倍、×½ 减半，且每小节正好铺满', () => {
    const score = scoreFromPattern(PATTERNS.find((p) => p.name === '急急风')!);
    expect(score.bars.length).toBe(4);
    const slow = ok(stretchScore(score, 2, 1));
    expect(slow.score.bars.length).toBe(8);
    const fast = ok(stretchScore(score, 1, 2));
    expect(fast.score.bars.length).toBe(2);
    for (const s of [slow, fast]) {
      expect(validateScore(s.score)).toEqual([]);
      expect(s.score.bars.every(isBarFull)).toBe(true);
    }
  });
});
