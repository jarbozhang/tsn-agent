import { useRef, useState } from "react";
import {
  buildSimExplainPrompt,
  hasNonConvergedNode,
  invokeRunTimesyncSim,
  invokeSimExplain,
  isFullyConverged,
  type SimOverrideForm,
  type SimResult,
  type SimUiState,
} from "./timesync-sim";

/**
 * U11/U12/U13：时钟同步 tab 内容——软/硬仿按钮 + 门控 + 运行态 + 结果表 + 覆盖表单 + 解释。
 *
 * 运行态（simState）持于 App 级、经 props 透传：切 tab 不取消命令、切回按 status 恢复。
 * 覆盖表单展开/填值是组件内独立 intent（doc-review 决定：跨软仿运行保留、仅会话切换重置）。
 */

export interface TimeSyncPanelProps {
  /** 当前阶段是否 time-sync。 */
  inTimeSyncStage: boolean;
  /** 时钟树是否已确认（GM 已设）；软仿门控第二条件。 */
  treeConfirmed: boolean;
  sessionId: string;
  simState: SimUiState;
  onSimStateChange: (state: SimUiState) => void;
  /** 软仿写通道（测试注入替身）。 */
  runTimesyncSim?: (sessionId: string, overrides: SimOverrideForm) => Promise<SimResult>;
  /** 解释通道（测试注入替身）。 */
  explainSim?: (prompt: string) => Promise<string>;
}

const HARD_SIM_PLACEHOLDER = "待接入真实硬件";

