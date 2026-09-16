/**
 * 核心命名引擎：usage://updated（一轮结束）→ 防抖 → 读会话快照 →
 * CLI 模型评估 keep/rename → 按引擎写入标题通道。
 *
 * 通道：codex 写 session_index.jsonl（宿主 codex_titles::sync 同步）；
 * omp/pi/claude 写 app.db custom_title（侧栏/标签页 customTitle || title，
 * omp/pi 同时就地改写转录行首 title 行）。手动改名的会话本来就靠
 * custom_title 优先显示；为避免覆盖用户手改标题，db 已有 custom_title
 * 且不是我们写的会话不动（见 known 判断 + currentTitle 语义）。
 */
import type { PluginContext } from "./ccgui-plugin";
import { BACKEND_DEFAULT_MODEL, runBackend, type BackendId } from "./backends";
import { runHelper, type ApplyResult, type Snapshot } from "./helper";
import { buildPrompt, parseCandidate } from "./prompt";

/** 与 oil-codex-title 一致的确定性跳过集：寒暄不构成命名证据。 */
const TRIVIAL: Record<string, true> = {
  "": true, 你好: true, 您好: true, hi: true, hello: true, 嗨: true,
  谢谢: true, 好的: true, 好: true, ok: true, 收到: true, 继续: true, 嗯: true,
};

const SUPPORTED_ENGINES: Record<string, true> = { codex: true, omp: true, pi: true, claude: true };

export interface SessionState {
  engine: string;
  title: string;
  reason: string;
  pinned: boolean;
  /** 上次命名时看到的消息条数；只有新消息才重新评估。 */
  lastCount: number;
  at: number;
}

export interface Config {
  enabled: boolean;
  backend: BackendId;
  model: string;
  /** deepseek（OpenAI 兼容 HTTP）后端的密钥；CLI 后端不用。 */
  apiKey: string;
  updateExisting: boolean;
}

const CONFIG_DEFAULTS: Config = {
  enabled: true,
  backend: "claude",
  model: "",
  apiKey: "",
  updateExisting: true,
};

/** 已命名会话登记表（单 key，超界裁剪，storage 无列 key 能力）。 */
const NAMED_KEY = "named";
const NAMED_CAP = 200;
const PAUSED_KEY = "paused";

