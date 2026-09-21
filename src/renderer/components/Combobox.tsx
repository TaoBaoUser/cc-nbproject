import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelListItem } from '../types';

interface Props {
  value: string;
  options: ModelListItem[];
  placeholder?: string;
  /** 提交最终值（空串 = 取消映射）。在 change / Enter / 选中选项时触发。 */
  onCommit: (value: string) => void;
  /** 首次聚焦时触发（用于按需拉取模型列表）。 */
  onRequestModels?: () => void;
}

/** 与 .combobox-list 的 max-height 对应，用来判断下面还放不放得下一个浮层。 */
const LIST_MAX_HEIGHT = 240;
/** 浮层与输入框之间的间距，和 CSS 里 `calc(100% + 4px)` 是同一个数。 */
const LIST_GAP = 4;

/**
 * 浮层该朝下还是朝上。
 *
 * 卡片列表被 `.main` 的滚动盒裁着，最后一张卡片贴到视口底部时，朝下的浮层会被
 * 推出视野（实测：底边超出视口 81px，只看得见 66%）。所以下面放不下就翻到上面，
 * 前提是上面确实更宽裕 —— 两头都不够时保持朝下，那是原来的行为，不该更差。
 */
function shouldDropUp(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const 需要 = LIST_MAX_HEIGHT + LIST_GAP;
  const 下方余量 = window.innerHeight - rect.bottom;
  const 上方余量 = rect.top;
  return 下方余量 < 需要 && 上方余量 > 下方余量;
}

/**
 * 自写的可搜索、可滚动下拉，替代原生 <datalist>。
 *
 * 原生 datalist 是浏览器黑盒：无法滚动、样式不可控（见 front-plans 里的「下拉固定、不能滚动」）。
 * 这里用普通 <input> + 一个可滚动候选列表实现，同时保留自由输入能力 ——
 * 没有 /v1/models 的供应商（DeepSeek）候选为空时，输入框退化为普通文本框。
 */
export default function Combobox({ value, options, placeholder, onCommit, onRequestModels }: Props) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  // 朝上展开。只在打开的那一刻量一次：浮层是跟着输入框走的（绝对定位在它那一行里），
  // 位置相对输入框不会变，开着的期间再去跟着滚动量只会让它来回跳。
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * 外部值变化（采纳建议 / 取消映射后）同步回输入框。
   *
   * 用「渲染期间调整 state」而不是 useEffect：后者会先拿旧 draft 渲染一帧、
   * 再触发第二轮渲染，输入框会肉眼可见地闪一下旧值。这里在渲染期间直接改，
   * React 会当场丢弃这次渲染结果重来，不会有中间帧。
   */
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  // 原生 focus / change 监听：与旧版 app.js 的 addEventListener 一致，
  // 兼容冒烟检查直接 dispatchEvent('focus'/'change') 的写法。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onFocus = () => {
      setDropUp(shouldDropUp(el));
      setOpen(true);
      onRequestModels?.();
    };
    const onChange = () => onCommit(el.value.trim());
    el.addEventListener('focus', onFocus);
    el.addEventListener('change', onChange);
    return () => {
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('change', onChange);
    };
  }, [onCommit, onRequestModels]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 窗口尺寸变了，下面放不放得下也跟着变（这条不跟滚动走，理由见上面 dropUp 的注释）
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const el = inputRef.current;
      if (el) setDropUp(shouldDropUp(el));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  const filtered = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.name} ${o.id}`.toLowerCase().includes(q));
  }, [draft, options]);

  const select = (id: string) => {
    setDraft(id);
    setOpen(false);
    setHighlight(-1);
    onCommit(id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const el = inputRef.current;
      if (el && !open) setDropUp(shouldDropUp(el));
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && highlight >= 0 && filtered[highlight]) select(filtered[highlight].id);
      else {
        setOpen(false);
        onCommit(draft.trim());
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setDraft(value);
    }
  };

  return (
    <div className="combobox" ref={rootRef}>
      <input
        ref={inputRef}
        value={draft}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          if (!open) {
            const el = inputRef.current;
            if (el) setDropUp(shouldDropUp(el));
          }
          setOpen(true);
          setHighlight(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      {open && filtered.length > 0 && (
        <div className={`combobox-list${dropUp ? ' is-up' : ''}`}>
          {filtered.map((o, i) => (
            <div
              key={o.id}
              className={`combobox-option${i === highlight ? ' is-highlighted' : ''}`}
              data-value={o.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(o.id)}
            >
              <span className="combobox-option-name">{o.name}</span>
              <span className="combobox-option-id">{o.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