export function TimeSyncPanel({
  inTimeSyncStage,
  treeConfirmed,
  sessionId,
  simState,
  onSimStateChange,
  runTimesyncSim = invokeRunTimesyncSim,
  explainSim = invokeSimExplain,
}: TimeSyncPanelProps) {
  // U12：覆盖表单状态（默认收起，跨软仿运行保留）。
  const [formExpanded, setFormExpanded] = useState(false);
  const [form, setForm] = useState<SimOverrideForm>({});
  const [hardSimNotice, setHardSimNotice] = useState(false);
  // U13：解释态。
  const [explainState, setExplainState] = useState<
    { status: "idle" } | { status: "running" } | { status: "done"; text: string }
  >({ status: "idle" });
  const [explainFailed, setExplainFailed] = useState(false);
  // 同步互斥：disabled/loading 态下一拍才生效，两次快速点击都能越过门控；ref 即时拦并发。
  const softSimInflight = useRef(false);
  const explainInflight = useRef(false);
  // 异步落地校验读最新会话：handler 闭包定格的是发起时那次 render 的 sessionId，
  // 切走后 prop 变了但旧闭包看不到；ref 始终指向当前 prop，await 落地后据此判定是否切走。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const running = simState.status === "running";
  // 门控两条文案（doc-review）：未到阶段 / 树未确认。
  const softSimDisabled = !inTimeSyncStage || !treeConfirmed || running;
  const softSimTooltip = !inTimeSyncStage
    ? "请先进入时钟同步阶段"
    : !treeConfirmed
      ? "请先确认时钟树"
      : undefined;

  async function handleSoftSim() {
    if (softSimDisabled || softSimInflight.current) {
      return;
    }
    softSimInflight.current = true;
    // 运行前定格当前会话：await 期间用户切走时，迟到结果不得落进新会话的状态。
    const runSessionId = sessionId;
    setHardSimNotice(false);
    setExplainState({ status: "idle" });
    setExplainFailed(false);
    onSimStateChange({ status: "running" });
    try {
      const result = await runTimesyncSim(runSessionId, form);
      if (runSessionId !== sessionIdRef.current) {
        return;
      }
      onSimStateChange({ status: "done", result });
    } catch (error) {
      if (runSessionId !== sessionIdRef.current) {
        return;
      }
      onSimStateChange({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      softSimInflight.current = false;
    }
  }

  async function handleExplain(result: SimResult) {
    if (explainInflight.current) {
      return;
    }
    explainInflight.current = true;
    const runSessionId = sessionId;
    setExplainState({ status: "running" });
    setExplainFailed(false);
    try {
      const text = await explainSim(buildSimExplainPrompt(result));
      if (runSessionId !== sessionIdRef.current) {
        return;
      }
      setExplainState({ status: "done", text });
    } catch {
      if (runSessionId !== sessionIdRef.current) {
        return;
      }
      setExplainState({ status: "idle" });
      setExplainFailed(true);
    } finally {
      explainInflight.current = false;
    }
  }

  return (
    <section
      className="detail-panel time-sync-panel"
      id="config-panel-time-sync"
      role="tabpanel"
      aria-label="时钟同步"
    >
      <div className="panel-heading">
        <div>
          <h2>时钟同步软仿</h2>
          <p>把当前拓扑 + 时钟树组装成 INET gPTP 软仿，远端跑完取回各节点相对 GM 的收敛偏差。</p>
        </div>
      </div>

      <div className="sim-actions" role="group" aria-label="仿真操作">
        <button
          type="button"
          className="btn primary"
          disabled={softSimDisabled}
          title={softSimTooltip}
          onClick={() => void handleSoftSim()}
        >
          {running ? "软仿运行中…" : "软仿"}
        </button>
        <button type="button" className="btn" onClick={() => setHardSimNotice(true)}>
          硬仿
        </button>
      </div>
      {hardSimNotice && (
        <p className="sim-hint mono" role="status">
          {HARD_SIM_PLACEHOLDER}
        </p>
      )}

      <SimOverrideRegion
        expanded={formExpanded}
        form={form}
        onToggle={() => setFormExpanded((value) => !value)}
        onChange={setForm}
      />

      <SimResultArea
        simState={simState}
        explainState={explainState}
        explainFailed={explainFailed}
        onExplain={handleExplain}
      />
    </section>
  );
}

/** U12：软仿覆盖表单（3 参数，默认收起）。 */
function SimOverrideRegion({
  expanded,
  form,
  onToggle,
  onChange,
}: {
  expanded: boolean;
  form: SimOverrideForm;
  onToggle: () => void;
  onChange: (form: SimOverrideForm) => void;
}) {
  return (
    <div className="sim-override">
      <button
        type="button"
        className="sim-override-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? "▾" : "▸"} 覆盖参数（不填走默认）
      </button>
      {expanded && (
        <div className="sim-override-fields" role="group" aria-label="软仿覆盖参数">
          <label className="sim-field">
            <span>振荡器类型</span>
            <select
              value={form.oscillator ?? ""}
              onChange={(event) =>
                onChange({
                  ...form,
                  oscillator:
                    event.target.value === ""
                      ? undefined
                      : (event.target.value as "Constant" | "Random"),
                })
              }
            >
              <option value="">默认</option>
              <option value="Constant">Constant</option>
              <option value="Random">Random</option>
            </select>
          </label>
          <label className="sim-field">
            <span>漂移幅度（ppm）</span>
            <input
              type="number"
              inputMode="decimal"
              value={form.driftPpm ?? ""}
              onChange={(event) =>
                onChange({
                  ...form,
                  driftPpm: event.target.value === "" ? undefined : Number(event.target.value),
                })
              }
            />
          </label>
          <label className="sim-field">
            <span>仿真时长（s）</span>
            <input
              type="number"
              inputMode="decimal"
              value={form.simTimeS ?? ""}
              onChange={(event) =>
                onChange({
                  ...form,
                  simTimeS: event.target.value === "" ? undefined : Number(event.target.value),
                })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

/** U11/U13：结果区三态（初始引导 / 运行中 / 有结果），结果区下方挂解释折叠区。 */
function SimResultArea({
  simState,
  explainState,
  explainFailed,
  onExplain,
}: {
  simState: SimUiState;
  explainState: { status: "idle" } | { status: "running" } | { status: "done"; text: string };
  explainFailed: boolean;
  onExplain: (result: SimResult) => void;
}) {
  if (simState.status === "idle") {
    return <div className="empty-panel mono">点软仿运行后在此查看</div>;
  }
  if (simState.status === "running") {
    return <div className="empty-panel mono">仿真进行中…</div>;
  }
  if (simState.status === "error") {
    return (
      <p className="transfer-notice error" role="alert">
        软仿失败：{simState.message}
      </p>
    );
  }

  const result = simState.result;
  const converged = isFullyConverged(result);
  // 空结果/失败状态绝不渲染成全绿（R10）：只有 converged 才展示绿色总判定。
  const showResultTable = result.status === "converged" && result.perNode.length > 0;
  const showExplain = hasNonConvergedNode(result);

  return (
    <div className="sim-result">
      <div
        className={converged ? "sim-overall converged" : "sim-overall warn"}
        role="status"
        aria-label="软仿总判定"
      >
        {result.overall}
      </div>
      {result.message && !showResultTable && <p className="sim-message mono">{result.message}</p>}
      {showResultTable && (
        <table className="eng-table sim-table">
          <thead>
            <tr>
              <th>从节点</th>
              <th>稳态 max|offset|</th>
              <th>mean|offset|</th>
              <th>收敛</th>
              <th>参考线</th>
            </tr>
          </thead>
          <tbody>
            {result.perNode.map((node) => (
              <tr key={node.mid}>
                <td>{node.mid}</td>
                <td>{node.maxOffsetNs.toFixed(1)} ns</td>
                <td>{node.meanOffsetNs.toFixed(1)} ns</td>
                <td>
                  <span className={node.converged ? "sim-badge ok" : "sim-badge bad"}>
                    {node.converged ? "收敛" : "未收敛"}
                  </span>
                </td>
                <td className="mono">{node.withinThreshold ? "内" : "外"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showExplain && (
        <div className="sim-explain">
          <button
            type="button"
            className="btn"
            disabled={explainState.status === "running"}
            onClick={() => onExplain(result)}
          >
            {explainState.status === "running"
              ? "生成中…"
              : explainState.status === "done"
                ? "重新解释"
                : "解释"}
          </button>
          {explainFailed && (
            <p className="transfer-notice error" role="alert">
              解释生成失败，可重试
            </p>
          )}
          {explainState.status === "done" && (
            <div className="sim-explain-body" role="region" aria-label="软仿解释">
              {explainState.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
