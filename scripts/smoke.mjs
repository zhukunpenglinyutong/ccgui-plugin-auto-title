// 开发冒烟脚本（不随插件发布）：用真实数据验证三引擎的
// snapshot / apply 与命名后端 + JSON 解析。
// 用法：node --experimental-strip-types scripts/smoke.mjs
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const { HELPER_SCRIPT } = await import("../src/helper.ts");
const { buildPrompt, parseCandidate } = await import("../src/prompt.ts");

const HOME = process.env.HOME;
// apply 的 db 写入指向临时副本，不碰宿主真实 app.db。
const tmp = mkdtempSync(join(tmpdir(), "auto-title-test-"));
const fakeDb = join(tmp, "app.db");
// app.db 是 WAL：直接拷文件会丢未 checkpoint 的行，用 sqlite3 在线备份。
await run("sqlite3", [join(HOME, ".ccgui-next/app.db"), `.backup '${fakeDb}'`]);
const env = { ...process.env, CCGUI_APP_DB: fakeDb };

async function helper(args, useFakeDb = true) {
  const { stdout } = await run("python3", ["-c", HELPER_SCRIPT, ...args], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: useFakeDb ? env : process.env,
  });
  return JSON.parse(stdout);
}

let failed = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failed = true;
};

// ── omp：真实会话快照（ oil-codex-title 讨论所在会话）
const OMP_SID = "01a0a56e-4151-7566-ab2d-4c74335cb53e";
const ompSnap = await helper(["snapshot", "omp", OMP_SID]);
check("omp snapshot", ompSnap.found && ompSnap.turns.length >= 2,
  `turns=${ompSnap.turns.length} cwd=${ompSnap.cwd} current=${JSON.stringify(ompSnap.current_name)} custom=${JSON.stringify(ompSnap.custom_name)}`);
console.log("  用户消息:", ompSnap.turns.filter((t) => t.role === "user").map((t) => t.text.slice(0, 40)));

// ── omp apply：db 写临时副本；title 行改写真实转录后立即还原原始字节
const ompFile = join(HOME, ".omp/agent/sessions/-Desktop-CC GUI 项目-desktop-cc-gui",
  "2026-09-15T14-17-41-457Z_01a0a56e-4151-7566-ab2d-4c74335cb53e.jsonl");
const original = readFileSync(ompFile);
const firstNl = original.indexOf(10);
const originalFirstLine = original.subarray(0, firstNl + 1);
const ompApply = await helper(["apply", "omp", OMP_SID, "🧩 冒烟测试｜回环验证"]);
const after = readFileSync(ompFile);
const titleLineOk = after.length === original.length
  && after.subarray(firstNl + 1).equals(original.subarray(firstNl + 1))
  && after.subarray(0, firstNl + 1).includes(Buffer.from("冒烟测试", "utf8"));
// 还原
writeFileSync(ompFile, Buffer.concat([originalFirstLine, after.subarray(firstNl + 1)]));
check("omp apply", ompApply.ok && ompApply.rows === 1 && titleLineOk,
  `rows=${ompApply.rows} file=${ompApply.file} 行等长=${titleLineOk}`);

// ── claude：真实会话快照
const claudeSnap = await helper(["snapshot", "claude", "47a17f78-695f-4530-9613-10ece961119d"]);
check("claude snapshot", claudeSnap.found && claudeSnap.turns.length >= 1,
  `turns=${claudeSnap.turns.length} cwd=${claudeSnap.cwd}`);

// ── claude apply：只写 db（临时副本）
const claudeApply = await helper(["apply", "claude", "47a17f78-695f-4530-9613-10ece961119d", "🧩 冒烟测试｜回环验证"]);
check("claude apply", claudeApply.ok && claudeApply.rows === 1, `rows=${claudeApply.rows}`);

// ── codex 回环（临时 CODEX_HOME，不碰真实 index）
const fakeCodex = join(tmp, "codex");
mkdirSync(join(fakeCodex, "sessions"), { recursive: true });
writeFileSync(join(fakeCodex, "session_index.jsonl"), "");
const codexEnv = { ...process.env, CODEX_HOME: fakeCodex };
const { stdout: codexOut } = await run("python3",
  ["-c", HELPER_SCRIPT, "apply", "codex", "01a06547-604e-73a2-b39a-5940f34a8c30", "🧩 冒烟测试｜回环验证"],
  { env: codexEnv, timeout: 30_000 });
check("codex apply", JSON.parse(codexOut).ok === true
  && readFileSync(join(fakeCodex, "session_index.jsonl"), "utf8").includes("冒烟测试"));

// ── 真实命名调用：给 omp 的 oil-codex-title 讨论会话起名（claude haiku，一次）
const prompt = buildPrompt({
  recent_turns: ompSnap.turns,
  current_title: ompSnap.current_name,
  project_hint: ompSnap.cwd.split("/").filter(Boolean).at(-1) ?? "",
  conflicting_titles: ompSnap.existing_names.slice(-20),
});
const { stdout } = await run("claude",
  ["-p", prompt, "--output-format", "text", "--model", "haiku"],
  { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
const candidate = parseCandidate(stdout);
check("backend naming", candidate !== null, JSON.stringify(candidate));

console.log(failed ? "SMOKE FAILED" : "SMOKE OK");
process.exit(failed ? 1 : 0);
