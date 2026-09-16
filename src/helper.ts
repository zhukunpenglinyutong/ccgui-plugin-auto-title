/**
 * 内嵌 python3 助手脚本（经 plugin_exec_run 以 `python3 -c <script> ...` 执行）。
 * 插件没有文件 API，读写引擎会话存储只能走这条 exec 通道。
 *
 * 子命令：
 *   snapshot <engine> <sessionId>        → 最近对话 + 当前显示标题 + 同引擎冲突标题
 *   apply    <engine> <sessionId> <title> → 按引擎写入标题
 *
 * 引擎通道（与宿主 src-tauri/src/history 一一对应）：
 *   codex      rollout 在 $CODEX_HOME/sessions/**，标题写 session_index.jsonl
 *              （宿主 codex_titles::sync 扫描时同步，custom_title 优先）。
 *   omp / pi   转录在 <agent>/sessions/**，行首 {type:"title",pad} 是定长填充的
 *              就地改写协议；但宿主不读它，显示走 app.db 的 custom_title
 *              （侧栏/标签页都是 customTitle || title），所以两处都写。
 *   claude     转录在 $CLAUDE_CONFIG_DIR/projects/**，无引擎侧标题通道，
 *              只写 app.db custom_title。
 *
 * 快照里的当前标题/冲突标题统一读 app.db（显示事实源），避免各引擎格式漂移。
 */
