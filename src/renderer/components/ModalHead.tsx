/**
 * 弹窗头：标题区固定在顶部，右上角一个关闭按钮。
 *
 * **为什么关闭按钮不放进 `.modal-actions`**：e2e 用
 * `#modal-root .modal-actions button` 加上按钮文本来定位「确认接管」「好」「取消」
 * 「保存」「添加」。往里多塞一个按钮，按文本匹配就会失准 —— 这是那套断言赖以工作的前提。
 *
 * **为什么用 SVG 而不是「×」字符**：SVG 没有文本节点，不会混进 e2e 读取的
 * `modal.textContent`，也不会被任何按文本找按钮的脚本误伤。
 */
export default function ModalHead({
  title,
  sub,
  onClose,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
}) {
  return (
    <div className="modal-head">
      <div className="modal-head-text">
        <h2>{title}</h2>
        {sub ? <p className="modal-sub">{sub}</p> : null}
      </div>
      <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">
        <svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M3.5 3.5l7 7M10.5 3.5l-7 7"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
