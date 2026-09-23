// 回归测试（自包含、无第三方依赖）：Windows GBK(cp936) 终端下，内嵌 python3
// 助手输出含 Emoji / 数学减号等字符时不得崩溃，且宿主能拿到完整的 Unicode。
// 用法：pnpm test（或 node scripts/test-helper-encoding.mjs）。
//
// 关键点：用 PYTHONIOENCODING=cp936 模拟 Windows 默认代码页。修复前脚本的
// print 会抛 UnicodeEncodeError 并以非零码退出；修复后应返回合法 JSON。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = readFileSync(new URL("../src/helper.ts", import.meta.url), "utf8");
const match = src.match(/export const HELPER_SCRIPT = String\.raw`([\s\S]*?)\n`;/);
if (!match) {
  console.error("FAIL 无法从 src/helper.ts 提取 HELPER_SCRIPT");
  process.exit(1);
}
const HELPER_SCRIPT = match[1];

const EMOJI = "🧩 编码回归｜减号 − 与特殊符号 🎯";
const SID = "test-encoding-0001";

const code = (() => {
  const tmp = mkdtempSync(join(tmpdir(), "auto-title-encoding-"));
  try {
    // 造一份最小 claude 转录：一条含 Emoji 的用户消息（claude 通道无需 app.db 命中）。
    const proj = join(tmp, "projects", "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, `${SID}.jsonl`),
      JSON.stringify({
        type: "user",
        cwd: "/tmp/proj",
        message: { role: "user", content: [{ type: "text", text: `请处理 ${EMOJI}` }] },
      }) + "\n",
      "utf8",
    );

    const stdout = execFileSync("python3", ["-c", HELPER_SCRIPT, "snapshot", "claude", SID], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: tmp,
        CCGUI_APP_DB: join(tmp, "empty-app.db"),
        PYTHONIOENCODING: "cp936",
      },
    });
    const snapshot = JSON.parse(stdout);
    const hasEmoji = snapshot.turns?.some((turn) => turn.text.includes(EMOJI)) ?? false;
    const ok = snapshot.found === true && hasEmoji;
    console.log(`${ok ? "PASS" : "FAIL"} cp936 下输出 Emoji/特殊符号不崩溃且内容无损`);
    if (!ok) {
      console.error(stdout);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("SKIP 未找到 python3，跳过编码回归测试");
      return 0;
    }
    console.error("FAIL 助手在 cp936 下执行失败（修复前会在此抛 UnicodeEncodeError）");
    console.error(String(error.stderr ?? error.message));
    return 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
})();

process.exit(code);