export const HELPER_SCRIPT = String.raw`
import glob
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

ENV_RE = re.compile(r"<environment_context\b[^>]*>.*?</environment_context>", re.S)
INSTR_RE = re.compile(r"<user_instructions\b[^>]*>.*?</user_instructions>", re.S)
BROWSER_RE = re.compile(r"<in-app-browser-context\b[^>]*>.*?</in-app-browser-context>", re.S)
AGENTS_RE = re.compile(r"<INSTRUCTIONS\b[^>]*>.*?</INSTRUCTIONS>", re.S)
AGENTS_HDR_RE = re.compile(r"# AGENTS\.md instructions[^\n]*")
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
USER_INFO_RE = re.compile(r"<user_info\b[^>]*>.*?</user_info>", re.S)
IMAGE_MARK_RE = re.compile(r"\[Image #\d+[^\]]*\]")
COMMAND_TAG_RE = re.compile(r"</?command-[^>]*>")
FILE_BLOCK_RE = re.compile(r"<file\b[^>]*>.*?</file>", re.S)
FILE_SELF_RE = re.compile(r"<file\b[^>]*/>")
TAIL_BYTES = 2000000
HEAD_BYTES = 65536
# 与 oil-codex-title 一致：只给命名模型用户消息与最终回答。
# agentic 会话里两条用户消息间隔着大量助手输出，总条数窗口会把用户消息挤没。
MAX_USER_TURNS = 6
MAX_ASSISTANT_TURNS = 3
PER_MSG = 1500


def clean(text):
    if text.lstrip().startswith("<turn_aborted>"):
        return ""
    for pattern in (ENV_RE, INSTR_RE, BROWSER_RE, AGENTS_RE, AGENTS_HDR_RE, COMMENT_RE,
                    USER_INFO_RE, IMAGE_MARK_RE, COMMAND_TAG_RE, FILE_BLOCK_RE, FILE_SELF_RE):
        text = pattern.sub(" ", text)
    return " ".join(text.split())


def home(*parts):
    return os.path.join(os.path.expanduser("~"), *parts)


def app_db():
    # CCGUI_APP_DB：测试覆盖（冒烟脚本指向临时副本），正常为空走固定路径。
    return os.environ.get("CCGUI_APP_DB") or home(".ccgui-next", "app.db")


def sessions_root(engine):
    if engine == "codex":
        root = os.environ.get("CODEX_HOME") or home(".codex")
        return os.path.join(root, "sessions")
    if engine in ("omp", "pi"):
        agent = os.environ.get("PI_CODING_AGENT_DIR") or home("." + engine, "agent")
        return os.path.join(agent, "sessions")
    if engine == "claude":
        root = os.environ.get("CLAUDE_CONFIG_DIR") or home(".claude")
        return os.path.join(root, "projects")
    return None


def find_file(engine, sid):
    root = sessions_root(engine)
    if not root:
        return None
    if engine == "codex":
        pattern = os.path.join(root, "**", "*" + sid + ".jsonl")
    elif engine in ("omp", "pi"):
        pattern = os.path.join(root, "**", "*_" + sid + ".jsonl")
    else:
        pattern = os.path.join(root, "**", sid + ".jsonl")
    best = None
    for path in glob.glob(pattern, recursive=True):
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if best is None or mtime > best[0]:
            best = (mtime, path)
    return best[1] if best else None


def read_head(path):
    with open(path, "rb") as stream:
        raw = stream.read(HEAD_BYTES).decode("utf-8", "ignore")
    return raw.splitlines()


def read_tail(path):
    with open(path, "rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        if size > TAIL_BYTES:
            stream.seek(size - TAIL_BYTES)
            stream.readline()
        else:
            stream.seek(0)
        return stream.read().decode("utf-8", "ignore").splitlines()


def iter_json(lines):
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except ValueError:
            continue


def parts_text(content, kinds):
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") in kinds:
                parts.append(str(part.get("text", "")))
    return "".join(parts)


def db_names(engine, sid):
    """当前显示标题 / 用户手改标题（custom_title）/ 同引擎其他标题。
    区分 custom 与派生：派生标题（首条消息）可以被自动命名覆盖，
    custom_title 是用户或我们写下的，未知会话上存在即视为用户手改。"""
    display, custom, others = None, None, []
    try:
        # 不用 mode=ro：WAL 库带热日志时只读连接无法做恢复，直接 CANTOPEN。
        # 普通连接只 SELECT，与宿主并发读写在 WAL 下安全共存。
        conn = sqlite3.connect(app_db(), timeout=3)
        try:
            rows = conn.execute(
                "SELECT session_id, title, custom_title FROM sessions WHERE engine=?1",
                (engine,),
            ).fetchall()
        finally:
            conn.close()
        for row_id, title, custom_title in rows:
            name = custom_title or title
            if row_id == sid:
                display = name
                custom = custom_title
            elif name:
                others.append(name)
    except (OSError, sqlite3.Error):
        pass
    return display, custom, others[-100:]


def scan_messages(lines, engine):
    cwd = ""
    msgs = []
    for value in iter_json(lines):
        kind = value.get("type")
        if engine == "codex":
            payload = value.get("payload") or {}
            if kind == "session_meta":
                cwd = payload.get("cwd") or cwd
            elif kind == "response_item" and payload.get("type") == "message":
                role = payload.get("role")
                if role not in ("user", "assistant"):
                    continue
                text = clean(parts_text(payload.get("content"), ("input_text", "output_text", "text")))
                if text:
                    msgs.append((role, text))
            elif kind == "event_msg" and payload.get("type") == "user_message":
                text = clean(str(payload.get("message") or payload.get("text") or ""))
                if text:
                    msgs.append(("user", text))
        elif engine in ("omp", "pi"):
            if kind != "message":
                continue
            message = value.get("message") or {}
            role = message.get("role")
            if role not in ("user", "assistant"):
                continue
            text = clean(parts_text(message.get("content"), ("text",)))
            if text:
                msgs.append((role, text))
        else:  # claude
            if kind not in ("user", "assistant") or value.get("isMeta"):
                continue
            cwd = value.get("cwd") or cwd
            message = value.get("message") or {}
            text = clean(parts_text(message.get("content"), ("text",)))
            if text:
                msgs.append((kind, text))
    return cwd, msgs


def snapshot(engine, sid):
    display, custom, others = db_names(engine, sid)
    out = {"found": False, "cwd": "", "current_name": display, "custom_name": custom,
           "turns": [], "existing_names": others}
    path = find_file(engine, sid)
    if not path:
        print(json.dumps(out, ensure_ascii=False))
        return
    # omp/pi 的 cwd 在 session 行、claude 在消息行、codex 在 session_meta，都在头部。
    head = read_head(path)
    head_cwd, _ = scan_messages(head, engine)
    for value in iter_json(head):
        if value.get("type") == "session" and value.get("cwd"):
            head_cwd = value["cwd"]
            break
    tail_cwd, msgs = scan_messages(read_tail(path), engine)
    out["cwd"] = head_cwd or tail_cwd
    indexed = list(enumerate(msgs))
    users = [m for m in indexed if m[1][0] == "user"][-MAX_USER_TURNS:]
    assistants = [m for m in indexed if m[1][0] == "assistant"][-MAX_ASSISTANT_TURNS:]
    window = [m for _, m in sorted(users + assistants)]
    out["turns"] = [{"role": r, "text": t[:PER_MSG]} for r, t in window]
    out["found"] = bool(msgs)
    print(json.dumps(out, ensure_ascii=False))


def rewrite_title_line(path, title):
    """omp/pi 行首 title 行：pad 填充吸收长度差，就地等长改写，不破坏后续行偏移。"""
    with open(path, "rb") as stream:
        first = stream.readline()
    try:
        value = json.loads(first.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return False
    if value.get("type") != "title":
        return False
    target = len(first.rstrip(b"\n"))
    value["title"] = title
    value["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    candidate = title
    while True:
        value["title"] = candidate
        value["pad"] = ""
        base = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(base) <= target:
            value["pad"] = " " * (target - len(base))
            line = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            with open(path, "r+b") as stream:
                stream.write(line)
            return True
        if len(candidate) <= 8:
            return False
        candidate = candidate[:-1]


def apply(engine, sid, title):
    title = " ".join(title.split())
    if not title or len(title) > 48:
        print(json.dumps({"ok": False}))
        return
    result = {"ok": True, "rows": 0, "file": None}
    if engine == "codex":
        index = os.path.join(os.environ.get("CODEX_HOME") or home(".codex"), "session_index.jsonl")
        with open(index, "a", encoding="utf-8") as stream:
            stream.write(json.dumps({"id": sid, "thread_name": title}, ensure_ascii=False) + "\n")
        result["file"] = True
    else:
        path = find_file(engine, sid)
        if engine in ("omp", "pi") and path:
            result["file"] = rewrite_title_line(path, title)
        try:
            conn = sqlite3.connect(app_db(), timeout=5)
            try:
                cur = conn.execute(
                    "UPDATE sessions SET custom_title=?3 WHERE engine=?1 AND session_id=?2",
                    (engine, sid, title),
                )
                conn.commit()
                result["rows"] = cur.rowcount
            finally:
                conn.close()
        except (OSError, sqlite3.Error) as error:
            result["ok"] = False
            result["error"] = str(error)[:200]
    print(json.dumps(result, ensure_ascii=False))


def main():
    cmd, engine, sid = sys.argv[1], sys.argv[2], sys.argv[3]
    if engine not in ("codex", "omp", "pi", "claude") or not re.fullmatch(r"[A-Za-z0-9-]+", sid):
        print(json.dumps({"ok": False, "error": "bad args"}))
        return
    if cmd == "snapshot":
        snapshot(engine, sid)
    elif cmd == "apply":
        apply(engine, sid, sys.argv[4])
    else:
        print(json.dumps({"ok": False, "error": "unknown command"}))


main()
`;

export interface Snapshot {
  found: boolean;
  cwd: string;
  /** 显示标题（custom_title || 派生标题）。 */
  current_name: string | null;
  /** 用户手改或本插件写入的 custom_title；null = 显示的是派生标题。 */
  custom_name: string | null;
  turns: { role: "user" | "assistant"; text: string }[];
  existing_names: string[];
}

export interface ApplyResult {
  ok: boolean;
  rows?: number;
  file?: boolean | null;
  error?: string;
}

interface ExecRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** 跑内嵌助手脚本；非零退出或 JSON 解析失败都抛错，由调用方按失败路径处理。 */
export async function runHelper<T>(invoke: Invoke, args: string[], timeoutMs = 30_000): Promise<T> {
  const res = await invoke<ExecRunResult>("plugin_exec_run", {
    bin: "python3",
    args: ["-c", HELPER_SCRIPT, ...args],
    timeoutMs,
  });
  if (res.code !== 0) {
    throw new Error(`helper exited ${res.code}: ${res.stderr.slice(0, 300)}`);
  }
  return JSON.parse(res.stdout) as T;
}
