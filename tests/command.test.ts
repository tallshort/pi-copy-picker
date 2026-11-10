import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, TuiAltScreen, type TUI } from "@earendil-works/pi-tui";
import copyPicker from "../src/index.js";

function setup(fullscreen = false) {
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const events = new Map<string, () => void>();
  copyPicker({ registerCommand: (name: string, options: typeof command) => { if (name === "copy-picker") command = options; },
    registerShortcut: () => {},
    on: (name: string, fn: () => void) => events.set(name, fn) } as unknown as ExtensionAPI);
  const notices: unknown[][] = [];
  const flashes: string[] = [];
  const order: string[] = [];
  let result: "copied" | undefined = "copied";
  let finish!: (value: "copied" | undefined) => void;
  let pending = false;
  const tui = Object.assign(fullscreen ? Object.create(TuiAltScreen.prototype) : {}, {
    terminal: { rows: 30 }, requestRender() {},
    flash(message: string) { order.push("flash"); flashes.push(message); },
  }) as TUI;
  const ctx = { mode: "tui", sessionManager: { getBranch: () => [] }, ui: {
    custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0], options: unknown) => {
      assert.deepEqual(options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
      const kb = new KeybindingsManager(TUI_KEYBINDINGS) as Parameters<typeof factory>[2];
      await factory(tui, {} as never, kb, () => {});
      const value = pending ? await new Promise<"copied" | undefined>(resolve => { finish = resolve; }) : result;
      order.push("overlay closed");
      return value;
    }, notify: (...args: unknown[]) => { order.push("notice"); notices.push(args); },
  } } as unknown as ExtensionCommandContext;
  return { command, ctx, notices, flashes, events, order,
    setResult: (value: typeof result) => { result = value; },
    pending: () => { pending = true; }, finish: () => finish("copied") };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("regular mode follows native notify path only after overlay closes", async () => {
  const s = setup();
  s.pending();
  const task = s.command.handler("", s.ctx);
  await tick();
  assert.deepEqual(s.notices, []);
  s.finish(); await task;
  assert.deepEqual(s.notices, [["Copied message to clipboard", "info"]]);
  assert.deepEqual(s.flashes, []);
  assert.deepEqual(s.order, ["overlay closed", "notice"]);
});

test("fullscreen uses native flash after overlay closes instead of chat notification", async () => {
  const s = setup(true);
  s.pending();
  const task = s.command.handler("", s.ctx);
  await tick();
  assert.deepEqual(s.flashes, []);
  s.finish(); await task;
  assert.deepEqual(s.flashes, ["Copied!"]);
  assert.deepEqual(s.notices, []);
  assert.deepEqual(s.order, ["overlay closed", "flash"]);
});

test("shutdown/start invalidate pending overlay results in both display modes", async () => {
  for (const fullscreen of [false, true]) for (const event of ["session_start", "session_shutdown"]) {
    const s = setup(fullscreen);
    s.pending();
    const task = s.command.handler("", s.ctx);
    await tick();
    s.events.get(event)!();
    s.finish(); await task;
    assert.deepEqual(s.notices, []);
    assert.deepEqual(s.flashes, []);
  }
});

test("cancel creates no success feedback and non-TUI mode is rejected in English", async () => {
  for (const fullscreen of [false, true]) {
    const s = setup(fullscreen);
    s.setResult(undefined);
    await s.command.handler("", s.ctx);
    assert.equal(s.notices.length, 0);
    assert.equal(s.flashes.length, 0);
    await s.command.handler("", { ...s.ctx, mode: "rpc" } as ExtensionCommandContext);
    assert.match(String(s.notices.at(-1)?.[0]), /requires interactive TUI/);
  }
});