export class Namer {
  /** 最近有 usage 事件的会话，供「立即命名最近会话」命令使用。 */
  lastActive: { engine: string; sid: string } | null = null;
  paused = false;
  /** 队列里正有一个命名在跑（含 CLI/HTTP 调用），状态栏 chip 据此显示进度。 */
  busy = false;
  /** 最近一次命名失败（设置页展示）；下一次成功命名时清除。 */
  lastError: { message: string; engine: string; sid: string; at: number } | null = null;
  /** 最近一次完成的评估结果（设置页展示）；静默跳过不产生结果。 */
  lastDone: { kind: "renamed" | "kept" | "healed"; title: string; at: number } | null = null;
  named: Record<string, SessionState> = {};
  /** 内部变更通知（状态栏/设置页刷新用），不是宿主事件总线话题。 */
  private listeners = new Set<() => void>();
  private timers = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private ctx: PluginContext) {}

  async init(): Promise<void> {
    this.paused = (await this.ctx.storage.get<boolean>(PAUSED_KEY)) ?? false;
    const stored = (await this.ctx.storage.get<Record<string, SessionState>>(NAMED_KEY)) ?? {};
    // v0.1.0 → v0.2.0 迁移：裸 sessionId 键补 codex 前缀。
    this.named = Object.fromEntries(
      Object.entries(stored).map(([key, value]) =>
        key.includes("/") ? [key, value] : [`codex/${key}`, { ...value, engine: "codex" }],
      ),
    );
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of [...this.listeners]) cb();
  }

  async config(): Promise<Config> {
    return {
      enabled: (await this.ctx.storage.get<boolean>("config.enabled")) ?? CONFIG_DEFAULTS.enabled,
      backend: (await this.ctx.storage.get<BackendId>("config.backend")) ?? CONFIG_DEFAULTS.backend,
      model: (await this.ctx.storage.get<string>("config.model")) ?? CONFIG_DEFAULTS.model,
      apiKey: (await this.ctx.storage.get<string>("config.apiKey")) ?? CONFIG_DEFAULTS.apiKey,
      updateExisting:
        (await this.ctx.storage.get<boolean>("config.updateExisting")) ??
        CONFIG_DEFAULTS.updateExisting,
    };
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    await this.ctx.storage.set(PAUSED_KEY, paused);
    this.notify();
  }

  /** 设置页表单写配置；config() 每次现读 storage，无需额外通知命名链路。 */
  async setConfig(patch: {
    backend?: BackendId;
    model?: string;
    apiKey?: string;
    updateExisting?: boolean;
  }): Promise<void> {
    if (patch.backend !== undefined) await this.ctx.storage.set("config.backend", patch.backend);
    if (patch.model !== undefined) await this.ctx.storage.set("config.model", patch.model);
    if (patch.apiKey !== undefined) await this.ctx.storage.set("config.apiKey", patch.apiKey);
    if (patch.updateExisting !== undefined)
      await this.ctx.storage.set("config.updateExisting", patch.updateExisting);
    this.notify();
  }

  private async saveNamed(key: string, state: SessionState): Promise<void> {
    const entries = Object.entries({ ...this.named, [key]: state });
    entries.sort((a, b) => b[1].at - a[1].at);
    this.named = Object.fromEntries(entries.slice(0, NAMED_CAP));
    await this.ctx.storage.set(NAMED_KEY, this.named);
    this.notify();
  }

  /** usage://updated 回调：按会话防抖合并一轮内的多条 usage 事件。 */
  onUsage(data: unknown): void {
    const event = data as { engine?: string; sessionId?: string | null };
    if (!event?.engine || !SUPPORTED_ENGINES[event.engine] || !event.sessionId) return;
    const { engine, sessionId: sid } = event;
    this.lastActive = { engine, sid };
    const timerKey = `${engine}/${sid}`;
    clearTimeout(this.timers.get(timerKey));
    // 8s 防抖：等这一轮的 usage 事件都到齐，也避免打断仍在进行的对话。
    this.timers.set(
      timerKey,
      window.setTimeout(() => {
        this.timers.delete(timerKey);
        this.enqueue(engine, sid);
      }, 8_000),
    );
  }

  /** 串行队列：一次只跑一个命名（CLI 调用是重资源），晚到的任务排队。
   *  force（命令/设置页手动触发）绕过 lastCount 与 updateExisting 闸门，
   *  但不动固定标题的会话。 */
  enqueue(engine: string, sid: string, force = false): void {
    this.queue = this.queue.then(async () => {
      this.busy = true;
      this.notify();
      try {
        await this.nameSession(engine, sid, force);
      } catch (error) {
        this.fail(error, engine, sid);
      } finally {
        this.busy = false;
        this.notify();
      }
    });
  }

  private setDone(kind: "renamed" | "kept" | "healed", title: string): void {
    this.lastDone = { kind, title, at: Date.now() };
    this.notify();
  }
  /** 失败既进 console（排障），也落到 lastError（设置页可见）。 */
  private fail(error: unknown, engine: string, sid: string): void {
    console.error("[auto-title] naming failed:", error);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    this.lastError = { message, engine, sid, at: Date.now() };
    this.notify();
  }

  /** 一次成功的模型评估（含 keep）或补写后清除旧错误。 */
  private clearError(): void {
    if (!this.lastError) return;
    this.lastError = null;
    this.notify();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async nameSession(engine: string, sid: string, force: boolean): Promise<void> {
    const config = await this.config();
    if (!config.enabled || this.paused) return;
    const key = `${engine}/${sid}`;
    const known = this.named[key];
    if (known?.pinned) return;

    const snap = await runHelper<Snapshot>(this.ctx.bridge.invoke, ["snapshot", engine, sid]);
    if (!snap.found || snap.turns.length === 0) return;
    // 已有 custom_title 但不是我们命名的（named 里查不到）= 用户手动改的，不覆盖。
    if (!known && snap.custom_name) return;
    // 我们命名之后 custom_title 又变了 = 用户后来手动改过，让位并固定。
    if (known && snap.custom_name && snap.custom_name !== known.title) {
      await this.saveNamed(key, {
        ...known,
        title: snap.custom_name,
        pinned: true,
        lastCount: snap.turns.length,
        at: Date.now(),
      });
      return;
    }
    // 我们写过标题、但 custom_title 没了且显示名已不是我们的标题
    // = 宿主会话行被删除重建（omp 删除后重载会丢 custom_title）。直接补写
    // 登记表里的标题，不问模型——否则 currentTitle 带着旧标题，模型判 keep，
    // keep 路径不写库，标题永久丢失。须在 lastCount 闸门之前：没有新消息
    // 也要修复。codex 走文件通道不写 custom_title，排除。
    if (engine !== "codex" && known && !snap.custom_name && snap.current_name !== known.title) {
      const healed = await runHelper<ApplyResult>(this.ctx.bridge.invoke, [
        "apply",
        engine,
        sid,
        known.title,
      ]);
      if (!healed.ok || healed.rows === 0) {
        throw new Error(`补写标题失败: ${healed.error ?? "session row missing"}`);
      }
      await this.saveNamed(key, { ...known, lastCount: snap.turns.length, at: Date.now() });
      this.setDone("healed", known.title);
      return;
    }
    // 关闭「跟随话题演进」时已知会话到此为止；上面的自愈补写不调模型、
    // 零 token，不受此开关影响。
    if (known && !force && !config.updateExisting) return;
    if (known && !force && known.lastCount >= snap.turns.length) return;
    const userTexts = snap.turns.filter((t) => t.role === "user").map((t) => t.text.trim());
    if (userTexts.length === 0 || userTexts.every((t) => TRIVIAL[t.toLowerCase()])) return;

    const leaf = snap.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    const projectHint = /^[\w .-]{1,64}$/.test(leaf) ? leaf : "";
    const currentTitle = known?.title ?? snap.current_name ?? userTexts[0]?.slice(0, 40) ?? null;
    const conflicting = [
      ...new Set([
        ...Object.values(this.named).map((s) => s.title),
        ...snap.existing_names,
      ]),
    ].filter((t) => t && t !== currentTitle).slice(0, 100);

    const raw = await runBackend(
      this.ctx.bridge.invoke,
      config.backend,
      config.model.trim() || BACKEND_DEFAULT_MODEL[config.backend],
      config.apiKey.trim(),
      buildPrompt({
        recent_turns: snap.turns,
        current_title: currentTitle,
        project_hint: projectHint,
        conflicting_titles: conflicting,
      }),
    );
    const candidate = parseCandidate(raw);
    if (!candidate) throw new Error("命名模型未返回合法 JSON");
    this.clearError();
    if (candidate.action === "keep") {
      // keep 也推进 lastCount：同一批消息不重复问模型。
      if (known) {
        await this.saveNamed(key, { ...known, lastCount: snap.turns.length, at: Date.now() });
      } else if (currentTitle) {
        await this.saveNamed(key, {
          engine,
          title: currentTitle,
          reason: candidate.reason,
          pinned: false,
          lastCount: snap.turns.length,
          at: Date.now(),
        });
      }
      this.setDone("kept", "");
      return;
    }
    const applied = await runHelper<ApplyResult>(this.ctx.bridge.invoke, [
      "apply",
      engine,
      sid,
      candidate.title,
    ]);
        // rows=0 = 会话行还没进 app.db（新会话未落库），ok 照样为 true；
    // 不抛错就会把登记表写下而标题永远落空。codex 走文件通道 rows 恒 0，排除。
    if (!applied.ok || (engine !== "codex" && applied.rows === 0)) {
      throw new Error(`写入标题失败: ${applied.error ?? "session row missing"}`);
    }
    await this.saveNamed(key, {
      engine,
      title: candidate.title,
      reason: candidate.reason,
      pinned: false,
      lastCount: snap.turns.length,
      at: Date.now(),
    });
    this.setDone("renamed", candidate.title);
  }
}
