// Shared small UI primitives moved out of App.tsx so they can be reused
// by hooks/components in src/app/components without import cycles.
export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="stat-pill">
      <span>{label}</span>
      <strong>
        {label} {value}
      </strong>
    </span>
  );
}

export function DetailRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "未知错误";
}
