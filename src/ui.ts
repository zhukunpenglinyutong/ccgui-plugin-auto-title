/**
 * 全部 UI 只经 ctx.react（宿主 React）createElement + hooks 渲染，
 * 不起第二棵 React 树——组件很小，双段挂载在这里是纯负担。
 *
 * 设置页为「引导步骤」结构（shadcn/ui new-york · zinc 视觉体系，见
 * design/auto-title-settings.html 方案 C）：状态 → 后端 → 凭据 → 行为与验证
 * 四步手风琴，已完成步骤打勾并折叠成一行摘要；重命名策略用单选卡表达。
 */
import type { PluginContext } from "./ccgui-plugin";
import type { ReactNode } from "react";
import { probeBackend, testBackend, BACKEND_DEFAULT_MODEL, BACKEND_IDS, type BackendId } from "./backends";
import type { Copy } from "./i18n";
import type { Config, Namer } from "./naming";

type React = PluginContext["react"];

function useNamerState(h: React, namer: Namer): number {
  const [tick, setTick] = h.useState(0);
  h.useEffect(() => namer.subscribe(() => setTick((n) => n + 1)), [namer]);
  return tick;
}

/** 状态栏 chip：命名中/失败/运行/暂停，点击跳转本插件设置页
 *  （暂停/恢复走 ⌘K 命令「自动命名：暂停/恢复」）。 */
export function makeStatusChip(ctx: PluginContext, namer: Namer, t: Copy) {
  const h = ctx.react;
  return function AutoTitleChip() {
    useNamerState(h, namer);
    const label = ctx.host.isWeb
      ? t.chipWeb
      : namer.busy
        ? t.chipNaming
        : namer.paused
          ? t.chipPaused
          : namer.lastError
            ? t.chipError
            : t.chipOn;
    return h.createElement(
      "button",
      {
        className: `auto-title-chip${namer.paused && !namer.busy ? " is-paused" : ""}${!namer.busy && namer.lastError ? " is-error" : ""}`,
        type: "button",
        title: namer.lastError?.message ?? t.chipHint,
        onClick: () => {
          // 浏览器端没有设置页可跳（section 提示仅桌面），点击无操作。
          if (!ctx.host.isWeb) ctx.ui.openSettings();
        },
      },
      label,
    );
  };
}

type StepId = "status" | "backend" | "creds" | "behavior";

