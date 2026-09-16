/**
 * 命名模型后端：claude/codex/gemini 走本机已登录的 CLI（plugin_exec_run），
 * 不接触密钥；deepseek 走 OpenAI 兼容 HTTP（plugin_http_request，
 * 须 manifest 声明 network:api.deepseek.com，密钥由用户在设置页填写，
 * 明文存于本机插件 KV）。模型输出里混有 CLI 噪音（codex exec 的横幅等），
 * 由 prompt.ts 的宽松 JSON 提取兜底。
 */

export type BackendId = "claude" | "codex" | "gemini" | "omp" | "pi" | "deepseek";

interface ExecRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface HttpResult {
  status: number;
  body: string;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface Backend {
  bin: string;
  args: (prompt: string, model: string) => string[];
}

/** config.model 为空时的缺省模型；空串 = 用 CLI 自己的默认。 */
export const BACKEND_DEFAULT_MODEL: Record<BackendId, string> = {
  claude: "haiku",
  codex: "",
  gemini: "",
  omp: "",
  pi: "",
  deepseek: "deepseek-chat",
};

// omp/pi 同一协议：print 模式 + 位置参数 prompt，stdout 即纯文本
// （"Working..." 等在 stderr）。--no-session 防止命名调用污染会话列表，
// --no-tools/extensions/skills 关掉命名用不到的开销与副作用。
const PI_FAMILY_ARGS = (prompt: string, model: string): string[] => [
  "--print",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--thinking",
  "off",
  ...(model ? ["--model", model] : []),
  prompt,
];

const BACKENDS: Record<Exclude<BackendId, "deepseek">, Backend> = {
  claude: {
    bin: "claude",
    args: (prompt, model) => [
      "-p",
      prompt,
      "--output-format",
      "text",
      ...(model ? ["--model", model] : []),
    ],
  },
  codex: {
    bin: "codex",
    args: (prompt, model) => [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      ...(model ? ["-m", model] : []),
      prompt,
    ],
  },
  gemini: {
    bin: "gemini",
    args: (prompt, model) => [...(model ? ["-m", model] : []), "-p", prompt],
  },
  omp: { bin: "omp", args: PI_FAMILY_ARGS },
  pi: { bin: "pi", args: PI_FAMILY_ARGS },
};

const BACKEND_IDS_CLI = Object.keys(BACKENDS) as BackendId[];

export const BACKEND_IDS: BackendId[] = [...BACKEND_IDS_CLI, "deepseek"];

/** 设置页「测试」按钮：最小真实调用，验证 CLI 登录态 / HTTP 密钥与模型名。 */
export async function testBackend(
  invoke: Invoke,
  backend: BackendId,
  model: string,
  apiKey: string,
): Promise<string> {
  const out = await runBackend(invoke, backend, model, apiKey, "只回复两个字：正常");
  return out.trim().slice(0, 50);
}

/** 调一次命名模型；CLI 非零退出、HTTP 非 2xx 都抛错（未安装、未登录、超时同路）。 */
export async function runBackend(
  invoke: Invoke,
  backend: BackendId,
  model: string,
  apiKey: string,
  prompt: string,
): Promise<string> {
  if (backend === "deepseek") {
    if (!apiKey) throw new Error("deepseek 后端需要先在设置页填写 API Key");
    const res = await invoke<HttpResult>("plugin_http_request", {
      method: "POST",
      url: "https://api.deepseek.com/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        // deepseek-flash 是思考模型，reasoning 也计入 max_tokens：
        // 200 会被思考吃光导致 content 为空。实测命名响应 reasoning ~1900。
        max_tokens: 4096,
        stream: false,
      }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`deepseek http ${res.status}: ${res.body.slice(0, 300)}`);
    }
    const data = JSON.parse(res.body) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text) {
      throw new Error("deepseek 响应缺少 choices[0].message.content");
    }
    return text;
  }
  const def = BACKENDS[backend];
  const res = await invoke<ExecRunResult>("plugin_exec_run", {
    bin: def.bin,
    args: def.args(prompt, model),
    timeoutMs: 120_000,
  });
  if (res.code !== 0) {
    throw new Error(`${def.bin} exited ${res.code}: ${res.stderr.slice(0, 300)}`);
  }
  return res.stdout;
}

/** 探测后端是否可用（设置页展示用）。CLI 跑 --version；deepseek 无超时参数
 *  可传，网络探测会阻塞设置页，只看密钥是否已配置。 */
export async function probeBackend(
  invoke: Invoke,
  backend: BackendId,
  apiKey = "",
): Promise<boolean> {
  if (backend === "deepseek") return apiKey.trim().length > 0;
  try {
    const res = await invoke<ExecRunResult>("plugin_exec_run", {
      bin: BACKENDS[backend].bin,
      args: ["--version"],
      timeoutMs: 30_000,
    });
    return res.code === 0;
  } catch {
    return false;
  }
}
