// 时值伸缩工具条：选比例 → 应用 → 逐小节改动报告 → 一键撤销
import { useMemo, useState } from 'react';
import { parseRatio, type StretchReport } from '../lib/stretch';

interface Props {
  canUndo: boolean;
  report: StretchReport | null;
  error: string;
  onApply: (ratio: number) => void;
  onUndo: () => void;
  onCloseReport: () => void;
}

const PRESETS: { label: string; value: number; title: string }[] = [
  { label: '×½', value: 0.5, title: '缩紧一半（上台）' },
  { label: '×⅔', value: 2 / 3, title: '缩为三分之二' },
  { label: '×¾', value: 0.75, title: '缩为四分之三' },
  { label: '×4/3', value: 4 / 3, title: '放为三分之四' },
  { label: '×3/2', value: 1.5, title: '放为二分之三' },
  { label: '×2', value: 2, title: '放慢一倍（练习）' },
];

export function StretchPanel({ canUndo, report, error, onApply, onUndo, onCloseReport }: Props) {
  const [custom, setCustom] = useState('');

  const applyCustom = () => {
    const r = parseRatio(custom);
    if (r !== null) onApply(r);
  };

  // 报告按新小节分组，逐小节列出「哪里被改了、改成了什么」
  const byBar = useMemo(() => {
    const m = new Map<number, string[]>();
    if (!report) return m;
    for (const c of report.changes) {
      const from = `原${c.fromBar + 1}小节第${c.fromTick + 1}格`;
      const to = `第${c.tick + 1}格`;
      const approx = c.quantized ? `（除不尽，理想 ${c.ideal.toFixed(2)} 格，取最近）` : '';
      const line = `${c.text}：${from} → ${to}${approx}`;
      m.set(c.bar, [...(m.get(c.bar) ?? []), line]);
    }
    return m;
  }, [report]);

  return (
    <div className="stretch-wrap" data-testid="stretch-panel">
      <div className="stretch-bar">
        <span className="stretch-label">时值伸缩</span>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className="btn-sm"
            data-testid={`stretch-${p.label}`}
            title={p.title}
            onClick={() => onApply(p.value)}
          >
            {p.label}
          </button>
        ))}
        <input
          className="stretch-input"
          data-testid="stretch-custom"
          placeholder="比例 如 3/2"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyCustom();
          }}
        />
        <button className="btn-sm" data-testid="stretch-apply-custom" onClick={applyCustom}>
          应用
        </button>
        <button
          className="btn-sm"
          data-testid="stretch-undo"
          disabled={!canUndo}
          title="撤销上次伸缩，还原为伸缩前的谱面"
          onClick={onUndo}
        >
          撤销伸缩
        </button>
        {error && (
          <span className="stretch-err" data-testid="stretch-error">
            {error}
          </span>
        )}
      </div>
      {report && (
        <div className="stretch-report" data-testid="stretch-report">
          <div className="stretch-report-head">
            <b>
              本次伸缩 ×{report.ratio}：{report.beforeBars} 小节 → {report.afterBars} 小节（
              {report.beforeTicks} 格 → {report.afterTicks} 格），起音改动 {report.changes.length} 处
              {report.changes.some((c) => c.quantized)
                ? `，其中 ${report.changes.filter((c) => c.quantized).length} 处除不尽已取最近格`
                : ''}
            </b>
            <button className="btn-sm" data-testid="stretch-report-close" onClick={onCloseReport}>
              收起
            </button>
          </div>
          {[...byBar.entries()].map(([bar, lines]) => (
            <div key={bar} className="stretch-report-bar" data-testid={`stretch-bar-${bar}`}>
              <span className="stretch-bar-no">第 {bar + 1} 小节</span>
              {lines.map((l, i) => (
                <span key={i} className="stretch-change">
                  {l}
                </span>
              ))}
            </div>
          ))}
          {report.changes.length === 0 && <div className="dim">全曲无击，仅小节数变化。</div>}
        </div>
      )}
    </div>
  );
}