/** 设置页 section：状态总览、后端与模型、API 凭据、重命名策略与连通性测试。 */
export function makeSettingsSection(ctx: PluginContext, namer: Namer, t: Copy) {
  const h = ctx.react;
  return function AutoTitleSettings() {
    useNamerState(h, namer);
    const [probes, setProbes] = h.useState<Record<string, boolean>>({});
    const [cfg, setCfg] = h.useState<Config | null>(null);
    const [testing, setTesting] = h.useState(false);
    const [testResult, setTestResult] = h.useState<{ ok: boolean; text: string } | null>(null);
    const [open, setOpen] = h.useState<Record<StepId, boolean>>({
      status: true,
      backend: false,
      creds: false,
      behavior: false,
    });
    const [showKey, setShowKey] = h.useState(false);

    h.useEffect(() => {
      let alive = true;
      void namer.config().then((c) => {
        if (alive) setCfg(c);
      });
      return () => {
        alive = false;
      };
    }, []);

    h.useEffect(() => {
      if (ctx.host.isWeb || !cfg) return;
      let alive = true;
      for (const id of BACKEND_IDS) {
        void probeBackend(ctx.bridge.invoke, id, cfg.apiKey).then((ok) => {
          if (alive) setProbes((prev) => ({ ...prev, [id]: ok }));
        });
      }
      return () => {
        alive = false;
      };
    }, [cfg?.apiKey]);

    if (ctx.host.isWeb) {
      return h.createElement(
        "div",
        { className: "auto-title-root" },
        h.createElement(
          "div",
          { className: "at-alert" },
          h.createElement("div", null, h.createElement("div", { className: "at-alert-title" }, t.settingsLabel), h.createElement("div", { className: "at-alert-body" }, t.statusWeb)),
        ),
      );
    }
    if (!cfg) return null;

    const statusText = namer.paused
      ? t.statusPaused
      : !cfg.updateExisting
        ? t.statusActiveOnce
        : t.statusActive;
    const isApi = cfg.backend === "deepseek";
    const okCount = BACKEND_IDS.filter((id) => probes[id]).length;

    // 配置变动后旧测试结论失效。
    const patchCfg = (patch: {
      backend?: BackendId;
      model?: string;
      apiKey?: string;
      updateExisting?: boolean;
    }) => {
      setCfg((cur) => (cur ? { ...cur, ...patch } : cur));
      setTestResult(null);
      void namer.setConfig(patch);
    };
    const runTest = () => {
      setTesting(true);
      setTestResult(null);
      testBackend(
        ctx.bridge.invoke,
        cfg.backend,
        cfg.model.trim() || BACKEND_DEFAULT_MODEL[cfg.backend],
        cfg.apiKey.trim(),
      )
        .then((text) => setTestResult({ ok: true, text }))
        .catch((error: unknown) =>
          setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) }),
        )
        .finally(() => setTesting(false));
    };
    // ctx.react 的 createElement 处理器不带事件泛型；宿主只传 React 合成事件，
    // 形状在参数上声明一次，不做运行期校验。
    type FieldEvent = { target: { value: string } };

    const chevron = h.createElement(
      "svg",
      { className: "at-chev", width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 },
      h.createElement("polyline", { points: "6 9 12 15 18 9" }),
    );

    /** 一步手风琴：头部 = 完成标记 + 标题 + 摘要 + chevron，体部展开时才渲染。 */
    const step = (id: StepId, num: number, done: boolean, title: string, sub: string, body: ReactNode) =>
      h.createElement(
        "div",
        { key: id, className: `at-step${open[id] ? " open" : ""}${done ? " done" : ""}` },
        h.createElement(
          "button",
          {
            type: "button",
            className: "at-step-head",
            onClick: () => setOpen((cur) => ({ ...cur, [id]: !cur[id] })),
          },
          h.createElement("span", { className: "at-step-num" }, done ? "✓" : String(num)),
          h.createElement(
            "span",
            { className: "at-step-text" },
            h.createElement("span", { className: "at-step-title" }, title),
            h.createElement("span", { className: "at-step-sub" }, sub),
          ),
          chevron,
        ),
        open[id] ? h.createElement("div", { className: "at-step-body" }, body) : null,
      );

    // ---------- 步骤 1：运行状态 ----------
    const lastDone = namer.lastDone;
    const lastError = namer.lastError;
    const statusBody = [
      h.createElement(
        "div",
        { key: "chips", className: "at-chips" },
        BACKEND_IDS.map((id) =>
          h.createElement(
            "span",
            { key: id, className: `at-chip${probes[id] ? " ok" : ""}` },
            h.createElement("span", { className: "at-dot" }),
            h.createElement("span", { className: "at-mono" }, id),
            id === "deepseek"
              ? `\u00a0${probes[id] === undefined ? "…" : probes[id] ? t.deepseekReady : t.deepseekNoKey}`
              : probes[id] === undefined
                ? "\u00a0…"
                : probes[id]
                  ? null
                  : `\u00a0${t.backendMissing}`,
          ),
        ),
      ),
      lastDone
        ? h.createElement(
            "div",
            { key: "done", className: "at-kv" },
            h.createElement(
              "div",
              { className: "at-kv-row" },
              h.createElement("span", { className: "at-k" }, t.lastDonePrefix),
              h.createElement(
                "span",
                { className: "at-v at-ellipsis" },
                lastDone.kind === "kept" ? t.lastDoneKept : lastDone.title,
              ),
            ),
            h.createElement(
              "div",
              { className: "at-kv-row" },
              h.createElement("span", { className: "at-k" }),
              h.createElement("span", { className: "at-small" }, new Date(lastDone.at).toLocaleString()),
            ),
          )
        : null,
      // 命名失败在后台队列里发生，用户无处可见；最近一条错误展示在这里，
      // 下一次成功命名后由 Namer 清除并 notify 刷新。
      lastError
        ? h.createElement(
            "div",
            { key: "error", className: "at-alert bad" },
            h.createElement(
              "div",
              null,
              h.createElement("div", { className: "at-alert-title" }, t.lastErrorPrefix),
              h.createElement(
                "div",
                { className: "at-alert-body" },
                `${lastError.engine}/${lastError.sid.slice(0, 8)}… · ${new Date(lastError.at).toLocaleString()} — ${lastError.message}`,
              ),
            ),
          )
        : null,
    ];

    // ---------- 步骤 2：命名后端 ----------
    const backendBody = [
      h.createElement(
        "div",
        { key: "backend", className: "at-field" },
        h.createElement("label", { className: "at-label" }, t.backendField),
        h.createElement(
          "select",
          {
            className: "at-select",
            value: cfg.backend,
            onChange: (e: FieldEvent) => patchCfg({ backend: e.target.value as BackendId }),
          },
          BACKEND_IDS.map((id) =>
            h.createElement("option", { key: id, value: id }, id === "deepseek" ? "deepseek (API)" : `${id} (CLI)`),
          ),
        ),
      ),
      h.createElement(
        "div",
        { key: "model", className: "at-field" },
        h.createElement(
          "label",
          { className: "at-label" },
          t.modelField,
          h.createElement("span", { className: "at-label-opt" }, t.modelOptional),
        ),
        h.createElement("input", {
          className: "at-input at-mono",
          type: "text",
          value: cfg.model,
          placeholder: t.modelPlaceholder,
          onChange: (e: FieldEvent) => {
            setCfg((cur) => (cur ? { ...cur, model: e.target.value } : cur));
            setTestResult(null);
          },
          onBlur: () => void namer.setConfig({ model: cfg.model }),
        }),
      ),
    ];

    // ---------- 步骤 3：API 凭据（仅 deepseek） ----------
    const credsBody = [
      h.createElement(
        "div",
        { key: "key", className: "at-field" },
        h.createElement("label", { className: "at-label" }, t.apiKeyField),
        h.createElement(
          "div",
          { className: "at-input-wrap" },
          h.createElement("input", {
            className: "at-input at-mono",
            type: showKey ? "text" : "password",
            value: cfg.apiKey,
            placeholder: "sk-…",
            onChange: (e: FieldEvent) => {
              setCfg((cur) => (cur ? { ...cur, apiKey: e.target.value } : cur));
              setTestResult(null);
            },
            onBlur: () => void namer.setConfig({ apiKey: cfg.apiKey }),
          }),
          h.createElement(
            "button",
            {
              type: "button",
              className: "at-eye",
              title: showKey ? t.keyHide : t.keyShow,
              onClick: () => setShowKey((v) => !v),
            },
            showKey ? "🙈" : "👁",
          ),
        ),
        h.createElement("p", { className: "at-field-hint" }, t.apiKeyHint),
      ),
    ];

    // ---------- 步骤 4：行为与验证 ----------
    const policyOpt = (on: boolean, value: boolean, title: string, desc: string) =>
      h.createElement(
        "button",
        {
          type: "button",
          className: `at-radio-opt${on ? " on" : ""}`,
          onClick: () => patchCfg({ updateExisting: value }),
        },
        h.createElement("span", { className: "at-radio-dot" }),
        h.createElement(
          "span",
          null,
          h.createElement("span", { className: "at-radio-title" }, title),
          h.createElement("span", { className: "at-radio-desc" }, desc),
        ),
      );
    const behaviorBody = [
      h.createElement(
        "div",
        { key: "policy", className: "at-radio-row" },
        policyOpt(!cfg.updateExisting, false, t.policyOnceTitle, t.policyOnceDesc),
        policyOpt(cfg.updateExisting, true, t.policyFollowTitle, t.policyFollowDesc),
      ),
      h.createElement("hr", { key: "sep", className: "at-sep" }),
      h.createElement(
        "div",
        { key: "test", className: "at-test" },
        h.createElement(
          "button",
          { type: "button", className: "at-btn primary", disabled: testing, onClick: runTest },
          testing
            ? [h.createElement("span", { key: "s", className: "at-spin" }), t.testing]
            : t.testBtn,
        ),
      ),
      testResult
        ? h.createElement(
            "div",
            { key: "result", className: `at-alert${testResult.ok ? " ok" : " bad"}` },
            h.createElement(
              "div",
              null,
              h.createElement(
                "div",
                { className: "at-alert-title" },
                testResult.ok ? t.testOkPrefix.trimEnd() : t.testFailPrefix.trimEnd(),
              ),
              h.createElement("div", { className: "at-alert-body" }, testResult.text),
            ),
          )
        : null,
    ];

    return h.createElement(
      "div",
      { className: "auto-title-root" },
      h.createElement(
        "div",
        { className: "at-topbar" },
        h.createElement(
          "span",
          { className: `at-badge${namer.paused ? " warn" : " ok"}` },
          h.createElement("span", { className: `at-dot${namer.paused ? "" : " pulse"}` }),
          namer.paused ? t.badgePaused : t.badgeRunning,
        ),
        h.createElement("span", { className: "at-topbar-text" }, statusText),
      ),
      step(
        "status",
        1,
        true,
        t.stepStatus,
        t.backendsSummary.replace("{ok}", String(okCount)).replace("{total}", String(BACKEND_IDS.length)),
        statusBody,
      ),
      step(
        "backend",
        2,
        true,
        t.stepBackend,
        `${cfg.backend} (${isApi ? "API" : "CLI"}) · ${cfg.model.trim() || BACKEND_DEFAULT_MODEL[cfg.backend]}`,
        backendBody,
      ),
      isApi
        ? step("creds", 3, cfg.apiKey.trim() !== "", t.stepCredentials, cfg.apiKey.trim() ? t.credsConfigured : t.credsMissing, credsBody)
        : null,
      step(
        "behavior",
        isApi ? 4 : 3,
        testResult?.ok === true,
        t.stepBehavior,
        `${cfg.updateExisting ? t.policyFollowTitle : t.policyOnceTitle}`,
        behaviorBody,
      ),
      h.createElement("p", { className: "at-foot-hint" }, t.hint),
    );
  };
}
