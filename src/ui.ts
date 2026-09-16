/**
 * 全部 UI 只经 ctx.react（宿主 React）createElement + hooks 渲染，
 * 不起第二棵 React 树——组件很小，双段挂载在这里是纯负担。
 */
import type { PluginContext } from "./ccgui-plugin";
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

/** 设置页 section：状态、后端探测、命名模型配置与连通性测试。 */
export function makeSettingsSection(ctx: PluginContext, namer: Namer, t: Copy) {
  const h = ctx.react;
  return function AutoTitleSettings() {
    useNamerState(h, namer);
    const [probes, setProbes] = h.useState<Record<string, boolean>>({});
    const [cfg, setCfg] = h.useState<Config | null>(null);
    const [testing, setTesting] = h.useState(false);
    const [testResult, setTestResult] = h.useState<{ ok: boolean; text: string } | null>(null);

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

    const statusText = ctx.host.isWeb
      ? t.statusWeb
      : namer.paused
        ? t.statusPaused
        : cfg && !cfg.updateExisting
          ? t.statusActiveOnce
          : t.statusActive;
    // 命名失败在后台队列里发生，用户无处可见；最近一条错误展示在这里，
    // 下一次成功命名后由 Namer 清除并 notify 刷新。
    const error = namer.lastError;
    const errorRow = error
      ? h.createElement(
          "p",
          { className: "auto-title-error" },
          `${t.lastErrorPrefix}（${error.engine}/${error.sid.slice(0, 8)}… ${new Date(error.at).toLocaleString()}）：${error.message}`,
        )
      : null;
    const done = namer.lastDone;
    const doneRow = done
      ? h.createElement(
          "p",
          { className: "auto-title-done" },
          done.kind === "kept"
            ? `${t.lastDonePrefix}（${new Date(done.at).toLocaleString()}）：${t.lastDoneKept}`
            : `${t.lastDonePrefix}（${new Date(done.at).toLocaleString()}）：${done.title}`,
        )
      : null;

    const backendRow = ctx.host.isWeb
      ? null
      : h.createElement(
          "div",
          { className: "auto-title-backends" },
          BACKEND_IDS.map((id) =>
            h.createElement(
              "span",
              { key: id, className: `auto-title-backend${probes[id] ? " ok" : ""}` },
              id === "deepseek"
                ? `${id}: ${probes[id] === undefined ? "…" : probes[id] ? t.deepseekReady : t.deepseekNoKey}`
                : `${id}: ${probes[id] === undefined ? "…" : probes[id] ? t.backendAvailable : t.backendMissing}`,
            ),
          ),
        );

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
      if (!cfg) return;
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
    type CheckEvent = { target: { checked: boolean } };
    const configForm =
      ctx.host.isWeb || !cfg
        ? null
        : h.createElement(
            "div",
            { className: "auto-title-config" },
            h.createElement(
              "label",
              { className: "auto-title-field" },
              h.createElement("span", null, t.backendField),
              h.createElement(
                "select",
                {
                  value: cfg.backend,
                  onChange: (e: FieldEvent) => patchCfg({ backend: e.target.value as BackendId }),
                },
                BACKEND_IDS.map((id) =>
                  h.createElement(
                    "option",
                    { key: id, value: id },
                    id === "deepseek" ? "deepseek (API)" : `${id} (CLI)`,
                  ),
                ),
              ),
            ),
            h.createElement(
              "label",
              { className: "auto-title-field" },
              h.createElement("span", null, t.modelField),
              h.createElement("input", {
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
            cfg.backend === "deepseek"
              ? h.createElement(
                  "label",
                  { className: "auto-title-field" },
                  h.createElement("span", null, t.apiKeyField),
                  h.createElement("input", {
                    type: "password",
                    value: cfg.apiKey,
                    placeholder: "sk-…",
                    onChange: (e: FieldEvent) => {
                      setCfg((cur) => (cur ? { ...cur, apiKey: e.target.value } : cur));
                      setTestResult(null);
                    },
                    onBlur: () => void namer.setConfig({ apiKey: cfg.apiKey }),
                  }),
                )
              : null,
            cfg.backend === "deepseek"
              ? h.createElement("p", { className: "auto-title-field-hint" }, t.apiKeyHint)
              : null,
            h.createElement(
              "label",
              { className: "auto-title-field" },
              h.createElement("span", null, t.updateExistingField),
              h.createElement("input", {
                type: "checkbox",
                checked: cfg.updateExisting,
                onChange: (e: CheckEvent) => patchCfg({ updateExisting: e.target.checked }),
              }),
            ),
            h.createElement("p", { className: "auto-title-field-hint" }, t.updateExistingHint),
            h.createElement(
              "div",
              { className: "auto-title-test" },
              h.createElement(
                "button",
                {
                  type: "button",
                  className: "auto-title-btn",
                  disabled: testing,
                  onClick: runTest,
                },
                testing ? t.testing : t.testBtn,
              ),
              testResult
                ? h.createElement(
                    "span",
                    { className: `auto-title-test-result${testResult.ok ? " ok" : ""}` },
                    testResult.ok
                      ? `${t.testOkPrefix}${testResult.text}`
                      : `${t.testFailPrefix}${testResult.text}`,
                  )
                : null,
            ),
          );

    return h.createElement(
      "div",
      { className: "auto-title-settings" },
      h.createElement("p", { className: "auto-title-status" }, statusText),
      backendRow,
      doneRow,
      errorRow,
      h.createElement("h4", { className: "auto-title-heading" }, t.sectionConfig),
      configForm,
      h.createElement("p", { className: "auto-title-hint" }, t.hint),
    );
  };
}
