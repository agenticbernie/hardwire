import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, apiDownload, apiRequest } from "./api.ts";
import {
  criterionViews,
  formatBytes,
  formatDate,
  formatDuration,
  formatMoney,
  isRunActive,
  mergeCriterionViews,
  outcomeLabel,
  safeWorkflowUrl,
  stateLabel,
  timeRemaining,
  type CriterionView,
  verifiedAcceptanceOutcome,
} from "./domain.ts";

type RecordValue = Record<string, unknown>;
type SessionData = { founder: { id: string }; csrfToken: string; expiresAt: string };
type Project = RecordValue;
type Task = RecordValue;
type Run = RecordValue;

type CriterionDraft = {
  id: string;
  required: boolean;
  text: string;
  evidence: string[];
};

type TaskDraft = {
  objective: string;
  allowedPaths: string;
  timeoutSeconds: number;
  maxRepairRounds: number;
  maxUsd: number;
  criteria: CriterionDraft[];
};

const pinnedCommit = "f8db05d9dd573fb49941ffa510e3d4e9ba66cfbc";
const defaultTask: TaskDraft = {
  objective: "Đổi thời gian mỗi lượt của Gunny Arcade thành 30 giây. Kiểm tra hết giờ có chuyển lượt đúng không; các thao tác chỉnh góc, chỉnh lực và bắn vẫn hoạt động; màn hình hiển thị đúng, không bị lỗi vẽ chồng trong các trạng thái được thử.",
  allowedPaths: "include/world.h\nsrc/game.cpp\nsrc/display_ui.cpp\nsrc/main.cpp",
  timeoutSeconds: 1800,
  maxRepairRounds: 3,
  maxUsd: 1,
  criteria: [
    { id: "turn-timeout", required: true, text: "Khi hết 30 giây, lượt chuyển sang người chơi tiếp theo.", evidence: ["serial_log"] },
    { id: "controls-fire", required: true, text: "Nút chỉnh góc, chỉnh lực và bắn vẫn hoạt động.", evidence: ["serial_log"] },
    { id: "tft-state", required: true, text: "Màn hình TFT hiển thị đúng người chơi, góc, lực và thời gian ở các trạng thái được thử.", evidence: ["screenshot"] },
    { id: "tft-no-overlap", required: true, text: "Không có chữ hoặc đối tượng vẽ chồng ngoài dự kiến trong các trạng thái được thử.", evidence: ["screenshot"] },
  ],
};

function idOf(value: RecordValue | undefined): string {
  return String(value?.id ?? value?.projectId ?? value?.taskId ?? value?.runId ?? "");
}

function taskVersion(task: Task | undefined): number {
  return Number(task?.taskVersion ?? task?.version ?? 0);
}

function asArray(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.filter((entry): entry is RecordValue => Boolean(entry) && typeof entry === "object") : [];
}

function isVerifiedCheckpoint(artifact: RecordValue): boolean {
  return artifact.kind === "checkpoint"
    && typeof artifact.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(artifact.sha256)
    && Number.isInteger(artifact.byteSize)
    && Number(artifact.byteSize) > 0;
}

function latestByVersion(tasks: Task[]): Task | undefined {
  return [...tasks].sort((a, b) => taskVersion(b) - taskVersion(a))[0];
}

function defaultDraftFromTask(task: Task | undefined): TaskDraft {
  if (!task) return { ...defaultTask, criteria: defaultTask.criteria.map((criterion) => ({ ...criterion, evidence: [...criterion.evidence] })) };
  const limits = task.limits && typeof task.limits === "object" ? task.limits as RecordValue : {};
  const criteria = asArray(task.criteria).map((criterion, index) => ({
    id: String(criterion.id ?? "criterion-" + (index + 1)),
    required: criterion.required !== false,
    text: String(criterion.text ?? ""),
    evidence: Array.isArray(criterion.evidence) ? criterion.evidence.filter((item): item is string => typeof item === "string") : ["report"],
  }));
  return {
    objective: String(task.objective ?? ""),
    allowedPaths: Array.isArray(task.allowedPaths) ? task.allowedPaths.join("\n") : "",
    timeoutSeconds: Number(limits.timeoutSeconds ?? 1800),
    maxRepairRounds: Number(limits.maxRepairRounds ?? 3),
    maxUsd: Number(limits.maxUsd ?? 1),
    criteria: criteria.length ? criteria : defaultTask.criteria.map((criterion) => ({ ...criterion, evidence: [...criterion.evidence] })),
  };
}

function pathsFromDraft(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((path) => path.trim()).filter(Boolean))];
}

function activeRunFor(project: RecordValue | null): Run | undefined {
  const runs = asArray(project?.runs);
  return runs.find((run) => isRunActive(run.executionState));
}

function fileName(value: unknown, fallback: string): string {
  const path = typeof value === "string" ? value : "";
  const leaf = path.split("/").pop();
  return leaf && /^[a-zA-Z0-9_.-]+$/.test(leaf) ? leaf : fallback;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Đã xảy ra lỗi. Hãy thử lại.";
}

function dispatchLabel(value: unknown): string {
  const labels: Record<string, string> = {
    attached: "Đã gắn workflow",
    pending_reconciliation: "Chờ đồng bộ",
  };
  return labels[String(value)] ?? "Chưa xác định";
}

function workflowLabel(value: unknown): string {
  const labels: Record<string, string> = {
    queued: "Đang chờ runner",
    requested: "Đã gửi yêu cầu",
    waiting: "Đang chờ",
    in_progress: "Đang chạy",
    completed: "Đã kết thúc",
  };
  return labels[String(value)] ?? "Chưa xác định";
}

function blockerLabel(value: string): string {
  const labels: Record<string, string> = {
    missing_secret: "Thiếu cấu hình bảo mật",
    service_unavailable: "Dịch vụ không khả dụng",
    quota_exhausted: "Đã hết hạn mức dịch vụ",
    timeout: "Hết thời gian chờ",
    runner_lost: "Runner bị gián đoạn",
    invalid_evidence: "Bằng chứng không hợp lệ",
    dispatch_unknown: "Chưa xác định được trạng thái gửi workflow",
    workflow_persistence_failed: "Chưa lưu được định danh workflow",
  };
  return labels[value] ?? value.replaceAll("_", " ");
}

