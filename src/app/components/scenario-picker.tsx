import { listScenarioOptions, type ScenarioConfigId } from "../../domain/scenario-config";

/**
 * U11：进门场景选择控件。选项来自 scenario-config（generic-tsn / aerospace-onboard），
 * 选中值由调用方写入当前会话 workflow.scenarioConfigId（纯前端、不走大模型）。
 * 只在会话尚未开始（无用户消息）时显示——开始后场景锁定。
 */
export function ScenarioPicker({
  value,
  onSelect,
  disabled,
}: {
  value: ScenarioConfigId;
  onSelect: (id: ScenarioConfigId) => void;
  disabled?: boolean;
}) {
  return (
    <div className="scenario-picker" role="group" aria-label="选择场景">
      {listScenarioOptions().map((option) => (
        <button
          key={option.id}
          type="button"
          className={option.id === value ? "scenario-option active" : "scenario-option"}
          aria-pressed={option.id === value}
          disabled={disabled}
          onClick={() => onSelect(option.id)}
        >
          {option.displayName}
        </button>
      ))}
    </div>
  );
}
