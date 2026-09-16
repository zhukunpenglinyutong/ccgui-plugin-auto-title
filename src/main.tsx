import "./styles.css";

import type { PluginActivate } from "./ccgui-plugin";
import { copy } from "./i18n";
import { Namer } from "./naming";
import { makeSettingsSection, makeStatusChip } from "./ui";

/**
 * 入口：注册 usage 事件订阅（命名触发）、状态栏 chip（暂停开关）、
 * 设置页 section（后端状态 + 会话管理）、两条 ⌘K 命令。
 */
const activate: PluginActivate = (ctx) => {
  const t = copy(ctx.host.locale);
  const namer = new Namer(ctx);
  // init 从 storage 恢复 paused/named；完成前的 usage 事件只会进入防抖队列。
  void namer.init();

  ctx.events.on("usage://updated", (data) => namer.onUsage(data));

  ctx.ui.registerStatusBarItem({
    component: makeStatusChip(ctx, namer, t),
  });

  ctx.ui.registerSettingsSection({
    label: () => t.settingsLabel,
    component: makeSettingsSection(ctx, namer, t),
  });

  ctx.ui.registerCommand({
    key: "toggle-pause",
    title: () => (namer.paused ? t.cmdToggleResume : t.cmdTogglePause),
    keywords: () => ["auto-title", "命名", "title"],
    run: () => void namer.setPaused(!namer.paused),
  });

  ctx.ui.registerCommand({
    key: "name-recent",
    title: () => t.cmdNameRecent,
    keywords: () => ["auto-title", "命名", "rename"],
    run: () => {
      if (namer.lastActive) namer.enqueue(namer.lastActive.engine, namer.lastActive.sid, true);
    },
  });

  // 侧栏会话右键菜单：force 重新命名（绕过 lastCount/updateExisting 闸门；
  // 固定与用户手改标题的会话仍在 nameSession 内部让位）。
  ctx.ui.registerSessionMenuItem({
    key: "rename",
    label: () => t.menuRename,
    run: ({ engine, sessionId }) => namer.enqueue(engine, sessionId, true),
  });

  return () => namer.dispose();
};

export default activate;
