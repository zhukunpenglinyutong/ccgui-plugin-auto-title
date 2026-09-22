/** 插件自带文案（不经宿主 i18n），按 ctx.host.locale 选择。 */

export interface Copy {
  chipOn: string;
  chipPaused: string;
  chipNaming: string;
  chipError: string;
  chipHint: string;
  chipWeb: string;
  cmdTogglePause: string;
  cmdToggleResume: string;
  cmdNameRecent: string;
  menuRename: string;
  settingsLabel: string;
  statusActive: string;
  statusActiveOnce: string;
  statusPaused: string;
  statusWeb: string;
  badgeRunning: string;
  badgePaused: string;
  lastErrorPrefix: string;
  lastDonePrefix: string;
  lastDoneKept: string;
  backendAvailable: string;
  backendMissing: string;
  deepseekReady: string;
  deepseekNoKey: string;
  /** `{ok}`/`{total}` 占位符，代码侧替换。 */
  backendsSummary: string;
  stepStatus: string;
  stepBackend: string;
  stepCredentials: string;
  stepBehavior: string;
  credsConfigured: string;
  credsMissing: string;
  backendField: string;
  modelField: string;
  modelOptional: string;
  modelPlaceholder: string;
  apiKeyField: string;
  apiKeyHint: string;
  keyShow: string;
  keyHide: string;
  policyOnceTitle: string;
  policyOnceDesc: string;
  policyFollowTitle: string;
  policyFollowDesc: string;
  testBtn: string;
  testing: string;
  testOkPrefix: string;
  testFailPrefix: string;
  hint: string;
}

const ZH: Copy = {
  chipOn: "✨ 自动命名",
  chipPaused: "⏸ 命名已暂停",
  chipNaming: "⏳ 命名中…",
  chipError: "⚠️ 命名失败",
  chipHint: "点击打开自动命名设置",
  chipWeb: "自动命名（仅桌面）",
  cmdTogglePause: "自动命名：暂停",
  cmdToggleResume: "自动命名：恢复",
  cmdNameRecent: "自动命名：立即命名最近会话",
  menuRename: "✨ 重新命名（自动命名）",
  settingsLabel: "自动命名",
  statusActive: "运行中——每轮对话结束后自动评估标题（codex / omp / pi / claude）",
  statusActiveOnce: "运行中——每个会话在首次实质对话后命名一次（codex / omp / pi / claude）",
  statusPaused: "已暂停——用 ⌘K 命令「自动命名：暂停/恢复」继续",
  statusWeb: "浏览器端不可用：命名依赖本机 CLI，请在桌面端使用",
  badgeRunning: "运行中",
  badgePaused: "已暂停",
  lastErrorPrefix: "最近命名失败",
  lastDonePrefix: "最近命名",
  lastDoneKept: "保持现有标题",
  backendAvailable: "可用",
  backendMissing: "未检测到",
  deepseekReady: "已配置密钥",
  deepseekNoKey: "未配置密钥",
  backendsSummary: "{ok}/{total} 个后端可用",
  stepStatus: "运行状态",
  stepBackend: "命名后端",
  stepCredentials: "API 凭据",
  stepBehavior: "行为与验证",
  credsConfigured: "DeepSeek API Key 已配置",
  credsMissing: "DeepSeek API Key 未配置",
  backendField: "后端",
  modelField: "模型",
  modelOptional: "可选，留空用默认",
  modelPlaceholder: "留空用默认：claude=haiku，deepseek=deepseek-chat，其他=CLI 默认",
  apiKeyField: "DeepSeek API Key",
  apiKeyHint: "明文存于本机插件存储，只发往 api.deepseek.com。",
  keyShow: "显示密钥",
  keyHide: "隐藏密钥",
  policyOnceTitle: "只命名一次（推荐）",
  policyOnceDesc: "首次有实质内容时命名，不消耗额外 token。",
  policyFollowTitle: "跟随话题演进重命名",
  policyFollowDesc: "每轮结束重新评估，消耗命名模型 token；手动改名的会话不覆盖。",
  testBtn: "测试连接",
  testing: "测试中…",
  testOkPrefix: "连接成功，返回：",
  testFailPrefix: "连接失败：",
  hint: "codex 标题写 session_index.jsonl，omp/pi/claude 写宿主 custom_title（omp/pi 同时改写转录 title 行）；聚焦窗口或再聊一轮后显示。你在宿主里手动改名的会话不会被覆盖。",
};

const EN: Copy = {
  chipOn: "✨ Auto-title",
  chipPaused: "⏸ Auto-title paused",
  chipNaming: "⏳ Naming…",
  chipError: "⚠️ Naming failed",
  chipHint: "Click to open auto-title settings",
  chipWeb: "Auto-title (desktop only)",
  cmdTogglePause: "Auto-title: Pause",
  cmdToggleResume: "Auto-title: Resume",
  cmdNameRecent: "Auto-title: Name most recent session now",
  menuRename: "✨ Re-name (auto-title)",
  settingsLabel: "Auto-title",
  statusActive: "Running — titles are evaluated after every turn (codex / omp / pi / claude)",
  statusActiveOnce: "Running — each session is named once, after its first substantive turn (codex / omp / pi / claude)",
  statusPaused: "Paused — resume with the ⌘K command “Auto-title: Pause/Resume”",
  statusWeb: "Unavailable in the browser client: naming needs local CLIs, use the desktop app",
  badgeRunning: "Running",
  badgePaused: "Paused",
  lastErrorPrefix: "Last naming failure",
  lastDonePrefix: "Last naming",
  lastDoneKept: "kept the existing title",
  backendAvailable: "available",
  backendMissing: "not found",
  deepseekReady: "key configured",
  deepseekNoKey: "no key configured",
  backendsSummary: "{ok}/{total} backends available",
  stepStatus: "Status",
  stepBackend: "Naming backend",
  stepCredentials: "API credentials",
  stepBehavior: "Behavior & verification",
  credsConfigured: "DeepSeek API key configured",
  credsMissing: "DeepSeek API key not configured",
  backendField: "Backend",
  modelField: "Model",
  modelOptional: "optional, empty = default",
  modelPlaceholder: "Empty = default: claude→haiku, deepseek→deepseek-chat, others→CLI default",
  apiKeyField: "DeepSeek API Key",
  apiKeyHint: "Stored locally in plugin storage (plaintext); sent only to api.deepseek.com.",
  keyShow: "Show key",
  keyHide: "Hide key",
  policyOnceTitle: "Name once (recommended)",
  policyOnceDesc: "Names after the first substantive turn; no extra token cost.",
  policyFollowTitle: "Rename as the topic evolves",
  policyFollowDesc: "Re-evaluates after every turn (costs naming-model tokens); manually renamed sessions are never overwritten.",
  testBtn: "Test connection",
  testing: "Testing…",
  testOkPrefix: "Connected, reply: ",
  testFailPrefix: "Failed: ",
  hint: "codex titles go to session_index.jsonl; omp/pi/claude go to the host's custom_title (omp/pi also rewrite the transcript title line). Visible after window focus or the next turn. Sessions you renamed manually are never overwritten.",
};

export function copy(locale: string): Copy {
  return locale.toLowerCase().startsWith("zh") ? ZH : EN;
}
