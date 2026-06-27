/**
 * 时间同步面板内的平级子 tab（软件仿真 / 硬件部署）分段开关。
 *
 * 放独立文件：time-sync-panel 与 hard-deploy-panel 都用它，且后者被前者 import，
 * 抽出来避免循环依赖。两面板各自在命令栏左侧渲染本组件、右侧放各自操作（boss 定「并入操作行」）。
 */

/** 时间同步面板内的平级子 tab（boss 定平级，无 gating）。 */
export type TimesyncSubTab = "soft-sim" | "hard-deploy";

export const TIMESYNC_SUBTABS: Array<{ id: TimesyncSubTab; label: string }> = [
  { id: "soft-sim", label: "软件仿真" },
  { id: "hard-deploy", label: "硬件部署" },
];

export function TimesyncSubTabs({
  activeSubTab,
  onSelectSubTab,
}: {
  activeSubTab: TimesyncSubTab;
  onSelectSubTab: (tab: TimesyncSubTab) => void;
}) {
  return (
    <div className="timesync-subtabs" role="tablist" aria-label="时间同步阶段">
      {TIMESYNC_SUBTABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`timesync-subtab-${tab.id}`}
          aria-selected={activeSubTab === tab.id}
          aria-controls={`timesync-subpanel-${tab.id}`}
          className={activeSubTab === tab.id ? "timesync-subtab active" : "timesync-subtab"}
          onClick={() => onSelectSubTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