test("copy-block and Ctrl+Shift+B copy the last block of the current branch through Pi's clipboard", async () => {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  let shortcut!: Parameters<ExtensionAPI["registerShortcut"]>[1];
  copyPicker({ on: () => {}, registerCommand: (name: string, value: typeof shortcut) => commands.set(name, value as never),
    registerShortcut: (key: string, value: typeof shortcut) => { assert.equal(key, "ctrl+shift+b"); shortcut = value; },
  } as unknown as ExtensionAPI);
  assert.equal(commands.get("copy-block")?.description, "Copy the last block or message from the latest assistant reply (Ctrl+Shift+B)");
  assert.equal(shortcut.description, "Copy last assistant block");
  const message = (id: string, role: string, content: unknown, stopReason = "stop") =>
    ({ type: "message", id, message: { role, content, stopReason } });
  const text = (value: string) => ({ type: "text", text: value });
  let branch: unknown[] = [];
  const notices: unknown[][] = [];
  const ctx = { mode: "tui", sessionManager: { getBranch: () => branch }, ui: { notify: (...args: unknown[]) => notices.push(args) } } as unknown as ExtensionCommandContext;
  const command = commands.get("copy-block")!;
  const originalWrite = process.stdout.write;
  const savedEnv = { ...process.env };
  const writes: string[] = [];
  process.env.PI_CLIPBOARD_OSC52 = "1";
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY; delete process.env.TERMUX_VERSION;
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) { writes.push(chunk); return true; }
    return (originalWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...args);
  }) as typeof process.stdout.write;
  try {
    const cases = [
      ["First line\nsecond line\n\nAnother paragraph\ncontinued\n", "First line\nsecond line\n\nAnother paragraph\ncontinued\n"],
      ["Two descriptions\nsecond line\n\n```markdown\n# example\n```\n\nMore description\nsecond line\n\n```js\nrun()\n```\n\nTrailing text\nsecond line", "run()"],
      ["`value`\n\ntrailing line\nanother line", "value"],
      ["`heading`\ncontinued title\n---", "`heading`\ncontinued title\n---"],
      ["start `open\n`inner`\nclose`", "start `open\n`inner`\nclose`"],
      ["\\``open\n`value`", "\\``open\n`value`"],
      ["start ```\n```value```", "start ```\n```value```"],
      ["<div>\n`value`", "<div>\n`value`"],
      ["<!-- comment\n`value`", "<!-- comment\n`value`"],
      ["description\n`value`", "value"],
      ["`value`\ndescription", "value"],
      ["Generated an HTML report:\n\n`/tmp/example/report.html`\n\nThe report has 24 cases.", "/tmp/example/report.html"],
      ["```js\nx\n```\n\n`` `value` ``\n\nordinary text", " `value` "],
      ["`first`\n\n```\nlast\n```", "last"],
      ["```ts\r\n  alpha\r\n\r\n```\r\n", "  alpha"],
      ["> **quote**\n> next\n", "**quote**\nnext"],
      ["- first\n- second\n", "- first\n- second\n"],
      ["```\nfirst\n```\n\n> last\n", "last"],
    ];
    for (const [source, expected] of cases) {
      branch = [message("old", "assistant", [text("```\nold\n```")]), message("new", "assistant", [text(source!)]), message("tool", "toolResult", [text("ignored")]), message("user", "user", "untouched")];
      await command.handler("", ctx);
      assert.equal(writes.pop(), `\x1b]52;c;${Buffer.from(expected!).toString("base64")}\x07`);
      await shortcut.handler(ctx);
      assert.equal(writes.pop(), `\x1b]52;c;${Buffer.from(expected!).toString("base64")}\x07`);
      assert.equal((branch[3] as { message: { content: string } }).message.content, "untouched");
    }
    branch = [message("a", "assistant", [text("```"), text("joined"), text("```")]), message("aborted", "assistant", [], "aborted")];
    await shortcut.handler(ctx);
    assert.equal(writes.pop(), `\x1b]52;c;${Buffer.from("joined").toString("base64")}\x07`);
    branch = [message("a", "assistant", [text("```\npartial\n```")], "aborted"),
      message("thinking", "assistant", [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "x", arguments: {} }]),
      message("tool", "toolResult", [text("```\nnot this\n```")])];
    await command.handler("", ctx);
    assert.equal(writes.pop(), `\x1b]52;c;${Buffer.from("partial").toString("base64")}\x07`);
    for (const latest of ["# Heading", "  plain text\n\n"]) {
      branch = [message("old", "assistant", [text("```\nold\n```")]), message("new", "assistant", [text(latest)])];
      await command.handler("", ctx);
      assert.equal(writes.pop(), `\x1b]52;c;${Buffer.from(latest).toString("base64")}\x07`);
      await shortcut.handler(ctx);
      assert.equal(writes.pop(), `\x1b]52;c;${Buffer.from(latest).toString("base64")}\x07`);
    }
    branch = [message("old", "assistant", [text("```\nold\n```")]), message("new", "assistant", [])];
    await command.handler("", ctx);
    assert.deepEqual(notices.at(-1), ["No copyable text in the latest assistant message", "warning"]);
    assert.equal(writes.length, 0);
    branch = [message("user", "user", "```\nno\n```")];
    await shortcut.handler(ctx);
    assert.deepEqual(notices.at(-1), ["No copyable text in the latest assistant message", "warning"]);
    branch = [message("a", "assistant", [text("```\nx\n```")])];
    for (const mode of ["rpc", "json", "print"] as const) {
      await shortcut.handler({ ...ctx, mode });
      assert.match(String(notices.at(-1)?.[0]), /requires interactive TUI/);
      assert.equal(writes.length, 0);
    }
    const first = shortcut.handler(ctx);
    const second = command.handler("", ctx);
    await Promise.all([first, second]);
    assert.equal(writes.length, 1);
    writes.length = 0;
    branch = [message("progress", "assistant", [text("Progress\n\n```js\noldBlock()\n```"), { type: "toolCall", name: "read", arguments: {} }], "toolUse"),
      message("tool", "toolResult", [text("tool output")]), message("final", "assistant", [text("Final prose only")])];
    await command.handler("", ctx);
    assert.equal(writes.pop(), `\x1b]52;c;${Buffer.from("oldBlock()").toString("base64")}\x07`);
    branch = [message("old", "assistant", [text("```\nold\n```")]),
      message("progress", "assistant", [text("Progress")], "toolUse"), message("final", "assistant", [text("Final prose")])];
    await command.handler("", ctx);
    assert.equal(writes.pop(), `\x1b]52;c;${Buffer.from("Progress\n\nFinal prose").toString("base64")}\x07`);
    branch = [message("huge", "assistant", [text(`\`\`\`\n${"x".repeat(80000)}\n\`\`\``)])];
    await shortcut.handler(ctx);
    assert.match(String(notices.at(-1)?.[0]), process.platform === "linux" ? /Copy failed:.*OSC 52/ : /Copied message to clipboard|Copy failed:.*OSC 52/);
    assert.equal(writes.length, 0);
  } finally {
    process.stdout.write = originalWrite;
    for (const key of ["PI_CLIPBOARD_OSC52", "DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION"]) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }
});