function App() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectData, setProjectData] = useState<RecordValue | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectReloadNonce, setProjectReloadNonce] = useState(0);
  const [projectError, setProjectError] = useState("");
  const [page, setPage] = useState<"projects" | "usage">("projects");
  const [runId, setRunId] = useState("");
  const [runSnapshot, setRunSnapshot] = useState<RecordValue | null>(null);
  const [runError, setRunError] = useState("");
  const [runLoading, setRunLoading] = useState(false);
  const [runRefreshNonce, setRunRefreshNonce] = useState(0);
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(() => defaultDraftFromTask(undefined));
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [runStarting, setRunStarting] = useState(false);
  const [runCanceling, setRunCanceling] = useState(false);
  const [runResuming, setRunResuming] = useState(false);
  const [actionError, setActionError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [createName, setCreateName] = useState("Gunny Arcade");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [usage, setUsage] = useState<RecordValue | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState("");
  const startKeyRef = useRef<{ revision: string; key: string } | null>(null);
  const resumeKeyRef = useRef<{ scope: string; key: string } | null>(null);

  const refreshProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError("");
    try {
      const data = await apiRequest<{ projects?: Project[] }>("/api/projects");
      const next = Array.isArray(data.projects) ? data.projects : [];
      setProjects(next);
      if (!projectId && next.length) setProjectId(idOf(next[0]));
    } catch (error) {
      setProjectsError(messageFor(error));
    } finally {
      setProjectsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let current = true;
    apiRequest<SessionData>("/api/auth/session")
      .then((value) => { if (current) { setSession(value); setAuthError(""); } })
      .catch((error: unknown) => {
        if (!current) return;
        if (error instanceof ApiError && error.status === 401) setSession(null);
        else setAuthError(messageFor(error));
      })
      .finally(() => { if (current) setAuthLoading(false); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (session) void refreshProjects();
  }, [session, refreshProjects]);

  useEffect(() => {
    if (!session || !projectId) {
      setProjectData(null);
      return;
    }
    let current = true;
    setProjectLoading(true);
    setProjectError("");
    apiRequest<RecordValue>("/api/projects/" + encodeURIComponent(projectId))
      .then((value) => {
        if (!current) return;
        setProjectData(value);
        const runs = asArray(value.runs);
        const active = runs.find((run) => isRunActive(run.executionState));
        const newest = active ?? runs[0];
        setRunId(newest ? idOf(newest) : "");
        setRunSnapshot(null);
        setTaskDraft(defaultDraftFromTask(latestByVersion(asArray(value.tasks))));
      })
      .catch((error: unknown) => { if (current) setProjectError(messageFor(error)); })
      .finally(() => { if (current) setProjectLoading(false); });
    return () => { current = false; };
  }, [session, projectId, projectReloadNonce]);

  useEffect(() => {
    if (!session || !runId) {
      setRunSnapshot(null);
      return;
    }
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestController: AbortController | undefined;
    const poll = async () => {
      requestController = new AbortController();
      setRunLoading(true);
      try {
        const value = await apiRequest<RecordValue>("/api/runs/" + encodeURIComponent(runId), { signal: requestController.signal });
        if (!current) return;
        setRunSnapshot(value);
        setRunError("");
        const run = value.run && typeof value.run === "object" ? value.run as RecordValue : {};
        if (isRunActive(run.executionState)) timer = setTimeout(() => { void poll(); }, 4000);
      } catch (error) {
        if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
        setRunError(messageFor(error));
        timer = setTimeout(() => { void poll(); }, 8000);
      } finally {
        if (current) setRunLoading(false);
      }
    };
    void poll();
    return () => {
      current = false;
      if (timer) clearTimeout(timer);
      requestController?.abort();
    };
  }, [session, runId, runRefreshNonce]);

  const project = useMemo(() => asArray(projectData?.project ? [projectData.project] : [])[0] ?? null, [projectData]);
  const tasks = asArray(projectData?.tasks);
  const currentTask = latestByVersion(tasks);
  const projectRuns = asArray(projectData?.runs);
  const activeRun = activeRunFor(projectData);
  const run = runSnapshot?.run && typeof runSnapshot.run === "object" ? runSnapshot.run as RecordValue : projectRuns.find((item) => idOf(item) === runId);
  const taskForRun = tasks.find((task) => taskVersion(task) === Number(run?.taskVersion)) ?? currentTask;
  const artifacts = asArray(runSnapshot?.artifacts);
  const criteria = mergeCriterionViews(criterionViews(taskForRun?.criteria), criterionViews(runSnapshot?.criteria));
  const runWorkflow = safeWorkflowUrl(run?.workflowUrl);
  const approved = Boolean(currentTask?.approvedAt);
  const approvalHash = typeof currentTask?.approvalHash === "string" ? currentTask.approvalHash : "";
  const version = taskVersion(currentTask);
  const draftIsDirty = Boolean(currentTask) && JSON.stringify(taskDraft) !== JSON.stringify(defaultDraftFromTask(currentTask));

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    const password = new FormData(event.currentTarget).get("password");
    try {
      const value = await apiRequest<SessionData>("/api/auth/login", { method: "POST", body: { password } });
      setSession(value);
    } catch (error) {
      setAuthError(messageFor(error));
    }
  }

  async function handleLogout() {
    if (!session) return;
    try {
      await apiRequest<void>("/api/auth/logout", { method: "POST", csrfToken: session.csrfToken });
      setSession(null);
      setProjects([]);
      setProjectId("");
      setProjectData(null);
    } catch (error) {
      setActionError(messageFor(error));
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setCreateBusy(true);
    setCreateError("");
    try {
      const value = await apiRequest<{ project?: Project }>("/api/projects", {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { name: createName.trim(), source: { kind: "gunny-snapshot", commit: pinnedCommit } },
      });
      const created = value.project;
      const createdId = created ? idOf(created) : "";
      await refreshProjects();
      if (createdId) setProjectId(createdId);
      setPage("projects");
    } catch (error) {
      setCreateError(messageFor(error));
    } finally {
      setCreateBusy(false);
    }
  }

  async function importProject(file: File | undefined) {
    if (!session || !file) return;
    setImportMessage("");
    if (!file.name.toLowerCase().endsWith(".hardwire.zip")) {
      setImportMessage("Chọn đúng một gói có đuôi .hardwire.zip.");
      return;
    }
    if (file.size > 32 * 1024 * 1024) {
      setImportMessage("Gói vượt giới hạn 32 MB.");
      return;
    }
    setImportBusy(true);
    const form = new FormData();
    form.append("file", file);
    try {
      const value = await apiRequest<{ project?: Project }>("/api/projects/import", { method: "POST", body: form, csrfToken: session.csrfToken });
      const importedId = value.project ? idOf(value.project) : "";
      setImportMessage("Đã kiểm tra và nhập gói. Code chưa được chạy.");
      await refreshProjects();
      if (importedId) setProjectId(importedId);
      setPage("projects");
    } catch (error) {
      setImportMessage(messageFor(error));
    } finally {
      setImportBusy(false);
    }
  }

  async function saveTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !projectId) return;
    if (taskDraft.criteria.some((criterion) => criterion.evidence.length === 0)) {
      setTaskError("Mỗi tiêu chí cần ít nhất một loại bằng chứng.");
      return;
    }
    setTaskSaving(true);
    setTaskError("");
    setActionError("");
    const body = {
      objective: taskDraft.objective.trim(),
      allowedPaths: pathsFromDraft(taskDraft.allowedPaths),
      limits: {
        timeoutSeconds: Number(taskDraft.timeoutSeconds),
        maxRepairRounds: Number(taskDraft.maxRepairRounds),
        maxUsd: Number(taskDraft.maxUsd),
      },
      criteria: taskDraft.criteria.map((criterion) => ({
        ...criterion,
        id: criterion.id.trim(),
        text: criterion.text.trim(),
        evidence: criterion.evidence,
      })),
    };
    try {
      const value = currentTask
        ? await apiRequest<{ task?: Task }>("/api/tasks/" + encodeURIComponent(idOf(currentTask)) + "/revisions", { method: "POST", body, csrfToken: session.csrfToken })
        : await apiRequest<{ task?: Task }>("/api/projects/" + encodeURIComponent(projectId) + "/tasks", {
            method: "POST",
            csrfToken: session.csrfToken,
            body: { ...body, version: 1 },
          });
      await reloadProject();
      if (value.task) setTaskDraft(defaultDraftFromTask(value.task));
    } catch (error) {
      setTaskError(messageFor(error));
    } finally {
      setTaskSaving(false);
    }
  }

  async function approveTask() {
    if (!session || !currentTask || !approvalHash || !version || draftIsDirty) return;
    setApprovalBusy(true);
    setActionError("");
    try {
      await apiRequest<{ task: Task }>("/api/tasks/" + encodeURIComponent(idOf(currentTask)) + "/approve", {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { version, approvalHash },
      });
      await reloadProject();
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setApprovalBusy(false);
    }
  }

  async function startRun() {
    if (!session || !currentTask || !approvalHash || !version) return;
    setRunStarting(true);
    setActionError("");
    try {
      const idempotencyKey = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : "hw-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      const revisionKey = idOf(currentTask) + ":" + version;
      const stableKey = startKeyRef.current?.revision === revisionKey ? startKeyRef.current.key : idempotencyKey;
      startKeyRef.current = { revision: revisionKey, key: stableKey };
      const value = await apiRequest<{ run?: Run; dispatch?: RecordValue }>("/api/tasks/" + encodeURIComponent(idOf(currentTask)) + "/runs", {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { version, approvalHash, idempotencyKey: stableKey },
      });
      if (value.run) {
        const nextId = idOf(value.run);
        setRunId(nextId);
        setRunSnapshot(null);
      }
      if (value.dispatch?.status === "pending_reconciliation") {
        setActionError("Yêu cầu đã được lưu nhưng trạng thái workflow cần đồng bộ. Không tạo lần chạy mới.");
      }
      await reloadProject();
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setRunStarting(false);
    }
  }

  async function cancelRun() {
    if (!session || !runId) return;
    setRunCanceling(true);
    setActionError("");
    try {
      await apiRequest("/api/runs/" + encodeURIComponent(runId) + "/cancel", { method: "POST", csrfToken: session.csrfToken, body: {} });
      setRunError("");
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setRunCanceling(false);
    }
  }

  async function resumeRun() {
    if (!session || !runId) return;
    const checkpoint = artifactsForCurrentRun().find(isVerifiedCheckpoint);
    if (!checkpoint) {
      setActionError("Không tìm thấy checkpoint đã xác minh. Phiên này không thể tiếp tục an toàn.");
      return;
    }
    const confirmed = window.confirm("Tiếp tục phiên " + runId + " từ checkpoint đã xác minh?\n\nHardwire sẽ tạo runner mới và dùng trạng thái checkpoint đã lưu. Các bước chưa hoàn tất có thể được chạy lại; lịch sử và bằng chứng cũ được giữ nguyên.");
    if (!confirmed) return;
    setRunResuming(true);
    setActionError("");
    const sequence = runSnapshot?.lastSequence ?? "unknown";
    const scope = runId + ":" + String(sequence);
    const generatedKey = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : "hw-resume-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    const idempotencyKey = resumeKeyRef.current?.scope === scope ? resumeKeyRef.current.key : generatedKey;
    resumeKeyRef.current = { scope, key: idempotencyKey };
    try {
      const value = await apiRequest<{ run?: Run; dispatch?: RecordValue }>("/api/runs/" + encodeURIComponent(runId) + "/resume", {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { idempotencyKey },
      });
      if (value.run) setRunSnapshot({ run: value.run, dispatch: value.dispatch, lastSequence: sequence });
      if (value.dispatch?.status === "pending_reconciliation") {
        setActionError("Checkpoint đã được chấp nhận, nhưng workflow cần đồng bộ. Không gửi yêu cầu tiếp tục mới.");
      }
      setRunRefreshNonce((nonce) => nonce + 1);
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setRunResuming(false);
    }
  }

  function artifactsForCurrentRun(): RecordValue[] {
    return asArray(runSnapshot?.artifacts);
  }

  async function exportProject() {
    if (!session || !projectId) return;
    setExportBusy(true);
    setExportMessage("");
    try {
      const value = await apiRequest<{ export?: RecordValue }>("/api/projects/" + encodeURIComponent(projectId) + "/export", {
        method: "POST",
        csrfToken: session.csrfToken,
        body: {},
      });
      const item = value.export;
      if (!item || typeof item.downloadPath !== "string") throw new Error("Dịch vụ chưa trả đường dẫn tải gói.");
      const blob = await apiDownload(item.downloadPath);
      saveBlob(blob, (project?.name ? String(project.name) : "hardwire-project") + ".hardwire.zip");
      setExportMessage("Đã tạo và tải gói export.");
    } catch (error) {
      setExportMessage(messageFor(error));
    } finally {
      setExportBusy(false);
    }
  }

  async function loadUsage() {
    setPage("usage");
    setUsageLoading(true);
    setUsageError("");
    try {
      setUsage(await apiRequest<RecordValue>("/api/usage"));
    } catch (error) {
      setUsageError(messageFor(error));
    } finally {
      setUsageLoading(false);
    }
  }

  function updateCriterion(index: number, patch: Partial<CriterionDraft>) {
    setTaskDraft((current) => ({
      ...current,
      criteria: current.criteria.map((criterion, currentIndex) => currentIndex === index ? { ...criterion, ...patch } : criterion),
    }));
  }

  if (authLoading) return <Splash message="Đang xác thực phiên làm việc…" />;
  if (!session) return <LoginScreen error={authError} onSubmit={handleLogin} />;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Bỏ qua điều hướng</a>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <p className="brand-name">HARDWIRE</p>
            <p className="brand-caption">PRODUCT LAB <span>·</span> FOUNDER EDITION</p>
          </div>
        </div>
        <div className="topbar-right">
          <div className="session-chip"><span className="status-dot" /> PHIÊN FOUNDER</div>
          <button className="quiet-button" type="button" onClick={() => void handleLogout()}>Đăng xuất</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label="Điều hướng chính">
          <div className="sidebar-kicker">WORKSPACE <span>01</span></div>
          <button aria-label="Dự án" className={"nav-item " + (page === "projects" ? "is-active" : "")} type="button" onClick={() => setPage("projects")}>
            <span className="nav-index">01</span><span>Dự án</span><span className="nav-count">{projects.length}</span>
          </button>
          <button aria-label="Mức sử dụng" className={"nav-item " + (page === "usage" ? "is-active" : "")} type="button" onClick={() => void loadUsage()}>
            <span className="nav-index">02</span><span>Mức sử dụng</span>
          </button>
          <div className="sidebar-rule" />
          <p className="sidebar-kicker">ĐANG LÀM VIỆC</p>
          {projects.slice(0, 4).map((item) => {
            const id = idOf(item);
            return (
              <button key={id} type="button" className={"project-nav " + (projectId === id ? "is-current" : "")} onClick={() => { setPage("projects"); setProjectId(id); }}>
                <span className="project-nav-led" /><span className="project-nav-name">{String(item.name ?? "Dự án")}</span>
              </button>
            );
          })}
          <div className="sidebar-foot">
            <div className="signal-label"><span className="signal-bars"><i /><i /><i /></span> PRIVATE WORKSPACE</div>
            <p>Dữ liệu phiên được lưu tối đa 72 giờ. Export gói dự án để giữ bản sao.</p>
          </div>
        </aside>

        <main id="main-content" className="main-content">
          {page === "usage" ? (
            <UsagePage usage={usage} loading={usageLoading} error={usageError} onRefresh={() => void loadUsage()} />
          ) : (
            <div className="page-layout">
              <section className="project-rail" aria-label="Danh sách dự án">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">BUILDER WORKSPACE</p>
                    <h1>Dự án</h1>
                  </div>
                  <button className="icon-button" type="button" aria-label="Tải lại danh sách dự án" onClick={() => void refreshProjects()}>↻</button>
                </div>
                <div className="project-action-stack">
                  <details className="inline-disclosure">
                    <summary className="primary-button"><span aria-hidden="true">＋</span> Tạo project từ Gunny</summary>
                    <form className="compact-form" onSubmit={(event) => void createProject(event)}>
                      <label htmlFor="project-name">Tên dự án</label>
                      <input id="project-name" value={createName} onChange={(event) => setCreateName(event.target.value)} maxLength={120} required />
                      <div className="commit-note"><span>SNAPSHOT PINNED</span><code>{pinnedCommit.slice(0, 12)}</code></div>
                      {createError && <InlineNotice tone="error">{createError}</InlineNotice>}
                      <button className="dark-button full-width" type="submit" disabled={createBusy}>{createBusy ? "Đang tạo…" : "Tạo project"}</button>
                    </form>
                  </details>
                  <label className={"secondary-button import-button " + (importBusy ? "is-busy" : "")}>
                    <span aria-hidden="true">↥</span> {importBusy ? "Đang kiểm tra gói…" : "Import .hardwire.zip"}
                    <input
                      type="file"
                      accept=".hardwire.zip,application/zip"
                      aria-label="Chọn gói .hardwire.zip để import"
                      disabled={importBusy}
                      onChange={(event) => { void importProject(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }}
                    />
                  </label>
                </div>
                {importMessage && <InlineNotice tone={importMessage.startsWith("Đã") ? "success" : "neutral"}>{importMessage}</InlineNotice>}
                {projectsError && <InlineNotice tone="error">{projectsError}</InlineNotice>}
                <div className="project-list-head"><span>TÊN / SNAPSHOT</span><span>HẾT HẠN</span></div>
                {projectsLoading && projects.length === 0 ? <LoadingLine label="Đang tải dự án…" /> : null}
                {!projectsLoading && projects.length === 0 && !projectsError ? (
                  <div className="empty-projects">
                    <div className="empty-glyph" aria-hidden="true">⌁</div>
                    <p>Chưa có dự án nào</p>
                    <span>Tạo từ snapshot Gunny hoặc import một gói đã lưu.</span>
                  </div>
                ) : null}
                <div className="project-list">
                  {projects.map((item) => {
                    const id = idOf(item);
                    const source = item.source && typeof item.source === "object" ? item.source as RecordValue : {};
                    const isImported = source.kind === "import" || source.kind === "archive";
                    return (
                      <button key={id} className={"project-row " + (projectId === id ? "selected" : "")} type="button" onClick={() => setProjectId(id)}>
                        <span className="project-row-main">
                          <span className="project-status-mark" />
                          <span><strong>{String(item.name ?? "Dự án không tên")}</strong><small>{isImported ? "IMPORT" : "GUNNY ARCADE"} <span>·</span> {String(source.commit ?? "snapshot") .slice(0, 9)}</small></span>
                        </span>
                        <span className="project-expiry">{timeRemaining(item.expiresAt)}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="project-detail">
                {!projectId ? (
                  <WelcomePanel onCreate={() => document.querySelector<HTMLElement>(".inline-disclosure summary")?.click()} />
                ) : projectLoading ? (
                  <ProjectLoading />
                ) : projectError ? (
                  <ErrorPanel title="Không tải được dự án" message={projectError} onRetry={() => setProjectReloadNonce((nonce) => nonce + 1)} />
                ) : project ? (
                  <>
                    <div className="project-titlebar">
                      <div className="breadcrumb"><span>WORKSPACE</span><span className="crumb-divider">/</span><span>{String(project.name ?? "PROJECT")}</span></div>
                      <div className="titlebar-actions">
                        <span className="retention-pill"><span className="status-dot" />{timeRemaining(project.expiresAt)}</span>
                        <button className="secondary-button compact" type="button" onClick={() => void exportProject()} disabled={exportBusy}>{exportBusy ? "Đang đóng gói…" : "↓ Export"}</button>
                      </div>
                    </div>
                    {exportMessage && <InlineNotice tone={exportMessage.startsWith("Đã") ? "success" : "neutral"}>{exportMessage}</InlineNotice>}
                    <div className="project-heading">
                      <div>
                        <div className="project-title-overline"><span className="project-status-mark large" /> PROJECT / {String(project.source && typeof project.source === "object" ? (project.source as RecordValue).kind ?? "snapshot" : "snapshot").toUpperCase()}</div>
                        <h2>{String(project.name ?? "Dự án")}</h2>
                      </div>
                      <div className="project-ref"><span>SOURCE COMMIT</span><code>{String(project.source && typeof project.source === "object" ? (project.source as RecordValue).commit ?? "imported" : "imported").slice(0, 12)}</code></div>
                    </div>

                    <div className="summary-strip">
                      <SummaryCell label="TASK REVISION" value={currentTask ? "v" + version : "Chưa có"} />
                      <SummaryCell label="LƯỢT CHẠY" value={String(projectRuns.length).padStart(2, "0")} />
                      <SummaryCell label="TRẠNG THÁI" value={activeRun ? stateLabel(activeRun.executionState) : "Sẵn sàng"} />
                      <SummaryCell label="EXPIRES" value={formatDate(project.expiresAt)} />
                    </div>

                    {actionError && <InlineNotice tone="error">{actionError}</InlineNotice>}
                    <section className="task-section" aria-labelledby="task-heading">
                      <div className="section-headline">
                        <div><p className="eyebrow">01 / DEFINE THE CHANGE</p><h3 id="task-heading">{currentTask ? "Yêu cầu & tiêu chí" : "Tạo yêu cầu đầu tiên"}</h3></div>
                        {currentTask && <span className={"approval-state " + (approved && !draftIsDirty ? "approved" : "pending")}><i />{draftIsDirty ? "DRAFT CHƯA LƯU · V" + version : approved ? "ĐÃ DUYỆT · V" + version : "CHƯA DUYỆT · V" + version}</span>}
                      </div>
                      <form className="task-form" onSubmit={(event) => void saveTask(event)}>
                        <label htmlFor="task-objective">Mục tiêu</label>
                        <textarea id="task-objective" rows={3} value={taskDraft.objective} onChange={(event) => setTaskDraft((draft) => ({ ...draft, objective: event.target.value }))} maxLength={10000} required />
                        <div className="form-grid">
                          <div>
                            <label htmlFor="allowed-paths">Phạm vi file được sửa <span className="label-hint">mỗi dòng một đường dẫn</span></label>
                            <textarea id="allowed-paths" className="mono-input" rows={4} value={taskDraft.allowedPaths} onChange={(event) => setTaskDraft((draft) => ({ ...draft, allowedPaths: event.target.value }))} required />
                          </div>
                          <div className="limits-fieldset">
                            <span className="field-label">Giới hạn phiên</span>
                            <label className="inline-field" htmlFor="timeout">Timeout <span><input id="timeout" type="number" min={1} max={1800} value={taskDraft.timeoutSeconds} onChange={(event) => setTaskDraft((draft) => ({ ...draft, timeoutSeconds: Number(event.target.value) }))} /> giây</span></label>
                            <label className="inline-field" htmlFor="repairs">Số vòng sửa <span><input id="repairs" type="number" min={0} max={3} value={taskDraft.maxRepairRounds} onChange={(event) => setTaskDraft((draft) => ({ ...draft, maxRepairRounds: Number(event.target.value) }))} /></span></label>
                            <label className="inline-field" htmlFor="budget">Ngân sách dự kiến <span><input id="budget" type="number" min={0.01} max={10} step={0.01} value={taskDraft.maxUsd} onChange={(event) => setTaskDraft((draft) => ({ ...draft, maxUsd: Number(event.target.value) }))} /> USD</span></label>
                            <p className="limit-footnote">Phiên mới reserve mức này vào ngân sách PoC $10. Một yêu cầu model đang chạy vẫn có thể vượt ngưỡng trước khi usage được báo.</p>
                          </div>
                        </div>

                        <div className="criteria-editor">
                          <div className="criteria-editor-head"><div><span className="field-label">Tiêu chí nghiệm thu</span><p>Approve khóa phiên bản yêu cầu, tiêu chí và giới hạn này.</p></div><button className="text-button" type="button" onClick={() => setTaskDraft((draft) => ({ ...draft, criteria: [...draft.criteria, { id: "criterion-" + (draft.criteria.length + 1), required: true, text: "", evidence: ["report"] }] }))}>＋ Thêm tiêu chí</button></div>
                          <ol className="criteria-edit-list">
                            {taskDraft.criteria.map((criterion, index) => (
                              <li key={criterion.id + "-" + index}>
                                <span className="criterion-index">{String(index + 1).padStart(2, "0")}</span>
                                <div className="criterion-edit-body">
                                  <input aria-label={"Mã tiêu chí " + (index + 1)} className="criterion-id" value={criterion.id} onChange={(event) => updateCriterion(index, { id: event.target.value })} maxLength={80} required />
                                  <textarea aria-label={"Mô tả tiêu chí " + (index + 1)} rows={2} value={criterion.text} onChange={(event) => updateCriterion(index, { text: event.target.value })} maxLength={2000} required />
                                  <div className="criterion-edit-foot">
                                    <label className="check-label"><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(index, { required: event.target.checked })} /> Bắt buộc</label>
                                    <div className="evidence-choice">
                                      <label className="check-label"><input type="checkbox" checked={criterion.evidence.includes("serial_log")} onChange={(event) => updateCriterion(index, { evidence: event.target.checked ? [...new Set([...criterion.evidence, "serial_log"])] : criterion.evidence.filter((item) => item !== "serial_log") })} /> Serial</label>
                                      <label className="check-label"><input type="checkbox" checked={criterion.evidence.includes("screenshot")} onChange={(event) => updateCriterion(index, { evidence: event.target.checked ? [...new Set([...criterion.evidence, "screenshot"])] : criterion.evidence.filter((item) => item !== "screenshot") })} /> Ảnh TFT</label>
                                      <label className="check-label"><input type="checkbox" checked={criterion.evidence.includes("build_log")} onChange={(event) => updateCriterion(index, { evidence: event.target.checked ? [...new Set([...criterion.evidence, "build_log"])] : criterion.evidence.filter((item) => item !== "build_log") })} /> Build</label>
                                    </div>
                                    {taskDraft.criteria.length > 1 && <button className="remove-criterion" type="button" aria-label={"Xóa tiêu chí " + (index + 1)} onClick={() => setTaskDraft((draft) => ({ ...draft, criteria: draft.criteria.filter((_, currentIndex) => currentIndex !== index) }))}>×</button>}
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ol>
                        </div>
                        {taskError && <InlineNotice tone="error">{taskError}</InlineNotice>}
                        <div className="form-actions">
                          <p>{currentTask ? "Lưu thay đổi sẽ tạo revision mới chưa được duyệt." : "Tiêu chí được lưu thành revision v1."}</p>
                          <button className="dark-button" type="submit" disabled={taskSaving}>{taskSaving ? "Đang lưu revision…" : currentTask ? "Lưu revision mới" : "Lưu yêu cầu"}</button>
                        </div>
                      </form>

                      {currentTask && (
                        <div className="approval-panel">
                          <div className="approval-copy"><span className="approval-number">02</span><div><strong>Duyệt phạm vi thực thi</strong><p>{approved ? "Đã duyệt revision v" + version + ". Thay đổi tiếp theo cần một revision mới." : "Kiểm tra mục tiêu, tiêu chí và giới hạn trước khi cho phép agent chạy."}</p></div></div>
                          <div className="approval-action">
                            <div className="hash-label"><span>APPROVAL HASH</span><code title={approvalHash}>{approvalHash ? approvalHash.slice(0, 16) + "…" : "Chưa có"}</code></div>
                            <button className={approved ? "secondary-button" : "approve-button"} type="button" disabled={approved || approvalBusy || !approvalHash} onClick={() => void approveTask()}>{approvalBusy ? "Đang duyệt…" : approved ? "Đã duyệt" : "Approve revision"}</button>
                          </div>
                        </div>
                      )}
                    </section>

                    {currentTask && (
                      <RunPanel
                        task={taskForRun ?? currentTask}
                        run={run}
                        snapshot={runSnapshot}
                        criteria={criteria}
                        artifacts={artifacts}
                        runError={runError}
                        runLoading={runLoading}
                        runStarting={runStarting}
                        runCanceling={runCanceling}
                        runResuming={runResuming}
                        approved={approved && !draftIsDirty}
                        activeRun={Boolean(activeRun)}
                        workflowUrl={runWorkflow}
                        onStart={() => void startRun()}
                        onCancel={() => void cancelRun()}
                        onResume={() => void resumeRun()}
                        onRefresh={() => setRunRefreshNonce((nonce) => nonce + 1)}
                      />
                    )}
                  </>
                ) : (
                  <WelcomePanel onCreate={() => document.querySelector<HTMLElement>(".inline-disclosure summary")?.click()} />
                )}
              </section>
            </div>
          )}
        </main>
      </div>
      <footer className="app-footer"><span>HARDWIRE / POC 0.1</span><span>BUILD · SIMULATE · VERIFY</span><span>PRIVATE BY DEFAULT</span></footer>
    </div>
  );

  async function reloadProject(): Promise<void> {
    await refreshProjects();
    if (!projectId) return;
    const value = await apiRequest<RecordValue>("/api/projects/" + encodeURIComponent(projectId));
    setProjectData(value);
  }
}

function Splash({ message }: { message: string }) {
  return <main className="splash"><div className="brand-mark" aria-hidden="true"><span /><span /><span /></div><p>{message}</p></main>;
}

function LoginScreen({ error, onSubmit }: { error: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <main className="login-screen">
      <div className="login-grid">
        <section className="login-story">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
            <div><p className="brand-name">HARDWIRE</p><p className="brand-caption">PRODUCT LAB <span>·</span> FOUNDER EDITION</p></div>
          </div>
          <div className="login-message">
            <p className="eyebrow">BUILDERS DESERVE A CLOSED LOOP</p>
            <h1>Từ một thay đổi nhỏ<br />đến bằng chứng<br /><em>có thể kiểm tra.</em></h1>
            <p className="login-description">Agent sửa firmware. Runner build và mô phỏng. Hardwire gom log, ảnh và kết luận theo từng tiêu chí.</p>
          </div>
          <div className="login-steps"><span>01 / DEFINE</span><i /><span>02 / EXECUTE</span><i /><span>03 / VERIFY</span></div>
        </section>
        <section className="login-form-panel">
          <div className="form-corner">ACCESS / 001</div>
          <div className="login-form-content">
            <p className="eyebrow">FOUNDER ACCESS</p>
            <h2>Đăng nhập</h2>
            <p>Workspace riêng cho phiên thử nghiệm Hardwire PoC.</p>
            <form onSubmit={onSubmit}>
              <label htmlFor="founder-password">Mật khẩu founder</label>
              <input id="founder-password" name="password" type="password" autoComplete="current-password" required autoFocus />
              {error && <InlineNotice tone="error">{error}</InlineNotice>}
              <button className="dark-button full-width" type="submit">Mở workspace <span aria-hidden="true">↗</span></button>
            </form>
            <div className="login-security"><span className="lock-icon" aria-hidden="true">▣</span><span>Phiên được bảo vệ bằng cookie bảo mật và xác thực yêu cầu.</span></div>
          </div>
          <div className="form-bottom-note">NO PUBLIC SIGNUP <span>·</span> SINGLE FOUNDER ACCOUNT</div>
        </section>
      </div>
    </main>
  );
}

function WelcomePanel({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="welcome-panel">
      <span className="welcome-index">HW / 001</span>
      <div className="welcome-art" aria-hidden="true"><span className="art-orbit orbit-one" /><span className="art-orbit orbit-two" /><span className="art-core">H</span><span className="art-cross cross-a" /><span className="art-cross cross-b" /></div>
      <p className="eyebrow">A CONTROLLED BUILD LOOP</p>
      <h2>Mỗi thay đổi<br />đều để lại <em>bằng chứng.</em></h2>
      <p className="welcome-copy">Tạo project từ snapshot Gunny Arcade để bắt đầu yêu cầu, duyệt tiêu chí và chạy vòng build–mô phỏng đầu tiên.</p>
      <button className="dark-button" type="button" onClick={onCreate}>Tạo project thử nghiệm <span aria-hidden="true">↗</span></button>
    </div>
  );
}

function ProjectLoading() {
  return <div className="project-loading"><div className="loading-sweep" /><p>Đang nạp project snapshot…</p><span>METADATA / TASK HISTORY / RUNS</span></div>;
}

function ErrorPanel({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return <section className="error-panel" role="alert"><p className="eyebrow">REQUEST FAILED</p><h2>{title}</h2><p>{message}</p><button className="secondary-button" type="button" onClick={onRetry}>Thử tải lại</button></section>;
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return <div className="summary-cell"><span>{label}</span><strong>{value}</strong></div>;
}

function InlineNotice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "error" | "success" }) {
  return <div className={"inline-notice " + tone} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

function LoadingLine({ label }: { label: string }) {
  return <div className="loading-line"><span className="spinner" />{label}</div>;
}

function RunPanel(props: {
  task: Task;
  run?: Run;
  snapshot: RecordValue | null;
  criteria: CriterionView[];
  artifacts: RecordValue[];
  runError: string;
  runLoading: boolean;
  runStarting: boolean;
  runCanceling: boolean;
  runResuming: boolean;
  approved: boolean;
  activeRun: boolean;
  workflowUrl: string | null;
  onStart: () => void;
  onCancel: () => void;
  onResume: () => void;
  onRefresh: () => void;
}) {
  const { task, run, snapshot, criteria, artifacts } = props;
  const runState = run?.executionState;
  const execution = stateLabel(runState);
  const outcome = verifiedAcceptanceOutcome(criteria, run?.acceptanceOutcome);
  const summary = typeof run?.summary === "string" ? run.summary : "";
  const usage = snapshot?.usage && typeof snapshot.usage === "object" ? snapshot.usage as RecordValue : {};
  const dispatch = snapshot?.dispatch && typeof snapshot.dispatch === "object" ? snapshot.dispatch as RecordValue : {};
  const workflow = snapshot?.workflow && typeof snapshot.workflow === "object" ? snapshot.workflow as RecordValue : {};
  const limits = snapshot?.limits && typeof snapshot.limits === "object" ? snapshot.limits as RecordValue : {};
  const attempts = asArray(snapshot?.attempts);
  const reasonText = typeof run?.reason === "string"
    ? run.reason
    : run?.reason && typeof run.reason === "object"
      ? String((run.reason as RecordValue).code ?? (run.reason as RecordValue).message ?? "Chưa có mô tả")
      : "";
  const inputTokens = Number(usage.inputTokens ?? usage.promptTokens);
  const outputTokens = Number(usage.outputTokens ?? usage.completionTokens);
  const cost = usage.reportedCostUsd ?? usage.estimatedCostUsd ?? usage.costUsd;
  const costMeasured = usage.providerUsageMeasured === true;
  const runIsActive = isRunActive(runState);
  const checkpointAvailable = artifacts.some(isVerifiedCheckpoint);
  const steps = ["queued", "preparing", "coding", "building", "simulating", "evaluating"];
  const currentStep = Math.max(0, steps.indexOf(String(runState)));
  const evidenceUrl = (artifact: RecordValue) => String(artifact.downloadPath ?? (artifact.artifactId || artifact.id ? "/api/artifacts/" + encodeURIComponent(String(artifact.artifactId ?? artifact.id)) : ""));

  return (
    <section className="run-section" aria-labelledby="run-heading">
      <div className="section-headline">
        <div><p className="eyebrow">03 / EXECUTE & VERIFY</p><h3 id="run-heading">Phiên thực thi</h3></div>
        {run && <span role="status" aria-live="polite" aria-atomic="true" className={"run-state-badge " + (runIsActive ? "running" : outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : "inconclusive")}><i />{execution.toUpperCase()}</span>}
      </div>

      {!run ? (
        <div className="run-empty">
          <div className="run-empty-mark" aria-hidden="true">↗</div>
          <div><strong>Chưa có phiên chạy</strong><p>Approve revision v{taskVersion(task)} để kích hoạt workflow build, mô phỏng và kiểm chứng.</p></div>
          <button className="approve-button" type="button" disabled={!props.approved || props.activeRun || props.runStarting} onClick={props.onStart}>{props.runStarting ? "Đang khởi chạy…" : props.activeRun ? "Đang có phiên hoạt động" : "Bắt đầu chạy"}</button>
        </div>
      ) : (
        <>
          <div className="run-toolbar">
            <div className="run-identity"><span>RUN ID</span><code>{String(run.runId ?? run.id ?? "—")}</code></div>
            <div className="run-toolbar-actions">
              {props.workflowUrl && <a className="quiet-link" href={props.workflowUrl} target="_blank" rel="noreferrer">GitHub Actions ↗</a>}
              <button className="text-button" type="button" onClick={props.onRefresh} aria-label="Làm mới trạng thái phiên">↻ Làm mới</button>
              {runState === "interrupted" && (
                <button className="secondary-button compact" type="button" onClick={props.onResume} disabled={!checkpointAvailable || props.runResuming}>
                  {props.runResuming ? "Đang tiếp tục…" : "Tiếp tục từ checkpoint đã xác minh"}
                </button>
              )}
              {runIsActive && <button className="cancel-button" type="button" onClick={props.onCancel} disabled={props.runCanceling}>{props.runCanceling ? "Đang gửi yêu cầu…" : "Hủy phiên"}</button>}
            </div>
          </div>
          <div className={"run-state-card " + (runIsActive ? "is-running" : "")}>
            <div className="run-state-symbol" aria-hidden="true">{runIsActive ? <span className="pulse-dot" /> : outcome === "passed" ? "✓" : outcome === "failed" ? "!" : "?"}</div>
            <div className="run-state-copy">
              <div className="run-state-title">{runIsActive ? execution : "Kết quả: " + outcomeLabel(outcome)}</div>
              <p>{summary || (runIsActive ? "Runner cập nhật trạng thái và checkpoint theo từng bước." : "Workflow đã kết thúc. Kết luận nghiệm thu được đánh giá riêng với trạng thái thực thi.")}</p>
            </div>
            <span className={"outcome-chip " + (outcome === "passed" ? "good" : outcome === "failed" ? "bad" : "unknown")}>{outcomeLabel(outcome).toUpperCase()}</span>
          </div>

          {runIsActive && (
            <div className="progress-track" role="group" aria-label={"Tiến độ: " + execution}>
              {steps.map((step, index) => (
                <div key={step} className={"progress-step " + (index < currentStep ? "done" : index === currentStep ? "current" : "")}>
                  <span className="progress-node">{index < currentStep ? "✓" : String(index + 1).padStart(2, "0")}</span>
                  <span>{stateLabel(step)}</span>
                </div>
              ))}
              {runState === "repairing" && <div className="repair-indicator"><span className="spinner" /> Đang sửa · vòng {String(run.attempt ?? "—")}</div>}
              {runState === "needs_decision" && <div className="repair-indicator decision">Cần quyết định từ founder</div>}
            </div>
          )}
          {!runIsActive && (
            <div className="terminal-strip">
              <span><b>Thực thi</b> {execution}</span><span><b>Nghiệm thu</b> {outcomeLabel(outcome)}</span>
              {typeof dispatch.status === "string" && <span><b>Workflow</b> {dispatchLabel(dispatch.status)} <code>({dispatch.status})</code></span>}
              {typeof workflow.status === "string" && <span><b>GitHub Actions</b> {workflowLabel(workflow.status)} <code>({workflow.status})</code></span>}
            </div>
          )}

          {props.runError && <InlineNotice tone="error">{props.runError}</InlineNotice>}
          {runState === "needs_decision" && <InlineNotice tone="neutral">Phiên đang chờ quyết định. Nếu không phản hồi trong 24 giờ, kết quả sẽ kết thúc ở trạng thái chưa đủ bằng chứng.</InlineNotice>}
          {runState === "interrupted" && <InlineNotice tone={checkpointAvailable ? "neutral" : "error"}>{checkpointAvailable ? "Có checkpoint đã xác minh. Tiếp tục sẽ tạo workflow mới từ trạng thái gần nhất đã lưu." : "Không có checkpoint đã xác minh; không thể tiếp tục phiên này."}</InlineNotice>}
          {runState === "failed" && <InlineNotice tone="error">Lỗi thực thi/hạ tầng không đồng nghĩa lỗi sản phẩm. Kết quả nghiệm thu cần dựa trên bằng chứng có sẵn.</InlineNotice>}
          {reasonText && <InlineNotice tone={runState === "failed" ? "error" : "neutral"}>Blocker / lý do dừng: {blockerLabel(reasonText)} <code>({reasonText})</code></InlineNotice>}

          <div className="metrics-grid">
            <Metric label="OPENAI TOKENS" value={Number.isFinite(inputTokens) || Number.isFinite(outputTokens) ? (Number.isFinite(inputTokens) ? inputTokens.toLocaleString("vi-VN") : "—") + " in / " + (Number.isFinite(outputTokens) ? outputTokens.toLocaleString("vi-VN") : "—") + " out" : "Chưa có số đo"} />
            <Metric label="CHI PHÍ" value={!costMeasured || cost === undefined || cost === null ? "Chưa có số đo" : formatMoney(cost)} footnote={costMeasured ? "OpenCode báo cáo; không phải hóa đơn" : "chưa nhận usage từ model"} />
            <Metric label="WOKWI" value={usage.wokwiSeconds === undefined ? "Chưa có số đo" : formatDuration(usage.wokwiSeconds)} />
            <Metric label="GITHUB ACTIONS" value={usage.githubActionsSeconds === undefined ? "Chưa có số đo" : formatDuration(usage.githubActionsSeconds)} />
            <Metric label="EVIDENCE BYTES" value={usage.artifactBytes === undefined ? "Chưa có số đo" : formatBytes(usage.artifactBytes)} />
            <Metric label="ATTEMPTS" value={attempts.length ? String(attempts.length) + " lượt" : String(run.attempt ?? "—")} footnote="tối đa 1 triển khai + 3 vòng sửa" />
          </div>
          <div className="budget-note"><span aria-hidden="true">i</span><p>{String(limits.message ?? "Hard cap chi phí OpenAI chưa được xác minh; số token và chi phí được hiển thị theo dữ liệu runner báo về.")}</p></div>
          {attempts.length > 0 && (
            <div className="attempt-list" aria-label="Lịch sử lượt triển khai và sửa">
              <div className="attempt-list-heading"><span>ATTEMPT HISTORY</span><span>{attempts.length} LƯỢT</span></div>
              {attempts.map((attempt, index) => (
                <div className="attempt-row" key={String(attempt.attempt ?? index)}>
                  <strong>{Number(attempt.attempt ?? index + 1) === 1 ? "Triển khai" : "Sửa vòng " + String(Number(attempt.attempt ?? index + 1) - 1)}</strong>
                  <span>{stateLabel(attempt.executionState)}</span>
                  <code>{String(attempt.sourceHash ?? "").slice(0, 12) || "Chưa có source hash"}</code>
                  <small>{formatDate(attempt.startedAt)} → {formatDate(attempt.finishedAt)}</small>
                </div>
              ))}
            </div>
          )}

          <div className="results-heading"><div><p className="eyebrow">ACCEPTANCE / REVISION V{taskVersion(task)}</p><h4>Kết quả theo tiêu chí</h4></div><span>{criteria.length} TIÊU CHÍ</span></div>
          {criteria.length === 0 ? (
            <div className="evidence-empty">Chưa có dữ liệu tiêu chí từ runner. Kết quả hiện tại không được xem là đạt.</div>
          ) : (
            <div className="criterion-results">
              {criteria.map((criterion) => {
                const result = String(criterion.outcome);
                const linked = artifacts.filter((artifact) => criterion.evidenceIds.includes(String(artifact.artifactId ?? artifact.id)));
                return (
                  <article className="criterion-result" key={criterion.id}>
                    <div className={"criterion-result-mark " + result}>{result === "passed" ? "✓" : result === "failed" ? "×" : "?"}</div>
                    <div className="criterion-result-copy"><div className="criterion-result-title"><strong>{criterion.label}</strong><span className={"result-label " + result}>{outcomeLabel(result)}</span></div><p>{criterion.explanation}</p>
                      {linked.length > 0 && <div className="criterion-evidence-links">{linked.map((artifact) => <a key={String(artifact.artifactId ?? artifact.id)} href={evidenceUrl(artifact)}>{String(artifact.kind ?? "evidence")} ↗</a>)}</div>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          <div className="evidence-heading"><div><p className="eyebrow">TRACEABLE FILES</p><h4>Bằng chứng của phiên</h4></div><span>{artifacts.length} FILE{artifacts.length === 1 ? "" : "S"}</span></div>
          {artifacts.length === 0 ? (
            <div className="evidence-empty"><span className="empty-evidence-mark">□</span><span>Chưa có bằng chứng được lưu. Ảnh/log còn thiếu được hiển thị là chưa đủ bằng chứng.</span></div>
          ) : (
            <div className="artifact-list">
              {artifacts.map((artifact, index) => {
                const path = evidenceUrl(artifact);
                const kind = String(artifact.kind ?? "artifact");
                const name = fileName(artifact.fileName ?? artifact.path ?? kind + "-" + (index + 1), kind + "-" + (index + 1));
                const isImage = kind === "screenshot" || artifact.mediaType === "image/png";
                return (
                  <article className="artifact-card" key={String(artifact.artifactId ?? artifact.id ?? index)}>
                    {isImage ? <ArtifactPreview path={path} alt={"Ảnh TFT " + name} /> : <div className={"artifact-kind-icon " + kind} aria-hidden="true">{kind === "serial_log" ? "≋" : kind === "diff" ? "±" : kind === "build_log" ? "⌘" : "▤"}</div>}
                    <div className="artifact-info"><strong>{name}</strong><span>{kind.replaceAll("_", " ")} · {formatBytes(artifact.byteSize)} · {String(artifact.sha256 ?? "").slice(0, 10)}</span><small>Attempt {String(artifact.attempt ?? "—")} · {String(artifact.testCaseId ?? "test case —")} · {formatDate(artifact.capturedAt)}</small></div>
                    {path && <a className="artifact-download" href={path} aria-label={"Tải " + name} download>↓</a>}
                  </article>
                );
              })}
            </div>
          )}

          <div className="run-meta-grid">
            <div><span>CREATED</span><strong>{formatDate(run.createdAt ?? run.startedAt)}</strong></div>
            <div><span>FINISHED</span><strong>{formatDate(run.endedAt ?? run.finishedAt)}</strong></div>
            <div><span>EXPIRES</span><strong>{timeRemaining(run.expiresAt)}</strong></div>
            <div><span>LAST EVENT SEQUENCE</span><strong>{String(snapshot?.lastSequence ?? "—")}</strong></div>
          </div>
          {props.runLoading && <div className="polling-indicator"><span className="spinner" /> Đang đồng bộ trạng thái phiên</div>}
        </>
      )}
      {!run && props.runError && <InlineNotice tone="error">{props.runError}</InlineNotice>}
      {!props.approved && !run && <p className="run-prerequisite">Cần approve một revision trước khi bắt đầu chạy.</p>}
      {props.activeRun && !run && <p className="run-prerequisite">Đang có một phiên hoạt động trong workspace. Hệ thống chỉ cho phép một nhiệm vụ tại một thời điểm.</p>}
      {!props.approved && run && <p className="run-prerequisite">Phiên này dùng revision đã lưu; mọi chỉnh sửa hiện tại cần được lưu và duyệt thành revision mới.</p>}
    </section>
  );
}

function Metric({ label, value, footnote }: { label: string; value: string; footnote?: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong>{footnote && <small>{footnote}</small>}</div>;
}

function ArtifactPreview({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    let objectUrl = "";
    if (!path) {
      setError("Thiếu đường dẫn ảnh.");
      return;
    }
    apiDownload(path)
      .then((blob) => {
        if (!current) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        setError("");
      })
      .catch((reason: unknown) => { if (current) setError(messageFor(reason)); });
    return () => {
      current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return <div className="artifact-preview">{src ? <img src={src} alt={alt} /> : <span>{error || "Đang tải ảnh…"}</span>}</div>;
}

function UsagePage({ usage, loading, error, onRefresh }: { usage: RecordValue | null; loading: boolean; error: string; onRefresh: () => void }) {
  const totals = usage?.totals && typeof usage.totals === "object" ? usage.totals as RecordValue : usage ?? {};
  const runs = asArray(usage?.runs);
  const hardCapVerified = usage?.hardDollarCapVerified === true;
  const budget = usage?.budget && typeof usage.budget === "object" ? usage.budget as RecordValue : {};
  const budgetRemaining = budget.measuredRemainingUsd ?? totals.pocBudgetRemainingUsd;
  const costMeasured = totals.providerUsageMeasured === true && typeof totals.reportedCostUsd === "number";
  return (
    <section className="usage-page">
      <div className="usage-title-row"><div><p className="eyebrow">POC / RESOURCE LEDGER</p><h1>Mức sử dụng</h1><p className="usage-intro">Số đo được runner và dịch vụ báo về theo phiên. Giá trị ước tính được gắn nhãn riêng.</p></div><button className="secondary-button" type="button" onClick={onRefresh}>↻ Làm mới</button></div>
      {!hardCapVerified && <div className="usage-callout"><span>!</span><p><strong>Ngân sách PoC $10: còn {budgetRemaining === undefined ? "chưa đủ số đo" : formatMoney(budgetRemaining)} theo usage đã báo.</strong> Hệ thống chỉ nhận phiên mới khi mức dùng đo được cộng <code>maxUsd</code> đã duyệt không vượt $10. Một yêu cầu model đang chạy có thể vượt ngưỡng trước khi usage được báo; đây chưa phải hard cap theo hóa đơn.</p></div>}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {loading && <LoadingLine label="Đang tải usage ledger…" />}
      <div className="usage-grid">
        <Metric label="OPENAI INPUT TOKENS" value={totals.inputTokens === undefined ? "Chưa có số đo" : Number(totals.inputTokens).toLocaleString("vi-VN")} />
        <Metric label="OPENAI OUTPUT TOKENS" value={totals.outputTokens === undefined ? "Chưa có số đo" : Number(totals.outputTokens).toLocaleString("vi-VN")} />
        <Metric label="CHI PHÍ THEO OPENCODE" value={costMeasured ? formatMoney(totals.reportedCostUsd) : "Chưa có số đo"} footnote={costMeasured ? "OpenCode báo cáo; không phải hóa đơn" : "chưa nhận usage từ model"} />
        <Metric label="POC BUDGET REMAINING" value={budgetRemaining === undefined ? "Chưa có số đo" : formatMoney(budgetRemaining)} footnote="dựa trên usage đã đo" />
        <Metric label="RUNS STARTED" value={totals.runCount === undefined ? "Chưa có số đo" : String(totals.runCount)} footnote="tổng PoC, kể cả phiên đã hết hạn" />
        <Metric label="WOKWI TIME" value={totals.wokwiSeconds === undefined ? "Chưa có số đo" : formatDuration(totals.wokwiSeconds)} />
        <Metric label="ACTIONS TIME" value={totals.githubActionsSeconds === undefined ? "Chưa có số đo" : formatDuration(totals.githubActionsSeconds)} />
        <Metric label="ARTIFACT DATA" value={totals.artifactBytes === undefined ? "Chưa có số đo" : formatBytes(totals.artifactBytes)} />
      </div>
      <div className="results-heading"><div><p className="eyebrow">RUN BY RUN</p><h2>Chi tiết phiên</h2></div><span>{runs.length} RUNS</span></div>
      {runs.length === 0 ? <div className="evidence-empty">Chưa có dữ liệu mức sử dụng từ phiên chạy.</div> : (
        <div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>RUN</th><th>STATE</th><th>INPUT / OUTPUT</th><th>COST</th><th>WOKWI</th><th>ACTIONS</th><th>BYTES</th></tr></thead>
          <tbody>{runs.map((run, index) => {
            const runUsage = run.usage && typeof run.usage === "object" ? run.usage as RecordValue : run;
            const runCost = runUsage.providerUsageMeasured === true ? formatMoney(runUsage.reportedCostUsd ?? runUsage.estimatedCostUsd) : "Chưa đo";
            return <tr key={String(run.runId ?? run.id ?? index)}><td><code>{String(run.runId ?? run.id ?? "—")}</code></td><td>{stateLabel(run.executionState)}</td><td>{String(runUsage.inputTokens ?? "—")} / {String(runUsage.outputTokens ?? "—")}</td><td>{runCost}</td><td>{runUsage.wokwiSeconds === undefined ? "—" : formatDuration(runUsage.wokwiSeconds)}</td><td>{runUsage.githubActionsSeconds === undefined ? "—" : formatDuration(runUsage.githubActionsSeconds)}</td><td>{formatBytes(runUsage.artifactBytes)}</td></tr>;
          })}</tbody>
        </table></div>
      )}
    </section>
  );
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default App;
