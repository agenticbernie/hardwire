export type CriterionOutcome = "passed" | "failed" | "inconclusive";

export type CriterionView = {
  id: string;
  label: string;
  required: boolean;
  outcome: CriterionOutcome;
  explanation: string;
  evidenceIds: string[];
};

const criterionLabels: Record<string, string> = {
  "turn-timeout": "Hết giờ chuyển lượt",
  "controls-fire": "Góc, lực và bắn",
  "tft-state": "Thông tin trên màn hình TFT",
  "tft-no-overlap": "Không vẽ chồng ngoài dự kiến",
};

export function criterionViews(value: unknown): CriterionView[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const id = String(entry.criterionId ?? entry.id ?? "criterion-" + (index + 1));
    const rawOutcome = entry.outcome;
    const outcome: CriterionOutcome = rawOutcome === "passed" || rawOutcome === "failed"
      ? rawOutcome
      : "inconclusive";
    const evidenceIds = Array.isArray(entry.evidenceIds)
      ? entry.evidenceIds.filter((id): id is string => typeof id === "string")
      : [];
    return {
      id,
      label: String(entry.text ?? entry.label ?? criterionLabels[id] ?? id),
      required: entry.required !== false,
      outcome,
      explanation: typeof entry.explanation === "string"
        ? entry.explanation
        : typeof entry.result === "string"
          ? entry.result
          : "Chưa có kết luận và bằng chứng đủ để xác minh.",
      evidenceIds,
    };
  });
}

export function mergeCriterionViews(expected: CriterionView[], observed: CriterionView[]): CriterionView[] {
  if (expected.length === 0) return observed;
  const results = new Map(observed.map((criterion) => [criterion.id, criterion]));
  const merged = expected.map((criterion) => {
    const result = results.get(criterion.id);
    if (!result) return criterion;
    results.delete(criterion.id);
    return {
      ...criterion,
      outcome: result.outcome,
      explanation: result.explanation,
      evidenceIds: result.evidenceIds,
    };
  });
  return [...merged, ...results.values()];
}

export function verifiedAcceptanceOutcome(criteria: CriterionView[], reportedOutcome: unknown): CriterionOutcome {
  const required = criteria.filter((criterion) => criterion.required);
  if (required.length === 0) return "inconclusive";
  if (required.some((criterion) => criterion.outcome === "failed")) return "failed";
  if (required.some((criterion) => criterion.outcome !== "passed")) return "inconclusive";
  if (reportedOutcome === "failed") return "failed";
  return reportedOutcome === "passed" ? "passed" : "inconclusive";
}

export function isRunActive(state: unknown): boolean {
  return ["queued", "preparing", "coding", "building", "simulating", "evaluating", "repairing", "needs_decision"].includes(String(state));
}

export function stateLabel(state: unknown): string {
  const labels: Record<string, string> = {
    queued: "Đang chờ",
    preparing: "Chuẩn bị workspace",
    coding: "Đang viết code",
    building: "Đang build firmware",
    simulating: "Đang mô phỏng",
    evaluating: "Đang kiểm chứng",
    repairing: "Đang sửa lỗi",
    needs_decision: "Cần quyết định",
    completed: "Đã kết thúc",
    failed: "Lỗi hệ thống",
    cancelled: "Đã hủy",
    interrupted: "Bị gián đoạn",
  };
  return labels[String(state)] ?? "Chưa xác định";
}

export function outcomeLabel(outcome: unknown): string {
  if (outcome === "passed") return "Đạt";
  if (outcome === "failed") return "Chưa đạt";
  return "Chưa đủ bằng chứng";
}

export function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function formatMoney(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "Chưa có số đo";
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(amount);
}

export function formatDuration(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return Math.round(seconds) + " giây";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return minutes + " phút " + String(remaining).padStart(2, "0") + " giây";
}

export function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function timeRemaining(value: unknown, now = Date.now()): string {
  if (typeof value !== "string" || !value) return "Chưa xác định";
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt)) return "Chưa xác định";
  const seconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  if (seconds === 0) return "Đã hết hạn";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? "Còn " + hours + " giờ " + minutes + " phút" : "Còn " + minutes + " phút";
}

export function safeWorkflowUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.href : null;
  } catch {
    return null;
  }
}
