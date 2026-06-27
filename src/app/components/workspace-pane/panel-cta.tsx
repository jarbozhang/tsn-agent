/**
 * 首次空态的醒目主操作（居中大按钮 + 说明）。
 *
 * 渐进式按钮放置（boss 定）：面板首次打开、还没结果时把「开始」按钮放在内容区中央，防止
 * 用户找不到；运行过/有结果后操作收进命令栏右上角。软仿 / 硬件部署共用。
 */
export function PanelCta({
  label,
  hint,
  onClick,
  disabled,
  title,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="panel-cta">
      <button
        type="button"
        className="btn primary panel-cta__btn"
        onClick={onClick}
        disabled={disabled}
        title={title}
      >
        {label}
      </button>
      {hint && <p className="panel-cta__hint">{hint}</p>}
    </div>
  );
}
