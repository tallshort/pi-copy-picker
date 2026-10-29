import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { copyToClipboard, getMarkdownTheme, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { PickerScreen } from "../src/picker.js";
import { toPickerItems, type PickItem } from "../src/history.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

initTheme("dark", false);
const themeJSON = JSON.parse(readFileSync(new URL("./modes/interactive/theme/dark.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8"));
const colors = Object.fromEntries(Object.keys(themeJSON.colors).map(key => [key, key.endsWith("Bg") ? "#222222" : "#dddddd"]));
colors.dim = "#777777";
colors.muted = "#bbbbbb";
colors.accent = "#00ffff";
const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");

const k = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", esc: "\x1b", end: "\x1b[1;5F", pgdown: "\x1b[6~", tools: "\x14" };
const item = (id: string, rawText = id, kind: "user" | "assistant" = "assistant"): PickItem => ({ id, rawText, kind });
const dividerRow = (rows: number) => 4 + Math.floor(Math.max(0, rows - 6) * 0.6);
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(items: PickItem[], copy?: (text: string) => Promise<void>, pickerTheme = theme) {
  const terminal = { rows: 30 };
  const copied: string[] = [];
  const results: ("copied" | undefined)[] = [];
  let renders = 0;
  const picker = new PickerScreen(items, { terminal, requestRender() { renders++; } } as unknown as TUI,
    pickerTheme, new KeybindingsManager(TUI_KEYBINDINGS), result => results.push(result), copy ?? (async text => { copied.push(text); }));
  const render = (width = 100) => picker.render(width);
  const plain = () => render().map(stripTerminalSequences);
  const cards = () => plain().slice(2, dividerRow(terminal.rows));
  return { picker, terminal, copied, results, render, plain, cards, press: (key: string) => picker.handleInput(key), get renders() { return renders; } };
}

function selectedCard(lines: string[]): string {
  const start = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
  const end = lines.findIndex((line, i) => i > start && line.includes(theme.getFgAnsi("accent") + "╰"));
  assert.ok(start >= 0 && end > start, "selected entity has its own visible frame");
  return lines.slice(start, end + 1).map(line => stripTerminalSequences(line).trimEnd()).join("\n");
}

test("real Markdown source keeps highlighting, user shading and adaptive selection", () => {
  const s = setup([item("u", "**hello**\n\nsecond\n\nthird", "user"), item("a", "# title\n\nbody")]);
  s.terminal.rows = 60;
  for (const key of [k.down, k.up]) {
    s.press(key);
    const lines = s.render();
    assert.ok(selectedCard(lines).split("\n").length >= 3 && selectedCard(lines).split("\n").length <= 9);
    assert.ok(lines.some(line => line.includes(theme.getBgAnsi("userMessageBg"))));
    assert.ok(!s.cards().join("\n").match(/User:|Agent:|Assistant:|›|→/));
    assert.ok(lines.every(line => visibleWidth(line) === 100));
  }
});

test("code child sample contains seven source rows with fences and omitted regions", () => {
  const s = setup([item("code", "intro one\n\nintro two\n\nintro three\n\n```js\n{\nconst alpha = 1;\n\nconst beta = 2;\n}\nreturn alpha + beta;\n```\n\nafter")]);
  s.press(k.down);
  const card = selectedCard(s.render());
  for (const text of ["const alpha", "const beta"]) assert.ok(card.includes(text));
  assert.ok(!card.includes("intro one"));
  assert.equal(card.split("\n").length, 9);
  assert.ok(!card.includes("return alpha"));
  assert.equal(card.split("```").length - 1, 1);
  assert.ok(card.includes("..."));
  const rawCode = s.render().find(line => stripTerminalSequences(line).includes("const alpha"))!;
  assert.ok(rawCode.includes("\x1b["));
});

test("selected code keeps syntax highlighting without changing its source", () => {
  const source = "const answer = 42;";
  const expected = getMarkdownTheme().highlightCode?.(source, "javascript")?.[0];
  assert.ok(expected && stripTerminalSequences(expected) === source);
  const s = setup([item("code", `\`\`\`javascript\n${source}\n\`\`\``)]);
  s.press(k.down);
  assert.ok(s.render().some(line => line.includes(expected)));
  assert.ok(selectedCard(s.render()).includes(source));
});

test("parent summary preserves the first brace, single blank and final source row", () => {
  const s = setup([item("x", "{\nfirst\n\nsecond\n}\nthird\nlast")]);
  const frame = selectedCard(s.render()).split("\n");
  assert.equal(frame.length, 9);
  assert.deepEqual(frame.slice(1, -1).map(line => line.slice(2, -1).trimEnd()), ["{", "first", "", "second", "}", "third", "last"]);
  assert.ok(!frame.join("\n").includes("..."));
});

test("variable heights pack pages, arrows clamp, selection survives resize and search", async () => {
  const s = setup([item("one"), item("two"), item("tall", "a\n\nb\n\nc\n\nd"), item("four"), item("five")]);
  assert.ok(s.cards().join("\n").includes("five"));
  s.press(k.left);
  assert.ok(s.cards().join("\n").includes("one"));
  assert.ok(s.cards().join("\n").includes("two"));
  assert.ok(s.cards().join("\n").includes("third") === false);
  for (let i = 0; i < 9; i++) s.press(k.right);
  s.press(k.down);
  s.press("five");
  s.press(k.enter); s.press(k.down);
  s.terminal.rows = 24;
  s.render();
  s.press(k.enter);
  await settle();
  assert.deepEqual(s.copied, ["five"]);
  assert.deepEqual(s.results, ["copied"]);
});

test("fixed rows precede the list and preview split at every terminal height", () => {
  const heights = [20, 21, 24, 26, 30, 31, 40, 41, 50, 51, 60, 61, 80, 81];
  const long = setup([item("long", Array.from({ length: 150 }, (_, i) => `line-${i}`).join("\n"))]);
  const pages = setup(Array.from({ length: 100 }, (_, i) => item(`message-${i}`)));
  for (const rows of heights) {
    const listRows = Math.floor((rows - 6) * 0.6);
    const previewRows = rows - 6 - listRows;
    long.terminal.rows = rows;
    long.press("\x1b[1;5H");
    let lines = long.render(50).map(stripTerminalSequences);
    assert.equal(lines.length, rows);
    assert.match(lines[4 + listRows]!, /^─+ preview ─+$/);
    assert.equal(lines[5 + listRows]!.trim(), "");
    assert.equal(lines.slice(6 + listRows).length, previewRows);
    assert.match(lines.at(-1)!, /^ \.\.\./);
    long.press(k.end);
    lines = long.render(50).map(stripTerminalSequences);
    assert.ok(lines.at(-1)!.includes("line-149"));
    assert.ok(lines.every(line => visibleWidth(line) === 50));

    pages.terminal.rows = rows;
    for (let i = 0; i < 100; i++) pages.press(k.left);
    lines = pages.render(50).map(stripTerminalSequences);
    assert.ok(lines.slice(3, 3 + listRows).filter(line => /message-\d+/.test(line)).length > 0);
    assert.ok(selectedCard(pages.render(50)).split("\n").length >= 3 && selectedCard(pages.render(50)).split("\n").length <= 9);
    assert.match(lines[4 + listRows]!, /^─+ preview ─+$/);
    const arrow = lines.findIndex(line => line.trim() === "...");
    assert.equal(arrow, 3 + listRows);
    assert.ok(lines.slice(arrow + 1, 4 + listRows).every(line => !line.trim()));
  }
});

test("preview reserves bottom ellipsis, scroll reaches last content and clamps after resize", () => {
  const s = setup([item("long", Array.from({ length: 80 }, (_, i) => `line-${i}`).join("\n"))]);
  assert.match(s.plain().at(-1)!, /^ \.\.\./);
  assert.ok(s.render().at(-1)!.includes(theme.fg("muted", "...")));
  const divider = s.plain()[18]!;
  assert.match(divider, /^─+ preview ─+$/);
  s.press(k.pgdown);
  s.press(k.end);
  assert.ok(s.plain().at(-1)!.includes("line-79"));
  s.terminal.rows = 60;
  assert.ok(s.plain().some(line => line.includes("line-79")));
});

test("English empty states, tools, filtering and exact terminal dimensions", () => {
  const s = setup([item("a", "中文👨‍👩‍👧‍👦 é".repeat(20), "user"), { id: "tool", kind: "tool-call", toolName: "bash", rawText: "pwd" }, { id: "result", kind: "tool-result", toolName: "bash", rawText: "result" }]);
  assert.match(s.plain()[1]!, /Page \d+\/\d+ \(tool messages excluded\),/);
  assert.match(s.plain()[1]!, /type to search > /);
  assert.ok(!s.plain().join("\n").includes("Tool call"));
  s.press(k.tools);
  assert.match(s.plain()[1]!, /Page \d+\/\d+ \(tool messages included\),/);
  s.press(k.right);
  assert.match(s.plain().join("\n"), /Tool output: bash/);
  s.press(k.up);
  assert.match(s.plain().join("\n"), /Tool call: bash/);
  s.press("nomatch");
  assert.match(s.plain()[1]!, /type to search > nomatch/);
  assert.match(s.plain().join("\n"), /No matching messages/);
  for (const rows of [0, 1, 8, 19, 24, 40]) for (const width of [0, 1, 12, 32, 50, 100]) {
    s.terminal.rows = rows;
    const lines = s.render(width);
    assert.equal(lines.length, rows);
    assert.ok(lines.every(line => visibleWidth(line) === width));
  }
});

test("clipboard is awaited, duplicate Enter ignored, success closes exactly once with original payload", async () => {
  let finish!: () => void;
  const calls: string[] = [];
  const raw = "  before\t\n\x1b[2Jafter\x00 tail \n";
  const s = setup([item("x", raw)], text => { calls.push(text); return new Promise(resolve => { finish = resolve; }); });
  assert.ok(!s.plain().join("\n").includes("\x00"));
  s.press(k.enter); s.press(k.enter);
  assert.deepEqual(calls, [raw]);
  assert.deepEqual(s.results, []);
  assert.match(s.plain()[1]!, /Copying/);
  finish(); await settle();
  s.press(k.enter); s.press(k.esc);
  assert.deepEqual(s.results, ["copied"]);
});

test("failure stays open with English retry error, retry succeeds", async () => {
  let calls = 0;
  const s = setup([item("x")], async () => { if (++calls === 1) throw new Error("backend unavailable"); });
  s.press(k.enter); await settle();
  assert.deepEqual(s.results, []);
  assert.match(s.plain()[1]!, /Copy failed: backend unavailable.*retry/);
  s.press(k.enter); await settle();
  assert.deepEqual(s.results, ["copied"]);
});

test("Esc and disposal suppress late resolution and rejection callbacks", async () => {
  for (const reject of [false, true]) for (const escape of [false, true]) {
    let finish!: () => void;
    const s = setup([item("x")], () => new Promise((resolve, fail) => { finish = () => reject ? fail(Error("late")) : resolve(); }));
    s.press(k.enter);
    if (escape) s.press(k.esc); else s.picker.dispose();
    const renders = s.renders;
    finish(); await settle();
    assert.equal(s.renders, renders);
    assert.deepEqual(s.results, escape ? [undefined] : []);
  }
});

test("quoted and nested list fences sample source code after three prose paragraphs", () => {
  for (const block of [
    "> ```js\n> {\n> const alpha = 1;\n> \n> const beta = 2;\n> }\n> return alpha + beta;\n> ```",
    "- nested\n\n  ```js\n  {\n  const alpha = 1;\n\n  const beta = 2;\n  }\n  return alpha + beta;\n  ```",
  ]) {
    const s = setup([item("code", `intro one\n\nintro two\n\nintro three\n\n${block}\n\nafter`)]);
    s.press(k.down);
    const card = selectedCard(s.render());
    for (const text of ["const alpha", "const beta"]) assert.ok(card.includes(text), card);
    assert.equal(card.split("\n").length, 9);
    assert.ok(!card.includes("return alpha"));
    assert.ok(!card.includes("intro"));
    assert.equal(card.split("```").length - 1, 1);
    assert.ok(card.includes("..."));
  }
});

test("narrow cards wrap source in order and mark omitted rows", () => {
  const s = setup([item("code", `\`\`\`js\nconst longStatement = "${"x".repeat(120)}";\nconst beta = 2;\nreturn beta;\n\`\`\``)]);
  const parent = selectedCard(s.render(40));
  assert.ok(parent.includes("const longStatement"), parent);
  assert.ok(parent.includes("..."), parent);
  s.press(k.down);
  const lines = s.render(40);
  const card = selectedCard(lines);
  for (const text of ["const longStatement", "..."]) assert.ok(card.includes(text), card);
  assert.equal(lines.slice(3, 17).filter(line => stripTerminalSequences(line).includes("const longStatement")).length, 1);
  assert.ok(lines.slice(20).some(line => stripTerminalSequences(line).includes("const longStatement")));
  assert.ok(lines.every(line => visibleWidth(line) === 40));
  const highlighted = lines.find(line => stripTerminalSequences(line).includes("const beta"))!;
  assert.ok(highlighted.includes("\x1b["));
});

test("user selection shades only its actual interior and leaves borders unshaded", () => {
  const s = setup([item("u", "hello", "user"), item("a", "reply")]);
  const bg = theme.getBgAnsi("userMessageBg");
  const before = s.render();
  const hello = before.findIndex(line => stripTerminalSequences(line).includes("hello"));
  for (const i of [hello - 1, hello + 1]) {
    assert.equal(stripTerminalSequences(before[i]!).trim(), "");
    assert.ok(before[i]!.includes(bg));
  }
  s.press(k.up);
  const after = s.render();
  const selectedHello = after.findIndex(line => stripTerminalSequences(line).includes("hello"));
  for (const [i, glyph] of [[selectedHello - 2, "╭"], [selectedHello + 2, "╰"]] as const) {
    assert.ok(!after[i]!.includes(bg));
    assert.ok(after[i]!.includes(theme.getFgAnsi("accent") + glyph));
    assert.equal(visibleWidth(after[i]!), 100);
  }
  assert.ok(after[selectedHello]!.includes(bg));
  assert.equal(selectedCard(after).split("\n").length, 5);
  assert.ok(after[selectedHello - 1]!.includes(bg) && after[selectedHello + 1]!.includes(bg));
});

test("role pairings preserve source order and adaptive selections", () => {
  const items: PickItem[] = [item("u", "user-text", "user"), item("a", "assistant-text"),
    { id: "t", kind: "tool-result", toolName: "bash", rawText: "tool-text" }, item("last", "last-text")];
  const s = setup(items); s.terminal.rows = 70; s.press(k.tools);
  for (let i = 0; i < items.length; i++) s.press(k.up);
  for (const current of items) {
    const lines = s.render();
    const card = selectedCard(lines);
    assert.ok(card.split("\n").length >= 3 && card.split("\n").length <= 9);
    assert.ok(card.includes(current.rawText));
    const list = s.cards().join("\n");
    const positions = items.map(entry => list.indexOf(entry.rawText));
    assert.ok(positions.every((pos, i) => pos >= 0 && (!i || pos > positions[i - 1]!)));
    assert.ok(lines.every(line => visibleWidth(line) === 100));
    s.press(k.down);
  }
});

test("mixed roles preserve source order and adaptive selections", () => {
  const items: PickItem[] = [item("u", "user-text", "user"), item("a", "assistant-text"),
    { id: "t", kind: "tool-result", toolName: "bash", rawText: "tool-text" }, item("last", "last-text")];
  const s = setup(items); s.terminal.rows = 70; s.press(k.tools);
  for (let i = 0; i < items.length; i++) s.press(k.up);
  for (const current of items) {
    const lines = s.render();
    const card = selectedCard(lines);
    assert.ok(card.split("\n").length >= 3 && card.split("\n").length <= 9);
    assert.ok(card.includes(current.rawText));
    const list = s.cards().join("\n");
    const positions = items.map(entry => list.indexOf(entry.rawText));
    assert.ok(positions.every((pos, i) => pos >= 0 && (!i || pos > positions[i - 1]!)));
    assert.ok(lines.every(line => visibleWidth(line) === 100));
    s.press(k.down);
  }
});

test("line windows preserve chronological order across resize and paging", () => {
  const s = setup(Array.from({ length: 9 }, (_, i) => item(`message-${i}`)));
  for (const rows of [30, 24, 20, 40, 30]) {
    s.terminal.rows = rows;
    s.press("message");
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const lines = s.render(50);
      assert.equal(lines.length, rows);
      assert.ok(lines.every(line => visibleWidth(line) === 50));
      seen.push(...lines.slice(3, dividerRow(rows) - 1).flatMap(line => stripTerminalSequences(line).match(/message-\d+/g) ?? []));
      s.press(k.right);
    }
    assert.deepEqual([...new Set(seen)], Array.from({ length: 9 }, (_, i) => `message-${i}`));
    for (let i = 0; i < 7; i++) s.press("\x7f");
  }
});

test("tall user cards summarize to nine rows without losing exact copy", async () => {
  const raw = "{\nfirst\n\nsecond\n}\nthird\nlast";
  const s = setup([item("u", raw, "user")]);
  for (const rows of [24, 25, 22, 27]) {
    s.terminal.rows = rows;
    const lines = s.render(32);
    assert.equal(lines.length, rows);
    assert.ok(lines.every(line => visibleWidth(line) === 32));
    assert.equal(selectedCard(lines).split("\n").length, 9);
    s.press(k.right); s.press(k.left);
  }
  s.press(k.enter); await settle(); assert.deepEqual(s.copied, [raw]);
});

test("user pages select reachable messages with shaded adaptive frames", () => {
  const s = setup([item("oldest", "oldest", "user"), item("middle", "middle", "user"), item("newest", "newest", "user")]);
  s.terminal.rows = 24;
  assert.ok(selectedCard(s.render()).includes("newest"));
  s.press(k.left);
  assert.ok(selectedCard(s.render()).includes("oldest"));
  s.press(k.down);
  assert.ok(selectedCard(s.render()).includes("middle"));
  assert.ok(selectedCard(s.render()).split("\n").length >= 3 && selectedCard(s.render()).split("\n").length <= 9);
  assert.match(stripTerminalSequences(s.render()[14]!), /^─+ preview ─+$/);
});

test("selection remains visible across every item, resize and page navigation", () => {
  const items = Array.from({ length: 25 }, (_, i): PickItem => i % 5 === 0
    ? { id: `entry-${i}`, rawText: `entry-${i}`, kind: "tool-result", toolName: "bash" }
    : item(`entry-${i}`, `entry-${i}`, i % 2 ? "assistant" : "user"));
  const s = setup(items);
  s.press(k.tools);
  const check = (id: string, width: number) => {
    const lines = s.render(width);
    const top = lines.slice(2, dividerRow(s.terminal.rows));
    const start = top.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
    const end = top.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╰"));
    assert.ok(top.slice(start + 1, end).some(line => new RegExp(`\\b${id}\\s`).test(stripTerminalSequences(line))), `${id} missing from selected frame`);
    assert.equal(top.filter(line => line.includes(theme.getFgAnsi("accent") + "╭")).length, 1);
    assert.equal(lines.length, s.terminal.rows);
  };
  for (const rows of [30, 24, 40, 22, 30]) for (const width of [32, 100]) {
    s.terminal.rows = rows;
    for (let i = 0; i < items.length; i++) s.press(k.up);
    for (let i = 0; i < items.length; i++) { check(items[i]!.id, width); s.press(k.down); }
    for (let i = items.length - 1; i >= 0; i--) { check(items[i]!.id, width); s.press(k.up); }
    const seen: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const lines = s.render(width).map(stripTerminalSequences);
      seen.push(...lines.slice(2, dividerRow(rows)).flatMap(line => line.match(/entry-\d+/g) ?? []));
      assert.ok(lines.slice(2, dividerRow(rows)).some(line => /^╭/.test(line)));
      s.press(k.right);
    }
    assert.deepEqual([...new Set(seen)], items.map(item => item.id));
    for (let i = 0; i < items.length; i++) s.press(k.left);
    check(items[0]!.id, width);
  }
});

test("page header dims only the tool note and arrows mark bounded previous and next pages", () => {
  const s = setup(Array.from({ length: 56 }, (_, i) => item(`message-${i}`, `message-${i}`, "user")));
  s.terminal.rows = 24;
  for (let i = 0; i < 30; i++) s.press(k.left);
  const check = (page: number, previous: boolean, next: boolean) => {
    const lines = s.render();
    const plain = lines.map(stripTerminalSequences);
    assert.equal(plain[0]!.trimEnd(), "Enter copy · ←/→ prev/next page · Ctrl+T tools · PgUp/PgDn scroll preview · Esc close");
    assert.ok(plain[1]!.startsWith(`Page ${page}/23 (tool messages excluded), type to search > `));
    assert.ok(lines[1]!.includes(theme.fg("dim", "(tool messages excluded)")));
    for (const [index, shown, glyph] of [[2, previous, "..."], [13, next, "..."]] as const) {
      assert.equal(index >= 0 && plain[index]!.trim() === glyph, shown);
      if (shown) {
        assert.equal(plain[index]!.indexOf(glyph), 2);
        assert.ok(lines[index]!.includes(theme.fg("muted", glyph)));
      }
    }
  };
  check(1, false, true);
  s.press(k.right); check(2, true, true);
  for (let i = 0; i < 30; i++) s.press(k.right);
  check(23, true, false);
  s.press(k.tools);
  assert.ok(s.render()[1]!.includes(theme.fg("dim", "(tool messages included)")));
  s.press("no-match");
  const empty = s.plain();
  assert.match(empty[1]!, /Page 1\/1/);
  assert.equal(empty[2]!.trim(), "");
  assert.equal(empty[13]!.trim(), "");
  assert.ok(!empty.slice(1).some(line => /^[ ]*[⌃⌄][ ]*$/.test(line)));
  const only = setup([item("one")]);
  assert.ok(!only.plain().slice(1).some(line => /^[ ]*[⌃⌄][ ]*$/.test(line)));
});

test("next-page arrow remains at the list bottom", () => {
  const s = setup([item("first", "short"), item("second", "one\ntwo\nthree", "user"), item("third", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight", "user")]);
  s.terminal.rows = 30;
  s.press("o");
  const lines = s.plain();
  assert.equal(lines[dividerRow(30) - 1]!.trim(), "...");
  assert.match(lines[dividerRow(30)]!, /^─+ preview ─+$/);
});

test("user preview is padded, unshaded and scrolls to the original end", async () => {
  const raw = Array.from({ length: 100 }, (_, i) => `row-${i} ${"x".repeat(90)}`).join("\n");
  const s = setup([item("long-user", raw, "user")]);
  const lines = s.render();
  assert.equal(lines[19], " ".repeat(100));
  assert.ok(stripTerminalSequences(lines[20]!).startsWith(" row-0 "));
  assert.equal(visibleWidth(lines[20]!.trimEnd()), 97);
  assert.ok(lines.slice(19).every(line => !line.includes(theme.getBgAnsi("userMessageBg"))));
  assert.equal(stripTerminalSequences(lines.at(-1)!).trim(), "...");
  for (let i = 0; i < 100; i++) s.press(k.pgdown);
  const bottom = s.render();
  assert.ok(stripTerminalSequences(bottom.at(-1)!).startsWith(" row-99 "));
  assert.ok(!stripTerminalSequences(bottom.at(-1)!).includes("..."));
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, [raw]);
});

test("widths 32 through 100 preserve exact viewport rows, visible selection and editable narrow search", () => {
  const s = setup([item("u", "user-text", "user"), item("a", "assistant-text"),
    { id: "t", kind: "tool-result", rawText: "tool-text", toolName: "bash" }]);
  s.press(k.tools);
  for (let width = 32; width <= 100; width++) {
    for (const key of [k.up, k.down, k.left, k.right]) {
      s.press(key);
      const lines = s.render(width);
      assert.equal(lines.length, 30);
      assert.ok(lines.every(line => visibleWidth(line) === width));
      const list = lines.slice(3, 17);
      assert.equal(list.filter(line => line.includes(theme.getFgAnsi("accent") + "╭")).length, 1);
      assert.equal(list.filter(line => line.includes(theme.getFgAnsi("accent") + "╰")).length, 1);
    }
  }
  s.press("assistant");
  assert.match(stripTerminalSequences(s.render(32)[1]!), /type to search > assistant/);
});

test("tool and user pages reserve the outer user boundary without extra tool boundaries", () => {
  const s = setup([item("u", "user-text", "user"), { id: "t", kind: "tool-result", rawText: "tool-text", toolName: "bash" }]);
  s.terminal.rows = 22;
  s.press(k.tools);
  for (const [key, expected] of [[k.down, "tool-text"], [k.up, "user-text"]] as const) {
    s.press(key);
    const lines = s.render();
    assert.match(stripTerminalSequences(lines[1]!), /Page \d+\/\d+/);
    assert.ok(lines.slice(3, dividerRow(s.terminal.rows)).some(line => line.includes(expected)));
    assert.equal(lines.length, 22);
  }
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const list = s.render().slice(3, dividerRow(s.terminal.rows)).map(stripTerminalSequences).join("\n");
    for (const text of ["user-text", "tool-text"]) if (list.includes(text)) seen.add(text);
    s.press(k.right);
  }
  assert.deepEqual([...seen].sort(), ["tool-text", "user-text"]);
});


test("first and last user selections shade actual content without shading preview", () => {
  const s = setup([item("first", "first-user", "user"), item("middle", "middle-agent"), item("last", "last-user", "user")]);
  s.terminal.rows = 40;
  for (const text of ["last-user", "first-user"]) {
    if (text === "first-user") { s.press(k.up); s.press(k.up); }
    const lines = s.render();
    const start = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
    const frame = lines.slice(start, start + 5);
    const bg = theme.getBgAnsi("userMessageBg");
    assert.ok(selectedCard(lines).includes(text));
    assert.equal(frame.length, 5);
    assert.ok(frame.slice(1, 4).every(line => line.includes(bg)));
    assert.ok(!frame[0]!.includes(bg) && !frame[4]!.includes(bg));
    assert.ok(lines.slice(dividerRow(40) + 1).every(line => !line.includes(bg)));
  }
});

test("single user needs five list rows through resize", () => {
  const s = setup([item("single", "single-user", "user")]);
  for (const rows of [15, 16, 15, 16]) {
    s.terminal.rows = rows;
    const lines = s.render(32);
    assert.equal(lines.length, rows);
    assert.ok(lines.every(line => visibleWidth(line) === 32));
    const frame = selectedCard(lines).split("\n");
    assert.equal(frame.length, 5);
    assert.match(frame[2]!, /^│ single-user +│$/);
  }
});

test("arrows visit parent and each code block in source order and copy only that entity", async () => {
  const raw = "Intro **bold**.\nSecond intro.\n\n```markdown\nconst first = 1;\n```\n\nBetween.\nSecond description.\n\n```js\nprint('second')\n```\n\nFinal.\nLast line.";
  const targets = [raw, "const first = 1;", "print('second')", "next"];
  for (let index = 0; index < targets.length; index++) {
    const s = setup([item("rich", raw), item("next")]);
    s.terminal.rows = 45;
    for (let n = 0; n < targets.length + 2; n++) s.press(k.up);
    for (let n = 0; n < index; n++) s.press(k.down);
    const lines = s.render();
    const card = selectedCard(lines);
    const preview = lines.slice(dividerRow(s.terminal.rows) + 2).map(stripTerminalSequences).join("\n");
    if (index > 0 && index < targets.length - 1) {
      const text = targets[index]!.includes("const first") ? "const first" : targets[index]!.includes("second") ? "print('second')" : targets[index]!.split(/[ .*]/)[0]!;
      assert.ok(card.includes(text), card);
      assert.ok(preview.includes(text), preview);
      if (index === 1) assert.ok(!preview.includes("second") && !preview.includes("Between"));
      if (index === 2) assert.ok(!preview.includes("const first") && !preview.includes("Final"));
      const framed = lines.find(line => line.includes(theme.getFgAnsi("accent") + "╭"))!;
      assert.ok(stripTerminalSequences(framed).startsWith("  ╭"));
      assert.ok(!framed.includes(theme.getBgAnsi("userMessageBg")));
    }
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [targets[index]]);
    assert.deepEqual(s.results, ["copied"]);
  }
  for (let index = targets.length - 1; index >= 0; index--) {
    const s = setup([item("rich", raw), item("next")]);
    for (let n = 0; n < targets.length - 1 - index; n++) s.press(k.up);
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [targets[index]]);
  }
});

test("whole-message search clears child selection and scrolling resets on target changes", async () => {
  const raw = "# Heading\n\n```js\n" + Array.from({ length: 30 }, (_, i) => `const row${i} = ${i};`).join("\n") + "\n```\n\nTail";
  const s = setup([item("rich", raw)]);
  s.press(k.down); s.press(k.down);
  s.press(k.end);
  assert.ok(s.plain().slice(-3).some(line => line.includes("row29")));
  s.press("Heading");
  s.terminal.rows = 24;
  assert.ok(s.render(40).some(line => line.includes("Use ↑/↓ to select a message")));
  s.press(k.enter);
  s.press(k.up);
  const lines = s.render(40);
  assert.ok(lines.slice(16).some(line => stripTerminalSequences(line).includes("Heading")));
  s.press(k.down);
  assert.ok(s.render(40).slice(16).some(line => stripTerminalSequences(line).includes("row0")));
  s.press(k.enter); await settle();
  assert.equal(s.copied[0], raw.split("```js\n")[1]!.split("```")[0]!.replace(/\n+$/, ""));
});

test("same-language code children have independent previews and clipboard payloads", async () => {
  for (const [steps, expected, absent] of [[1, "const first = 1;", "const second"], [2, "const second = 2;", "const first"]] as const) {
    const s = setup([item("same", "```js\nconst first = 1;\n```\n```js\nconst second = 2;\n```")]);
    for (let i = 0; i < steps; i++) s.press(k.down);
    const lines = s.render();
    const card = selectedCard(lines);
    const preview = lines.slice(20).map(stripTerminalSequences).join("\n");
    assert.ok(card.includes(expected.trim()) && preview.includes(expected.trim()));
    assert.ok(!card.includes(absent) && !preview.includes(absent));
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [expected]);
  }
});

test("code child wraps long highlighted source lines and marks hidden payload without changing copy", async () => {
  const code = `const long = "${"中👨‍👩‍👧‍👦é".repeat(100)}SUFFIX";\nconst beta = 2;\nreturn beta;\n`;
  const s = setup([item("long-code", `\`\`\`js\n${code}\`\`\``)]);
  s.press(k.down);
  for (const width of [40, 72, 40]) {
    const lines = s.render(width);
    const card = selectedCard(lines);
    assert.ok(card.includes("const long") && card.includes("..."));
    assert.ok(lines.every(line => visibleWidth(line) === width));
    s.press(k.pgdown);
    s.press(k.end);
    const bottom = s.render(width).slice(20);
    assert.ok(bottom.map(stripTerminalSequences).join("\n").includes("SUFFIX"));
    assert.ok(bottom.some(line => line.includes("\x1b[")));
    assert.ok(!bottom.map(stripTerminalSequences).join("\n").includes("�"));
  }
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, [code.replace(/\n+$/, "")]);
});


test("code preview preserves CR and mixed line boundaries while copy preserves original separators", async () => {
  const raw = "Example:\r\n\r\n```js\rconst one = 1;\rconst two = 2;\r\n```\r";
  const s = setup([item("mixed-lines", raw)]);
  s.press(k.down);
  const rendered = s.plain();
  const divider = rendered.findIndex(line => /^─+ preview ─+$/.test(line));
  assert.ok(divider >= 0);
  const preview = rendered.slice(divider + 1);
  const one = preview.findIndex(line => line.includes("const one = 1;"));
  const two = preview.findIndex(line => line.includes("const two = 2;"));
  assert.ok(one >= 0 && two > one, preview.join("\n"));
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, ["const one = 1;\rconst two = 2;"]);
});
test("headings are not stops, fenced child cards keep source syntax and highlighted payload previews", async () => {
  const js = "{\nconst first = 1;\n\nconst second = 2;\n}\nreturn first + second;\nconst omitted = 4;\n";
  const py = "def hello():\n    first = 1\n    return first\n";
  const raw = `### JavaScript\n\n\`\`\`javascript\n${js}\`\`\`\n\n### Python\n\n~~~python\n${py}~~~`;
  const expected = [raw, js.replace(/\n+$/, ""), py.replace(/\n+$/, ""), "next"];
  for (const width of [32, 100]) for (let index = 0; index < expected.length; index++) {
    const s = setup([item("rich", raw, "user"), item("next")]);
    s.terminal.rows = 40;
    for (let i = 0; i < 6; i++) s.press(k.up);
    for (let i = 0; i < index; i++) s.press(k.down);
    const rendered = s.render(width);
    assert.equal(rendered.length, 40);
    assert.ok(rendered.every(line => visibleWidth(line) === width));
    const card = index === 0 ? rendered.slice(3, dividerRow(s.terminal.rows)).map(stripTerminalSequences).join("\n") : selectedCard(rendered);
    assert.ok(!/Markdown|Code ·/.test(card));
    if (index === 1 || index === 2) {
      const fence = index === 1 ? "```" : "~~~";
      assert.ok(card.includes(fence + (index === 1 ? "javascript" : "python")), card);
      assert.equal(card.split(fence).length - 1, index === 1 ? 1 : 2);
      const snippets = index === 1 ? ["const first", "const second"] : ["def hello", "first = 1", "return first"];
      for (const snippet of snippets) assert.ok(card.includes(snippet), card);
      assert.ok(rendered.slice(3, 23).some(line => line.includes("\x1b[") && stripTerminalSequences(line).includes(snippets[0]!)));
      const preview = rendered.slice(26).map(stripTerminalSequences).join("\n");
      assert.ok(!/```|~~~|###|Code ·|Markdown/.test(preview), preview);
      assert.ok(preview.includes(snippets[0]!));
    }
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [expected[index]]);
  }
});

test("tilde, unclosed, indented and nested code cards never invent fences or labels", async () => {
  for (const [raw, opening, closing, payload] of [
    ["~~~~python\nprint(1)\n~~~~", "~~~~python", "~~~~", "print(1)\n"],
    ["````js\nconst x = 1;", "````js", "", "const x = 1;"],
    ["    const x = 1;\n    const y = 2;", "", "", "const x = 1;\nconst y = 2;"],
    ["> - nested\n>\n>   ~~~python\n>   print(1)\n>   ~~~", ">   ~~~python", ">   ~~~", "print(1)\n"],
  ]) {
    const s = setup([item("rich", raw!)]);
    s.terminal.rows = 40;
    s.press(k.down);
    if (raw!.startsWith("> -")) s.press(k.down);
    const card = selectedCard(s.render(32));
    assert.ok(!/Markdown|Code ·/.test(card));
    if (opening) assert.ok(card.includes(opening), card);
    if (closing) assert.ok(card.includes(closing), card);
    if (!opening) assert.ok(!/```|~~~/.test(card), card);
    if (opening && !closing) assert.equal(card.split(opening.slice(0, 4)).length - 1, 1);
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [payload!.replace(/(?:\r\n|\n|\r)+$/, "")]);
  }
});

test("multiline prose remains in the message through paging and whole-message search", async () => {
  const prose = "First paragraph line\nsecond paragraph line\n";
  const raw = `### hidden stop\n\n${prose}\n\`\`\`js\nx\n\`\`\``;
  const s = setup([item("plain", "standalone\n\nnon-rich"), item("rich", raw), item("last")]);
  s.terminal.rows = 40;
  for (let i = 0; i < 10; i++) s.press(k.up);
  s.press(k.down);
  s.press(k.down);
  assert.ok(selectedCard(s.render(32)).includes("x"));
  s.press("hidden stop");
  assert.ok(s.render(32).some(line => line.includes("Use ↑/↓ to select a message")));
  s.press(k.enter);
  s.press(k.right); s.press(k.left);
  for (let i = 0; i < 5; i++) s.press(k.up);
  s.press(k.down);
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, ["x"]);
});


test("copy removes only trailing code newlines, preserving indentation and internal blanks", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const code = `    if ready:${newline}${newline}        run()  ${newline}${newline}`;
    const raw = `\`\`\`python${newline}${code}\`\`\`${newline}`;
    const s = setup([item("code", raw)]);
    s.press(k.down); s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [`    if ready:${newline}${newline}        run()  `]);
  }
});
test("Enter sends exact parent or code bytes through the real OSC52 clipboard helper", { skip: process.platform !== "linux" }, async t => {
  const env = { ...process.env };
  const output: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const mock = t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    const text = String(chunk);
    if (text.startsWith("\x1b]52;")) { output.push(text); return true; }
    return write(chunk);
  });
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  delete process.env.TERMUX_VERSION;
  process.env.PI_CLIPBOARD_OSC52 = "1";
  try {
    const payload = "const 原文 = 1;  \r\n\treturn 原文;\r\n";
    const raw = `### JavaScript\r\n\r\n\`\`\`js\r\n${payload}\`\`\`\r\n`;
    for (const child of [false, true]) {
      const s = setup([item("raw", raw)], copyToClipboard);
      if (child) s.press(k.down);
      s.press(k.enter); await settle();
      assert.equal(output.at(-1), `\x1b]52;c;${Buffer.from(child ? payload.replace(/(?:\r\n|\n|\r)+$/, "") : raw).toString("base64")}\x07`);
      assert.deepEqual(s.results, ["copied"]);
    }
    const inlineRaw = "Report:\r\n\r\n`` /tmp/example/`report`.html ``\r\n\r\nDone.";
    for (const child of [false, true]) {
      const s = setup([item("inline", inlineRaw)], copyToClipboard);
      if (child) s.press(k.down);
      s.press(k.enter); await settle();
      const expected = child ? " /tmp/example/`report`.html " : inlineRaw;
      assert.equal(output.at(-1), `\x1b]52;c;${Buffer.from(expected).toString("base64")}\x07`);
    }
    assert.equal(output.length, 4);
  } finally {
    mock.mock.restore();
    for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION", "PI_CLIPBOARD_OSC52"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  }
});

test("whole-message summary starts with rendered Chinese prose and headings, while code children retain source fences", () => {
  const prose = ["先检查当前配置，再运行下面的示例。", "这一步不会修改已有文件。", "确认结果后再继续操作。"];
  for (const heading of ["", "## 操作说明\n\n"]) {
    const raw = heading + prose.join("\n") + "\n\n```js\nconst alpha = 1;\nconst beta = 2;\nreturn alpha + beta;\n```";
    const s = setup([item("chinese", raw)]);
    s.terminal.rows = 60;
    const rendered = s.render();
    const card = selectedCard(rendered);
    assert.ok(card.includes(prose[0]!), card);
    if (!heading) assert.ok(card.includes(prose[1]!), card);
    assert.equal(card.split("\n").length, 9);
    assert.ok(card.includes("..."), card);
    const preview = rendered.slice(38).map(stripTerminalSequences).filter(line => line.trim());
    assert.ok(preview[0]!.includes(heading ? "操作说明" : prose[0]!), preview.join("\n"));
    if (heading) {
      assert.ok(card.indexOf("操作说明") < card.indexOf(prose[0]!), card);
      assert.ok(card.includes("## 操作说明"));
    } else assert.ok(card.includes(prose[2]!), card);
    s.press(k.down);
    const code = selectedCard(s.render());
    assert.equal(code.split("```").length - 1, 2);
    for (const text of ["const alpha", "const beta", "return alpha"]) assert.ok(code.includes(text), code);
    assert.ok(!code.includes(prose[0]!), code);
  }
});

test("wrapped one-line quote is a distinct downward stop with Markdown preview and exact plain copy", async () => {
  const quote = "Hi team, Analytics → Reliability is flagging new-format reports for missing Overview. The current Dashboard validator passes the reports I checked. Has the Dashboard version with this fix been deployed, and has the reliability snapshot been refreshed?";
  const raw = `可以在群里这样问：\n\n> ${quote}`;
  for (const [steps, expected] of [[0, raw], [1, quote], [2, "next"]] as const) {
    const s = setup([item("quote", raw), item("next")]);
    s.terminal.rows = 60;
    for (let i = 0; i < 5; i++) s.press(k.up);
    for (let i = 0; i < steps; i++) s.press(k.down);
    const lines = s.render(40);
    selectedCard(lines);
    if (steps === 1) {
      const preview = lines.slice(38).map(stripTerminalSequences).join("\n");
      assert.ok(preview.includes("Hi team"), preview);
      assert.ok(preview.includes("│"), preview);
      assert.ok(!preview.includes("可以在群里"), preview);
      s.press(k.end);
      assert.ok(s.render(40).slice(38).map(stripTerminalSequences).join("\n").includes("refreshed?"));
    }
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [expected]);
    if (steps === 1) assert.ok(!/[>│]/.test(s.copied[0]!));
  }
});

test("quote copy preserves paragraphs, CRLF, nested markers, spaces and lazy lines", async () => {
  for (const nl of ["\n", "\r\n"]) {
    const raw = [">  first  ", ">", ">\tsecond\t ", "> > nested", "lazy  ", ">", ">"].join(nl) + nl;
    const s = setup([item("quote", raw)]);
    s.press(k.down); s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [[" first  ", "", "second\t ", "> nested", "lazy  "].join(nl)]);
  }
});

test("quote prose and quoted code remain separate clipboard targets in source order", async () => {
  const raw = "> before\n> ```text\n> > literal code\n> ```\n> after\n\nordinary first\nordinary second\n";
  const expected = [raw, "before", "> literal code", "after", "next"];
  for (let index = 0; index < expected.length; index++) {
    const s = setup([item("quoted-code", raw), item("next")]);
    for (let i = 0; i < 10; i++) s.press(k.up);
    for (let i = 0; i < index; i++) s.press(k.down);
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [expected[index]]);
  }
});

test("selected blocks replace the original summary once and keep neighboring messages visible", async () => {
  const quote = "Unique quoted payload";
  const raw = `Intro\n\n> ${quote}\n\n\`\`\`js\nconst uniqueJS = 1;\n\`\`\`\n\n~~~python\nprint('uniquePY')\n~~~`;
  const payloads = [raw, quote, "const uniqueJS = 1;", "print('uniquePY')", "neighbor-after"];
  for (const kind of ["user", "assistant"] as const) for (let selected = 0; selected < payloads.length; selected++) {
    const s = setup([item("before", "neighbor-before", "user"), item("rich", raw, kind), item("after", "neighbor-after")]);
    s.terminal.rows = 60;
    for (let i = 0; i < 8; i++) s.press(k.up);
    s.press(k.down);
    s.render(72);
    for (let i = 0; i < selected; i++) s.press(k.down);
    const lines = s.render(72);
    const list = lines.slice(3, 35).map(stripTerminalSequences).join("\n");
    for (const text of ["neighbor-before", "neighbor-after"]) {
      assert.equal(list.split(text).length - 1, 1, list);
    }
    assert.match(stripTerminalSequences(lines[1]!), /Page 1\/1/);
    assert.equal(lines.slice(3, 35).filter(line => line.includes(theme.getFgAnsi("accent") + "╭")).length, 1);
    if (selected > 0 && selected < 4) {
      const marker = ["", quote, "const uniqueJS", "uniquePY"][selected]!;
      assert.equal(list.split(marker).length - 1, 1, list);
      if (selected === 1) assert.ok(list.includes("Intro"), list);
      const card = selectedCard(lines);
      assert.ok(card.includes(marker), card);
      if (selected === 1) assert.match(card, /│.*> Unique quoted payload/);
    }
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [payloads[selected]]);
  }
});

test("message-grouped pages keep every distant block reachable through resize, search and tools", () => {
  const raw = `Intro one\n\nIntro two\n\nIntro three\n\n> distantQuote\n\n\`\`\`js\n${Array.from({ length: 50 }, (_, i) => `const row${i} = ${i};`).join("\n")}\n\`\`\`\n\n~~~python\nprint('distantPython')\n~~~`;
  const s = setup([item("before"), item("rich", raw, "user"), item("after"), { id: "tool", kind: "tool-result", toolName: "bash", rawText: "tool-body" }]);
  const markers = ["Intro one", "distantQuote", "const row0", "distantPython"];
  for (const rows of [24, 30, 60, 24]) for (const width of [32, 72]) {
    s.terminal.rows = rows;
    for (let i = 0; i < 9; i++) s.press(k.up);
    s.press(k.down);
    assert.match(stripTerminalSequences(s.render(width)[1]!), /Page \d+\/\d+/);
    for (const marker of markers) {
      const lines = s.render(width);
      assert.equal(lines.length, rows);
      assert.ok(lines.every(line => visibleWidth(line) === width));
      const visible = marker === "Intro one" ? lines.slice(3, dividerRow(rows)).map(stripTerminalSequences).join("\n") : selectedCard(lines);
      assert.ok(visible.includes(marker), marker);
      assert.match(stripTerminalSequences(lines[1]!), /Page \d+\/\d+/);
      s.press(k.down);
    }
  }
  s.press("Intro one");
  s.press(k.enter);
  for (let i = 0; i < 9; i++) s.press(k.up);
  s.press(k.down); s.press(k.down);
  s.press(k.tools);
  assert.ok(selectedCard(s.render(40)).includes("const row0"));
  s.press(k.end);
  assert.ok(s.render(40).slice(16).map(stripTerminalSequences).join("\n").includes("row49"));
});

test("quote summaries mark only source omitted by the seven-row budget", () => {
  const raw = "可以在群里这样问：\n\n> Hi team,\n>\n>\n> Analytics → Reliability 已更新。";
  for (const kind of ["assistant", "user"] as const) for (const child of [false, true]) {
    const s = setup([item("quote", raw, kind)]); s.terminal.rows = 60;
    if (child) s.press(k.down);
    const frame = selectedCard(s.render(72)).split("\n");
    assert.equal(frame.length, child ? 6 : kind === "user" ? 9 : 8);
    assert.ok(frame.some(line => line.includes("Hi team,")));
    assert.equal(frame.some(line => line.includes("Analytics")), child || kind === "assistant");
    assert.equal(frame.join("\n").includes("..."), !child && kind === "user");
  }
});

test("selected parent and child padding keeps contiguous exact-width side borders", () => {
  const raw = "可以在群里这样问：\n\n> Hi team,\n>\n> Analytics 已更新。\n\n```js\nconst first = 1;\nconst second = 2;\nreturn first + second;\n```";
  for (const kind of ["assistant", "user"] as const) for (const steps of [0, 1]) for (const width of [40, 72]) {
    const s = setup([item("quote", raw, kind)]);
    s.terminal.rows = 60;
    for (let i = 0; i < steps; i++) s.press(k.down);
    const lines = s.render(width);
    const start = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
    const end = lines.findIndex((line, i) => i > start && line.includes(theme.getFgAnsi("accent") + "╰"));
    assert.ok(start >= 0 && end > start);
    const inset = steps ? 2 : 0;
    for (const line of lines.slice(start + 1, end)) {
      const plain = stripTerminalSequences(line);
      assert.equal(plain[inset], "│", plain);
      assert.equal(plain.trimEnd().at(-1), "│", plain);
      assert.equal(visibleWidth(line), width);
    }
  }
});

test("distinct repeated messages remain independently visible and selectable", async () => {
  const raw = "Hi team,\n\nAnalytics 已更新。";
  const s = setup([item("first", raw), item("second", raw)]);
  s.terminal.rows = 60;
  assert.equal(s.cards().join("\n").split("Hi team,").length - 1, 2);
  s.press(k.up);
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, [raw]);
});

test("formatting-only previews have no omission while informative tails do", () => {
  for (const raw of ["\n \n", ">\n>\n>"]) {
    const s = setup([item("empty", raw)]);
    assert.equal(selectedCard(s.render()).includes("..."), raw.startsWith("\n"));
  }
  const s = setup([item("tail", "first\n\nsecond\n\nthird\n\nfourth")]);
  const card = selectedCard(s.render());
  assert.equal(card.split("\n").length, 9);
  assert.ok(!card.includes("..."));
  s.press(k.end);
  assert.ok(s.plain().some(line => line.includes("fourth")));
});

test("separate quote messages retain source order without duplicating the selected child", () => {
  const s = setup([
    item("first", "可以在群里这样问：\n\n> Hi team,\n>\n> Analytics 已更新。"),
    item("second", "另一条消息：\n\n> Hi team,\n>\n> Dashboard 尚未更新。"),
  ]);
  s.terminal.rows = 60;
  for (let i = 0; i < 5; i++) s.press(k.up);
  const parent = selectedCard(s.render(72));
  assert.ok(parent.indexOf("可以在群里") < parent.indexOf("Hi team,"), parent);
  assert.equal(parent.split("\n").length, 7);
  assert.ok(!parent.includes("..."), parent);
  s.press(k.down);
  const list = s.render(72).slice(3, 35).map(stripTerminalSequences).join("\n");
  assert.equal(list.split("Hi team,").length - 1, 2, list);
  assert.equal(list.split("Analytics").length - 1, 1, list);
  assert.equal(list.split("Dashboard").length - 1, 1, list);
  assert.ok(!selectedCard(s.render(72)).includes("可以在群里"));
});

function assertUnselected(s: ReturnType<typeof setup>, width = 100): void {
  const lines = s.render(width);
  assert.ok(!lines.some(line => line.includes(theme.getFgAnsi("accent") + "╭")));
  const start = dividerRow(s.terminal.rows) + 2;
  const preview = lines.slice(start);
  const prompt = "Use ↑/↓ to select a message";
  const index = Math.floor((preview.length - 1) / 2);
  assert.equal(stripTerminalSequences(preview[index]!).trim(), prompt);
  assert.equal(stripTerminalSequences(preview[index]!).indexOf(prompt), Math.floor((width - visibleWidth(prompt)) / 2));
  assert.ok(preview[index]!.includes(theme.fg("dim", prompt)));
  assert.ok(preview.every((line, row) => row === index || !stripTerminalSequences(line).trim()));
  assert.ok(lines.every(line => visibleWidth(line) === width));
}

test("repeated Enter never selects or copies; an arrow activates the visible message", async () => {
  for (const arrow of [k.up, k.down]) {
    const s = setup([item("first", "keyword first"), item("last", "keyword last")]);
    s.press("keyword");
    assertUnselected(s);
    s.press(k.enter);
    for (let i = 0; i < 10; i++) s.press(k.enter);
    await settle();
    assert.deepEqual(s.copied, []);
    assert.deepEqual(s.results, []);
    assertUnselected(s);
    s.press(arrow);
    const expected = arrow === k.up ? "keyword last" : "keyword first";
    assert.ok(selectedCard(s.render()).includes(expected));
    assert.ok(s.plain().slice(20).join("\n").includes(expected));
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [expected]);
  }
});

test("unfocused pagination, tools, scrolling, resize and invalidation cannot reactivate selection", async () => {
  const s = setup([...Array.from({ length: 15 }, (_, i) => item(`m${i}`, `keyword ${i}`)),
    { id: "t", kind: "tool-call", toolName: "bash", rawText: "keyword tool" }]);
  s.press("keyword"); s.press(k.enter);
  assert.match(s.plain()[1]!, /Page 1\/3/);
  s.press(k.right);
  assert.match(s.plain()[1]!, /Page 2\/3/);
  for (const key of [k.tools, k.pgdown, k.end, k.left, k.right, k.enter]) {
    s.press(key); assertUnselected(s);
  }
  s.picker.invalidate();
  for (const rows of [24, 60, 30]) for (const width of [32, 41, 100]) {
    s.terminal.rows = rows; assertUnselected(s, width);
  }
  const visible = s.render().slice(3, dividerRow(s.terminal.rows)).map(stripTerminalSequences).find(line => /keyword \d+/.test(line))!.match(/keyword \d+/)![0];
  s.press(k.down);
  assert.ok(selectedCard(s.render()).includes(visible));
  s.press("x"); assertUnselected(s);
  assert.match(s.cards().join("\n"), /No matching messages/);
  s.press(k.enter); s.press(k.down); s.press(k.enter);
  assertUnselected(s);
  assert.deepEqual(s.copied, []);
});

test("clearing a nonmatching query restores messages and arrows activate immediately", async () => {
  for (const arrow of [k.up, k.down]) for (const clear of ["backspace", "ctrl-k"]) {
    const s = setup([item("first", "first message"), item("last", "last message")]);
    s.press("nonmatch");
    assert.match(s.cards().join("\n"), /No matching messages/);
    s.press(k.up); s.press(k.down); assertUnselected(s);
    if (clear === "backspace") for (let i = 0; i < 8; i++) s.press("\x7f");
    else { s.press("\x01"); s.press("\x0b"); }
    assertUnselected(s);
    assert.match(s.plain()[1]!, /Page 1\/1/);
    assert.match(s.cards().join("\n"), /first message/);
    assert.match(s.cards().join("\n"), /last message/);
    s.press(arrow);
    const expected = arrow === k.up ? "last message" : "first message";
    assert.ok(selectedCard(s.render()).includes(expected));
    assert.ok(s.plain().slice(20).join("\n").includes(expected));
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, [expected]);
  }
});

test("clearing search restores the last page without reactivating selection", async () => {
  for (const query of ["message 1", "no match"]) for (const clear of ["backspace", "ctrl-k"]) {
    const s = setup(Array.from({ length: 25 }, (_, i) => item(`m${i}`, `message ${i}`)));
    const initialPage = s.plain()[1]!.match(/Page (\d+)\/(\d+)/);
    assert.ok(initialPage);
    assert.equal(initialPage[1], initialPage[2]);
    assert.ok(Number(initialPage[1]) > 1);
    s.press(query);
    assertUnselected(s);
    if (clear === "backspace") for (let i = 0; i < query.length; i++) s.press("\x7f");
    else { s.press("\x01"); s.press("\x0b"); }
    assertUnselected(s);
    assert.match(s.plain()[1]!, new RegExp(`Page ${initialPage[1]}/${initialPage[2]}`));
    assert.match(s.cards().join("\n"), /message 24/);
    s.press(k.enter); s.press(k.enter); await settle();
    assert.deepEqual(s.copied, []);
    s.press(k.up);
    assert.ok(selectedCard(s.render()).includes("message 24"));
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, ["message 24"]);
  }
});

test("pasted search activates immediately and cursor movement does not clear selection", async () => {
  const s = setup([item("original")]);
  s.press("\x1b[200~original\x1b[201~"); assertUnselected(s);
  s.press(k.down); assert.ok(selectedCard(s.render()).includes("original"));
  s.press("\x01"); s.press("\x7f");
  assert.ok(selectedCard(s.render()).includes("original"));
  s.press(k.enter); await settle(); assert.deepEqual(s.copied, ["original"]);
});

test("typing a search then Down previews and copies without Enter confirmation", async () => {
  const s = setup([item("first", "keyword first"), item("other", "other")]);
  s.press("keyword"); assertUnselected(s);
  s.press(k.down);
  assert.ok(selectedCard(s.render()).includes("keyword first"));
  assert.ok(s.plain().slice(20).join("\n").includes("keyword first"));
  s.press(k.enter); await settle(); assert.deepEqual(s.copied, ["keyword first"]);
});

test("configured submit keys do not copy without a selection", async () => {
  const copied: string[] = [];
  const picker = new PickerScreen([item("original")], { terminal: { rows: 30 }, requestRender() {} } as unknown as TUI,
    theme, new KeybindingsManager({ ...TUI_KEYBINDINGS, "ui.editor.submit": { defaultKeys: "ctrl+s", description: "Submit" } }),
    () => {}, async text => { copied.push(text); });
  picker.handleInput("original");
  for (let i = 0; i < 10; i++) picker.handleInput("\x13");
  assert.deepEqual(copied, []);
  picker.handleInput(k.down); picker.handleInput("\x13"); await settle();
  assert.deepEqual(copied, ["original"]);
});

test("focus changes and a late clipboard failure cannot restore search selection", async () => {
  let fail!: (error: Error) => void;
  const calls: string[] = [];
  const s = setup([item("original")], text => {
    calls.push(text);
    return new Promise<void>((_, reject) => { fail = reject; });
  });
  s.press(k.enter);
  assert.match(s.plain()[1]!, /Copying/);
  s.press("original"); s.press(k.enter);
  assertUnselected(s);
  s.picker.focused = false; s.picker.focused = true;
  fail(new Error("late failure")); await settle();
  assert.match(s.plain()[1]!, /Copy failed: late failure/);
  for (let i = 0; i < 10; i++) s.press(k.enter);
  assertUnselected(s);
  assert.deepEqual(calls, ["original"]);
  s.press(k.esc); assert.deepEqual(s.results, [undefined]);
});

test("Up activates the last message on the current unfocused page and tool frames stay dim", () => {
  const s = setup([...Array.from({ length: 15 }, (_, i) => item(`m${i}`, `keyword ${i}`)),
    { id: "tool", kind: "tool-call", toolName: "bash", rawText: "keyword tool" }]);
  s.press("keyword"); s.press(k.enter); s.press(k.right); s.press(k.up);
  assert.ok(selectedCard(s.render()).includes("keyword 13"));
  s.press("\x15"); s.press("keyword tool"); s.press(k.enter); s.press(k.tools);
  assertUnselected(s);
  assert.ok(s.render().slice(3, 17).some(line => line.includes(theme.getFgAnsi("dim") + "╭")));
});

test("line windows expose clipped cards at both boundaries and keep arrows fixed", () => {
  const s = setup(Array.from({ length: 8 }, (_, i) => item(`u${i}`, `message ${i}`, "user")));
  s.terminal.rows = 24;
  s.press("message");
  let lines = s.plain();
  assert.equal(lines[13]!.trim(), "...");
  assert.ok(s.render().slice(3, 13).some(line => line.includes(theme.getBgAnsi("userMessageBg"))));
  s.press(k.right);
  lines = s.plain();
  assert.equal(lines[2]!.trim(), "...");
  assert.equal(lines[13]!.trim(), "...");
  assert.ok(lines.slice(3, 13).some(line => line.includes("message 2")));
  s.press(k.down);
  assert.ok(selectedCard(s.render()).includes("message 2"));
});

test("oversized source selection refuses copy in a tiny viewport and recovers", async () => {
  const raw = "{\nfirst\n\nsecond\n}\nthird\nlast";
  const s = setup([item("older"), item("tall", raw, "user"), item("newer")]);
  s.press(k.up); s.terminal.rows = 10;
  const lines = s.render(32);
  assert.equal(lines.length, 10);
  assert.ok(lines.every(line => visibleWidth(line) === 32));
  assert.match(stripTerminalSequences(lines[0]!), /Window too small/);
  s.press(k.enter); await settle(); assert.deepEqual(s.copied, []);
  s.terminal.rows = 30;
  assert.equal(selectedCard(s.render()).split("\n").length, 9);
  s.press(k.enter); await settle(); assert.deepEqual(s.copied, [raw]);
});

test("tiny viewports ignore navigation and copy while retaining editable search", async () => {
  for (const [width, rows] of [[0, 30], [1, 30], [31, 30], [100, 7]]) {
    const s = setup([item("first"), item("last")]);
    s.render();
    s.terminal.rows = rows!;
    s.render(width);
    for (const key of [k.left, k.right, k.up, k.down, k.tools, k.enter]) s.press(key);
    s.press("first");
    for (const key of [k.left, k.right, k.up, k.down, k.tools, k.enter]) s.press(key);
    await settle();
    assert.deepEqual(s.copied, []);
    s.terminal.rows = 30;
    assert.ok(s.plain().some(line => line.includes("Use ↑/↓ to select a message")));
    s.press(k.down); s.press(k.enter); await settle();
    assert.deepEqual(s.copied, ["first"]);
  }
  const s = setup([item("last")]);
  s.render(0); s.press(k.left); s.render(); s.press(k.enter); await settle();
  assert.deepEqual(s.copied, ["last"]);
});

test("page navigation visits each numbered page in both directions", () => {
  const s = setup(Array.from({ length: 15 }, (_, i) => item(`entry-${i}`)));
  const check = (page: number, previous: boolean, next: boolean) => {
    const lines = s.render().map(stripTerminalSequences);
    assert.match(lines[1]!, new RegExp(`Page ${page}/3`));
    assert.equal(lines[2]!.trim() === "...", previous);
    assert.equal(lines[17]!.trim() === "...", next);
    const list = lines.slice(3, 17).join("\n");
    const preview = lines.slice(20).join("\n").match(/entry-\d+/)?.[0];
    assert.ok(preview && list.includes(preview));
  };
  check(3, true, false);
  s.press(k.left); check(2, true, true);
  s.press(k.left); check(1, false, true);
  s.press(k.left); check(1, false, true);
  s.press(k.right); check(2, true, true);
  s.press(k.right); check(3, true, false);
  s.press(k.right); check(3, true, false);
});

test("compacted pages step backward and mixed blocks remain visible through paging and resize", async () => {
  const seven = setup(Array.from({ length: 12 }, (_, i) => item(`m${i}`, `m${i}a\nm${i}b\nm${i}c`)));
  seven.terminal.rows = 18;
  const lastPage = Number(seven.plain()[1]!.match(/Page (\d+)/)![1]);
  seven.press(k.left);
  assert.equal(Number(seven.plain()[1]!.match(/Page (\d+)/)![1]), lastPage - 1);

  const items = Array.from({ length: 12 }, (_, i) => item(`mixed-${i}`,
    i % 3 === 0 ? `mixed-${i}\n\n\`\`\`js\nconst value${i} = ${i};\n\`\`\`` : `mixed-${i}\nline ${i}`, i % 2 ? "user" : "assistant"));
  const s = setup(items);
  s.terminal.rows = 24;
  const page = () => {
    const lines = s.render().map(stripTerminalSequences);
    const match = lines[1]!.match(/Page (\d+)\/(\d+)/)!;
    const list = lines.slice(3, dividerRow(s.terminal.rows) - 1).join("\n");
    const preview = lines.slice(dividerRow(s.terminal.rows) + 2).join("\n").match(/mixed-\d+/)?.[0];
    assert.ok(preview && list.includes(preview), `${preview} not visible in ${list}`);
    return [Number(match[1]), Number(match[2])] as const;
  };
  let [current, total] = page();
  assert.equal(current, total);
  for (let step = 0; current > 1 && step < 30; step++) {
    s.press(k.left);
    const next = page();
    assert.ok(next[0] <= current);
    [current, total] = next;
    assert.ok(selectedCard(s.render()).split("\n").length >= 3 && selectedCard(s.render()).split("\n").length <= 9);
  }
  assert.equal(current, 1);
  for (let step = 0; current < total && step < 30; step++) {
    s.press(k.right);
    const next = page();
    assert.ok(next[0] >= current);
    [current, total] = next;
    assert.ok(selectedCard(s.render()).split("\n").length >= 3 && selectedCard(s.render()).split("\n").length <= 9);
  }
  assert.equal(current, total);
  s.terminal.rows = 30;
  s.render(70);
  s.press(k.up); s.render(70); s.press(k.down);
  const preview = s.render(70).slice(dividerRow(s.terminal.rows) + 2).map(stripTerminalSequences).join("\n");
  const selected = items.find(entry => entry.id === preview.match(/mixed-\d+/)?.[0]);
  assert.ok(selected);
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, [selected.rawText]);
});

test("unfocused filtered pages step exactly and clearing search returns to the last page", () => {
  const s = setup(Array.from({ length: 15 }, (_, i) => item(`entry-${i}`)));
  s.press("entry");
  const check = (n: number) => assert.match(s.plain()[1]!, new RegExp(`Page ${n}/3`));
  check(1); s.press(k.right); check(2); s.press(k.right); check(3);
  s.press(k.left); check(2); s.press(k.left); check(1);
  for (let i = 0; i < 5; i++) s.press("\x7f");
  check(3);
  s.press(k.enter);
  assert.deepEqual(s.copied, []);
});


test("escape closes a tiny viewport", () => {
  const s = setup([item("one")]);
  s.render(0);
  s.press(k.esc);
  assert.deepEqual(s.results, [undefined]);
});

test("isolated user padding at page edges gives way to adjacent content", () => {
  const bg = theme.getBgAnsi("userMessageBg");
  const bottom = setup([...Array.from({ length: 4 }, (_, i) => item(`a${i}`, `key-a${i}`)), item("u", "key-user", "user"), item("after", "key-after")]);
  bottom.terminal.rows = 24;
  bottom.press("key");
  const first = bottom.render();
  assert.ok(first.slice(3, 13).some(line => line.includes("key-a3")));
  assert.ok(!first[12]!.includes(bg) || stripTerminalSequences(first[12]!).includes("key-user"));
  assert.equal(stripTerminalSequences(first[13]!).trim(), "...");
  assert.equal(stripTerminalSequences(first[2]!).trim(), "");
  bottom.press(k.right);
  assert.match(stripTerminalSequences(bottom.render()[1]!), /Page 2\//);
  bottom.press(k.left);
  assert.match(stripTerminalSequences(bottom.render()[1]!), /Page 1\//);

  const top = setup([item("a", "key-a"), item("b", "key-b"), item("u", "key-user", "user"), item("after", "key-after"), item("last", "key-last"), item("extra", "key-extra"), item("extra2", "key-extra2")]);
  top.terminal.rows = 18;
  top.press("key");
  top.press(k.right);
  const page = top.render();
  assert.ok(!page[3]!.includes(bg));
  assert.ok(page.slice(3, 10).some(line => stripTerminalSequences(line).includes("key-after")));
  assert.equal(stripTerminalSequences(page[2]!).trim(), "...");
  top.press(k.left);
  assert.match(stripTerminalSequences(top.render()[1]!), /Page 1\//);
});

test("visible user content keeps its shaded padding and meaningful blank lines", () => {
  const bg = theme.getBgAnsi("userMessageBg");
  const s = setup([item("user", "key-first\n\nkey-second", "user"), item("next", "key-next")]);
  s.terminal.rows = 24;
  s.press("key");
  let lines = s.render();
  const first = lines.findIndex(line => stripTerminalSequences(line).includes("key-first"));
  const second = lines.findIndex(line => stripTerminalSequences(line).includes("key-second"));
  assert.ok(lines[first - 1]!.includes(bg));
  assert.ok(lines[first + 1]!.includes(bg));
  assert.equal(stripTerminalSequences(lines[first + 1]!).trim(), "");
  assert.ok(lines[second + 1]!.includes(bg));
  s.press(k.down);
  lines = s.render();
  assert.ok(selectedCard(lines).includes("key-first"));
  assert.ok(lines[first - 1]!.includes(bg));
  s.terminal.rows = 30;
  assert.ok(selectedCard(s.render()).includes("key-first"));
  for (let i = 0; i < 3; i++) s.press("\x7f");
  assertUnselected(s);
});

test("code selections show their own immediately preceding prose without repeating earlier code", async () => {
  const intro = "Here are two ways to greet someone by name. Both examples remove extra whitespace.";
  const raw = `${intro}\n\n\`\`\`js\nhello(name)\n\`\`\`\n\nThe Python version follows the same steps:\n\n\`\`\`python\nprint(name)\n\`\`\``;
  const s = setup([item("user", "earlier user question", "user"), item("assistant", raw)]);
  s.terminal.rows = 30;
  s.press(k.down);
  let list = s.render(72).slice(3, dividerRow(s.terminal.rows)).map(stripTerminalSequences).join("\n");
  assert.ok(list.indexOf("Here are two ways") >= 0 && list.indexOf("Here are two ways") < list.indexOf("```js"), list);
  assert.equal((list.match(/hello\(name\)/g) ?? []).length, 1);
  assert.ok(list.includes("Python version"));
  s.press(k.down);
  list = s.render(72).slice(3, dividerRow(s.terminal.rows)).map(stripTerminalSequences).join("\n");
  assert.ok(list.indexOf("The Python version") >= 0 && list.indexOf("The Python version") < list.indexOf("```python"), list);
  assert.equal((list.match(/print\(name\)/g) ?? []).length, 1);
  assert.equal((list.match(/hello\(name\)/g) ?? []).length, 1);
  assert.ok(list.indexOf("Here are two ways") < list.indexOf("The Python version"));
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, ["print(name)"]);
});

test("duplicate and quoted code blocks use their own source context at narrow widths", () => {
  const raw = "First intro\n\n```js\nsame()\n```\n\n> Second intro\n>\n> ```js\n> same()\n> ```";
  const s = setup([item("other", "unrelated user", "user"), item("a", raw)]);
  s.terminal.rows = 40;
  s.press(k.down); s.press(k.down); s.press(k.down);
  for (const width of [72, 32, 72]) {
    const rows = s.render(width);
    const list = rows.slice(3, dividerRow(s.terminal.rows)).map(stripTerminalSequences).join("\n");
    assert.ok(list.indexOf("First intro") < list.indexOf("Second intro"), list);
    assert.equal((list.match(/same\(\)/g) ?? []).length, 2);

    assert.ok(rows.every(line => visibleWidth(line) === width));
  }
});

test("long wrapped context yields viewport space to the selected code frame", () => {
  const raw = `${"Long preceding context with several words. ".repeat(40)}\n\n\`\`\`js\nuniqueCode()\n\`\`\``;
  const s = setup([item("old", "old user", "user"), item("a", raw)]);
  s.terminal.rows = 24;
  s.press(k.down);
  for (const width of [32, 72, 32]) {
    const rows = s.render(width);
    const list = rows.slice(3, dividerRow(s.terminal.rows)).map(stripTerminalSequences).join("\n");
    assert.ok(list.includes("uniqueCode()"), list);
    assert.ok(list.includes("```js"), list);
    assert.ok(list.includes("context"), list);
    assert.ok(!list.includes("old user"), list);
    assert.ok(rows.every(line => visibleWidth(line) === width));
  }
});

test("unselected code children do not leave blank rows before a selected user", () => {
  const raw = "Here are two ways to greet someone.\n\n```javascript\nfunction greet(name) {\n\n  const greeting = `Hello ${name}`;\n\n  return greeting;\n}\n```\n\nThe Python version follows.\n\n```python\ndef greet(name):\n    return f'Hello {name}'\n```";
  for (const suffix of ["example", "示例"]) {
    const s = setup([item("previous", raw), item("user", `One more ${suffix}`, "user"), item("next", "Next assistant")]);
    s.terminal.rows = 60;
    s.press(k.up);
    const lines = s.render(72).slice(3, dividerRow(s.terminal.rows)).map(stripTerminalSequences);
    const border = lines.findIndex(line => line.startsWith("╭"));
    assert.ok(border > 0, lines.join("\n"));
    let last = border - 1;
    while (last >= 0 && !lines[last]!.trim()) last--;
    assert.ok(border - last - 1 <= 1, `gap=${border - last - 1}\n${lines.join("\n")}`);
    const text = lines.findIndex(line => line.includes(`One more ${suffix}`));
    assert.equal(text, border + 2);
    assert.ok(lines[text + 2]!.startsWith("╰"));
  }
});

test("expanding and collapsing code cards preserves navigation, context and neighboring user", () => {
  for (const intro of ["Nearest introduction", "最近的说明"]) {
    const raw = `First introduction\n\n\`\`\`js\nfirst()\n\`\`\`\n\n${intro}\n\n\`\`\`python\n${Array.from({ length: 40 }, (_, i) => `print(${i})`).join("\n")}\n\`\`\``;
    const s = setup([item("before", "Earlier user", "user"), item("rich", raw), item("user", "One more example", "user"), item("after", "Next assistant")]);
    s.terminal.rows = 40;
    s.press(k.up); s.press(k.up); s.press(k.up); s.press(k.up);
    s.press(k.down); s.press(k.down);
    for (const width of [72, 32, 72]) {
      const lines = s.render(width);
      const list = lines.slice(3, dividerRow(s.terminal.rows)).map(stripTerminalSequences).join("\n");
      assert.ok(list.includes(intro), list);
      assert.ok(selectedCard(lines).includes("print(0)"));
      assert.equal((list.match(/first\(\)/g) ?? []).length, 1);
      assert.equal((list.match(/print\(0\)/g) ?? []).length, 1);
    }
    s.press(k.up); s.press(k.up);
    assert.ok(s.render(72).slice(3, dividerRow(s.terminal.rows)).some(line => line.includes("First introduction")));
    s.press(k.down); s.press(k.down); s.press(k.down);
    let lines = s.render(72);
    assert.ok(selectedCard(lines).includes("One more example"));
    s.press(k.down);
    assert.ok(selectedCard(s.render(72)).includes("Next assistant"));
    s.press(intro); s.press(k.down); s.press(k.down); s.press(k.down);
    lines = s.render(72);
    assert.ok(selectedCard(lines).includes("print(0)"));
    assert.ok(lines.slice(3, dividerRow(s.terminal.rows)).map(stripTerminalSequences).join("\n").includes(intro));
  }
});

test("standalone inline code is a source-highlighted child with exact copy and search behavior", async () => {
  const raw = "Generated an HTML report:\n\n`` /tmp/example/`report`.html ``\n\nThe report has 24 cases.";
  for (const child of [false, true]) {
    const s = setup([item("report", raw)]);
    s.terminal.rows = 40;
    if (child) s.press(k.down);
    const lines = s.render();
    if (child) {
      const card = selectedCard(lines);
      assert.ok(card.includes("`` /tmp/example/`report`.html ``"), card);
      assert.ok(lines.some(line => line.includes(getMarkdownTheme().code("`` /tmp/example/`report`.html ``"))));
      assert.equal(s.cards().join("\n").split("/tmp/example/").length - 1, 1);
    }
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [child ? " /tmp/example/`report`.html " : raw]);
  }
  const s = setup([item("other"), item("report", raw)]);
  s.press("/tmp/example/");
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, []);
  s.press(k.right); s.press(k.left); s.press(k.down); s.press(k.down);
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, [" /tmp/example/`report`.html "]);
});

test("multiline headings and spans do not expose false inline children", async () => {
  for (const raw of ["`heading`\ncontinued title\n---", "start `open\n`inner`\nclose`"]) {
    const s = setup([item("regression", raw)]);
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [raw]);
    const child = setup([item("regression", raw)]);
    child.press(k.down);
    child.press(k.enter); await settle();
    assert.deepEqual(child.copied, [raw]);
  }
});


test("ambiguous inline syntax keeps the whole message selected for copying", async () => {
  for (const source of ["\\``open\n`value`", "start ```\n```value```", "<div>\n`value`", "<!-- comment\n`value` "]) {
    const s = setup([item("ambiguous", source)]);
    s.press(k.down);
    s.press(k.enter);
    await settle();
    assert.deepEqual(s.copied, [source]);
  }
});

test("selected children show bounded surrounding prose without sacrificing their summaries", async () => {
  const raw = "Before code\n\n```js\nalpha()\nbeta()\ngamma()\ndelta()\n```\n\nBetween code and inline\n\n`inline`\n\nBetween inline and quote\n\n> quoted words\n\nAfter quote";
  for (const rows of [40, 50]) for (const index of [1, 2, 3]) {
    const s = setup([item("unrelated", "neighbor", "user"), item("reply", raw)]);
    s.terminal.rows = rows;
    for (let n = 0; n < index; n++) s.press(k.down);
    const list = s.render(72).slice(3, dividerRow(rows)).map(stripTerminalSequences).join("\n");
    const [before, inside, after] = [
      ["Before code", "alpha()", "Between code and inline"],
      ["Between code and inline", "`inline`", "Between inline and quote"],
      ["Between inline and quote", "quoted words", "After quote"],
    ][index - 1]!;
    assert.ok(list.indexOf(before!) < list.indexOf(inside!) && list.indexOf(inside!) < list.indexOf(after!), list);
    assert.equal(list.split(inside!).length - 1, 1, list);
    if (index === 1) for (const text of ["alpha()", "beta()", "gamma()", "delta()"]) assert.ok(list.includes(text), list);
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [["alpha()\nbeta()\ngamma()\ndelta()", "inline", "quoted words"][index - 1]]);
  }
});


test("grouped reply and tools remain separately navigable when tools are toggled", async () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const text = (text: string) => ({ type: "text", text });
  const items = toPickerItems([entry("user", { role: "user", content: "question" }),
    entry("first", { role: "assistant", stopReason: "toolUse", content: [text("progress"), { type: "toolCall", name: "read", arguments: { path: "x" } }] }),
    entry("tool", { role: "toolResult", toolName: "read", content: [text("result")] }),
    entry("final", { role: "assistant", stopReason: "stop", content: [text("final\n\n`block`")] })]);
  const s = setup([...items]); s.terminal.rows = 50;
  let list = s.render(72).slice(3, dividerRow(50)).map(stripTerminalSequences).join("\n");
  assert.ok(list.includes("progress")); assert.ok(list.includes("final")); assert.ok(!list.includes("Tool call"));
  s.press(k.down); s.press(k.enter); await settle(); assert.deepEqual(s.copied, ["block"]);
  const tools = setup([...items]); tools.terminal.rows = 50; tools.press(k.tools);
  list = tools.render(72).slice(3, dividerRow(50)).map(stripTerminalSequences).join("\n");
  assert.ok(list.includes("Tool call: read") && list.includes("Tool output: read"), list);
});


test("narrow selected code retains three source lines and reports omitted context", () => {
  const raw = `${"Long preceding context ".repeat(30)}\n\n\`\`\`js\nfirst()\nsecond()\nthird()\nfourth()\n\`\`\`\n\n${"Long following context ".repeat(30)}`;
  const s = setup([item("old", "unrelated", "user"), item("reply", raw)]);
  s.terminal.rows = 24; s.press(k.down);
  for (const width of [32, 50, 32]) {
    const lines = s.render(width);
    const list = lines.slice(3, dividerRow(24)).map(stripTerminalSequences).join("\n");
    for (const token of ["first()", "second()", "third()", "...", "```js"]) assert.ok(list.includes(token), list);
    assert.ok(!list.includes("unrelated"), list);
    assert.ok(lines.every(line => visibleWidth(line) === width));
  }
});


test("long surrounding prose stays in source order around the selected block", () => {
  const before = ["before one", "before two", "before three", "before four"].join("\n\n");
  const after = ["after one", "after two", "after three", "after four"].join("\n\n");
  const s = setup([item("reply", `${before}\n\n\`\`\`js\nalpha()\nbeta()\ngamma()\ndelta()\n\`\`\`\n\n${after}`)]);
  s.terminal.rows = 50; s.press(k.down);
  const list = s.render(72).slice(3, dividerRow(50)).map(stripTerminalSequences);
  const top = list.findIndex(line => line.includes("before four"));
  const bottom = list.findIndex(line => line.includes("after one"));
  assert.ok(top > 0 && bottom > top, list.join("\n"));
  for (const text of ["before one", "before two", "before three", "after two", "after three", "after four"]) {
    assert.equal(list.filter(line => line.includes(text)).length, 1, text);
  }
  const card = selectedCard(s.render(72));
  for (const line of ["alpha()", "beta()", "gamma()", "delta()"]) assert.ok(card.includes(line), card);
  assert.ok(!card.includes("..."), card);
});


test("source context stays literal around the selected adaptive block", () => {
  const source = "## Title\n\n| key | value |\n| --- | --- |\n| x | y |\n\n```python\n{\nfirst()\n\nsecond()\nthird()\n```\n\n[link][ref]\n\n[ref]: https://example.com";
  const s = setup([item("reply", source)]);
  s.terminal.rows = 60;
  s.press(k.down);
  const lines = s.render(80).slice(3, dividerRow(60));
  const plain = lines.map(stripTerminalSequences);
  const text = plain.join("\n");
  for (const part of ["## Title", "| key | value |", "| --- | --- |", "| x | y |", "[link][ref]", "[ref]: https://example.com"]) {
    assert.equal(text.split(part).length - 1, 1, text);
  }
  const start = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
  const end = lines.findIndex((line, index) => index > start && line.includes(theme.getFgAnsi("accent") + "╰"));
  assert.equal(end - start, 8, text);
  assert.ok(plain[start + 1]!.includes("```python"), text);
  assert.ok(plain[end - 1]!.includes("```"), text);
});

test("visible tool events remain between progress and final source", () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const entries = [
    entry("progress", { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "progress-source" }, { type: "toolCall", name: "read", arguments: { path: "file" } }] }),
    entry("result", { role: "toolResult", toolName: "read", content: [{ type: "text", text: "result-source" }] }),
    entry("final", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final-source" }] }),
  ];
  const s = setup([...toPickerItems(entries)]);
  s.terminal.rows = 60;
  s.press(k.tools);
  s.press(k.down); s.press(k.down);
  const list = s.render(80).slice(3, dividerRow(60)).map(stripTerminalSequences).join("\n");
  const positions = ["progress-source", "Tool call: read", "result-source", "final-source"].map(text => list.indexOf(text));
  assert.ok(positions.every(position => position >= 0), list);
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]!), list);
});

test("source gap goldens distinguish one blank from two and preserve braces", () => {
  for (const [body, expected, leading, trailing] of [
    ["first()\n\nsecond()", ["first()", "", "second()"], false, false],
    ["first()\n\n\nsecond()", ["first()", "...", "second()"], false, false],
    ["{\nfirst()\n}\nsecond()\n", ["first()", "}", "second()"], true, false],
    ["first()\nsecond()\nthird()\n\n", ["first()", "second()", "third()"], false, true],
  ] as const) {
    const s = setup([item("reply", `~~~js\n${body}${body.endsWith("\n") ? "" : "\n"}~~~`)]);
    s.press(k.down);
    const frame = selectedCard(s.render(50)).split("\n");
    const content = frame.slice(1, -1).map(line => line.slice(4, -1).trimEnd());
    const source = body.includes("\n\n\n") ? ["~~~js", "first()", "...", "second()", "~~~"] : ["~~~js", ...body.replace(/\n$/, "").split("\n"), "~~~"];
    assert.deepEqual(content, source);
    assert.ok(!frame[0]!.includes("...") && !frame.at(-1)!.includes("..."));
  }
});

test("source selection centers after reflow and restores the old block in place", () => {
  const before = Array.from({ length: 60 }, (_, i) => `before-${i}`).join("\n");
  const after = Array.from({ length: 60 }, (_, i) => `after-${i}`).join("\n");
  const s = setup([item("reply", `${before}\n\n\`\`\`python\none()\ntwo()\nthree()\nfour()\n\`\`\`\n\n${after}\n\n\`inline\``)]);
  s.terminal.rows = 40;
  s.press(k.down);
  const list = () => s.render(72).slice(3, 3 + Math.floor((s.terminal.rows - 6) * 0.6));
  let rows = list();
  const top = rows.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
  assert.equal(top, Math.floor((Math.floor((40 - 6) * 0.6) - 8) / 2));
  assert.ok(rows.map(stripTerminalSequences).join("\n").includes("four()"));
  s.press(k.down);
  assert.ok(selectedCard(s.render(72)).includes("`inline`"));
  s.press(k.up);
  rows = list();
  assert.equal(rows.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭")), top);
  s.terminal.rows = 50;
  rows = list();
  assert.equal(rows.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭")), Math.floor((Math.floor((50 - 6) * 0.6) - 8) / 2));
});

test("source Python and JavaScript conversation keeps next user and exact clipboard", async () => {
  for (const nl of ["\n", "\r\n"]) for (const lang of ["python", "javascript"]) {
    const body = `first()${nl}${nl}${nl}second()${nl}third()`;
    const raw = `## Example${nl}${nl}\`\`\`${lang}${nl}${body}${nl}\`\`\`${nl}${nl}[ref][id]${nl}${nl}[id]: https://example.com`;
    const s = setup([item("a", raw), item("u", "next user", "user")]);
    s.terminal.rows = 60;
    s.press(k.up);
    const rendered = s.render(80);
    const list = rendered.slice(3, dividerRow(60)).map(stripTerminalSequences).join("\n");
    for (const text of ["## Example", "[ref][id]", "[id]: https://example.com", "next user"]) assert.equal(list.split(text).length - 1, 1, list);
    const preview = rendered.slice(dividerRow(60) + 2).map(stripTerminalSequences).join("\n");
    assert.ok(preview.includes("first()") && preview.includes("third()"), preview);
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [body]);
  }
});

test("tool timeline navigation follows visible source in both directions and copies each stop", async () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const text = (text: string) => ({ type: "text", text });
  const items = [...toPickerItems([
    entry("user", { role: "user", content: "question" }),
    entry("first", { role: "assistant", stopReason: "toolUse", content: [text("progress\n\n```js\np()\n```"), { type: "toolCall", name: "read", arguments: { path: "x" } }] }),
    entry("tool", { role: "toolResult", toolName: "read", content: [text("output")] }),
    entry("final", { role: "assistant", stopReason: "stop", content: [text("final\n\n```js\nf()\n```")] }),
  ])];
  const parent = "progress\n\n```js\np()\n```\n\nfinal\n\n```js\nf()\n```";
  for (const tools of [false, true]) for (const reverse of [false, true]) {
    const expected = ["question", parent, "p()", ...(tools ? ['{\n  "path": "x"\n}', "output"] : []), "f()"];
    for (let index = 0; index < expected.length; index++) {
      const s = setup(items); s.terminal.rows = 80;
      for (let i = 0; i < 10; i++) s.press(k.up);
      if (tools) s.press(k.tools);
      if (reverse) for (let i = 0; i < 10; i++) s.press(k.down);
      for (let i = 0; i < (reverse ? expected.length - 1 - index : index); i++) s.press(reverse ? k.up : k.down);
      const lines = s.render(80);
      const preview = lines.slice(dividerRow(80) + 2).map(stripTerminalSequences).join("\n");
      const marker = ["question", "progress", "p()", ...(tools ? ["path", "output"] : []), "f()"][index]!;
      assert.ok(preview.includes(marker), preview);
      if (tools) {
        const list = lines.slice(3, dividerRow(80)).map(stripTerminalSequences).join("\n");
        const parts = index === 1 ? ["progress", "Tool call: read", "output"] : ["progress", "p()", "Tool call: read", "output", "final", "f()"];
        const positions = parts.map(part => list.indexOf(part));
        assert.ok(positions.every((pos, i) => pos >= 0 && (!i || pos > positions[i - 1]!)), list);
      }
      s.press(k.enter); await settle(); assert.deepEqual(s.copied, [expected[index]]);
    }
  }
});

test("code sample keeps original braces, fences and a compressed source gap", async () => {
  for (const [body, expected, top, bottom] of [
    ["a\nb\n}\nc", ["a", "b", "}"], false, true],
    ["a\n\n\n b", ["a", "...", " b"], false, false],
    ["a\n}\nb", ["a", "}", "b"], false, false],
    ["{\na\nb", ["{", "a", "b"], false, false],
    ["a\nb\nc\n}", ["a", "b", "c"], false, true],
  ] as const) {
    const s = setup([item("code", `\`\`\`js\n${body}\n\`\`\``)]); s.press(k.down);
    const raw = s.render(40); const frame = selectedCard(raw).split("\n");
    const content = frame.slice(1, -1).map(line => line.slice(4, -1).trimEnd());
    assert.deepEqual(content, ["```js", ...body.replace(/\n\n\n/g, "\n...\n").split("\n"), "```"]);
    assert.ok(!frame[0]!.includes("...") && !frame.at(-1)!.includes("..."));
    assert.ok(raw.every(line => visibleWidth(line) === 40));
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, [body]);
  }
});

test("tool selection remains safe through hide, search, resize and paging", async () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const items = [...toPickerItems([
    entry("user", { role: "user", content: "question" }),
    entry("first", { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "progress\n\n```js\np()\n```" }, { type: "toolCall", name: "read", arguments: {} }] }),
    entry("tool", { role: "toolResult", toolName: "read", content: [{ type: "text", text: "output" }] }),
    entry("final", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final\n\n```js\nf()\n```" }] }),
  ])];
  const s = setup(items); s.terminal.rows = 24;
  for (let i = 0; i < 8; i++) s.press(k.up);
  s.press(k.tools); for (let i = 0; i < 4; i++) s.press(k.down);
  s.press(k.tools);
  assert.ok(s.render(40).slice(dividerRow(24) + 2).map(stripTerminalSequences).join("\n").includes("p()"));
  for (const rows of [30, 60, 24]) {
    s.terminal.rows = rows;
    for (let i = 0; i < 10; i++) { s.press(k.right); s.render(40); }
    for (let i = 0; i < 10; i++) { s.press(k.left); s.render(40); }
  }
  s.press("final"); s.press(k.enter); await settle(); assert.deepEqual(s.copied, []);
  s.press(k.down); s.press(k.down); s.press(k.down); s.press(k.enter); await settle(); assert.deepEqual(s.copied, ["f()"]);
});

test("literal ellipsis and omission markers retain distinct source styling", () => {
  const s = setup([item("code", "```text\nfirst\n...\nlast\n\n\nend\n```")]); s.press(k.down);
  const lines = s.render(40); const start = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
  const frame = lines.slice(start, start + 9);
  assert.ok(stripTerminalSequences(frame[3]!).includes("..."));
  assert.ok(!frame[3]!.includes(theme.fg("muted", "...")));
  const gap = setup([item("gap", "```text\nfirst\n\n\nlast\n```")]); gap.press(k.down);
  assert.ok(gap.render(40).some(line => line.includes(theme.fg("muted", "..."))));
  assert.ok(frame[5]!.includes(theme.fg("muted", "...")));
});

test("small windows preserve a selected block until resized and prevent copying", async () => {
  for (const rows of [10, 9]) {
    const s = setup([item("code", "before\n```\na\nb\nc\n```\nafter")]);
    s.press(k.down); s.terminal.rows = rows; s.render(60);
    const tiny = s.render(60).map(stripTerminalSequences);
    assert.equal(tiny.length, rows);
    assert.match(tiny[0]!, /Window too small\. Esc to close\./);
    s.press(k.enter); s.press(k.right); s.press(k.pgdown); await settle();
    assert.deepEqual(s.copied, []); assert.deepEqual(s.results, []);
    s.terminal.rows = 30;
    assert.ok(selectedCard(s.render(60)).includes("a"));
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, ["a\nb\nc"]);
  }
});

test("list indicators ignore boundary decoration but count hidden source blank lines", () => {
  const s = setup([item("code", "before\n```\na\nb\nc\n```\nafter")]);
  s.terminal.rows = 18; s.press(k.down);
  const lines = s.render(60).map(stripTerminalSequences);
  assert.equal(lines[2]!.trim(), "...");
  assert.equal(lines[3 + Math.floor((18 - 6) * 0.6)]!.trim(), "...");
  const hidden = setup([item("code", "\nbefore\n```\na\nb\nc\n```\nafter\n")]);
  hidden.terminal.rows = 18; hidden.press(k.down);
  const clipped = hidden.render(60).map(stripTerminalSequences);
  assert.equal(clipped[2]!.trim(), "...");
});

test("adaptive selected blocks allow navigation back and search without accidental copy", async () => {
  const s = setup([item("code", "before\n```\na\nb\nc\n```\nafter")]);
  s.terminal.rows = 14; s.render(60); s.press(k.down);
  assert.ok(selectedCard(s.render(60)).includes("..."));
  s.press(k.up);
  assert.ok(selectedCard(s.render(60)).includes("..."));
  s.press(k.down); s.press("before"); s.press(k.enter); await settle();
  assert.deepEqual(s.copied, []);
  assert.ok(s.render(60).map(stripTerminalSequences).some(line => line.includes("before")));
});

test("paging never leaves a selected block frame partially visible", () => {
  const s = setup([item("code", "before\n```\na\nb\nc\n```\nafter\nlast")]);
  s.terminal.rows = 18; s.render(60); s.press(k.down); s.render(60);
  for (const key of [k.right, k.left, k.right, k.left]) {
    s.press(key);
    const lines = s.render(60);
    const top = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
    const bottom = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╰"));
    if (top >= 0 && lines[top]!.includes("```")) assert.equal(bottom - top, 4);
    if (bottom >= 0 && lines[bottom]!.includes("```")) assert.equal(bottom - top, 4);
  }
});

test("selected whole messages use one adaptive frame and keep the full preview and copy", async () => {
  for (const kind of ["assistant", "user"] as const) {
    const raw = ["# Alert", "first **important** line", "", "```ts", ...Array.from({ length: 500 }, (_, i) => `source line ${i}`), "```", "final tail"].join("\n");
    const s = setup([item("before", "before message"), item("long", raw, kind)]);
    s.terminal.rows = 60;
    const lines = s.render();
    const card = selectedCard(lines);
    assert.equal(card.split("\n").length, 9, card);
    assert.equal(lines.filter(line => line.includes(theme.getFgAnsi("accent") + "╭")).length, 1);
    assert.ok(s.cards().join("\n").includes("before message"));
    s.press(k.end);
    assert.ok(s.plain().some(line => line.includes("final tail")));
    s.press(k.enter);
    await settle();
    assert.deepEqual(s.copied, [raw]);
  }
});

test("selected grouped parent replaces its segments without hiding interleaved tools", () => {
  const first = "progress before tool";
  const second = "\n\nfinal after tool";
  const s = setup([
    { id: "group", kind: "assistant", rawText: first + second, segments: [
      { sourceStart: 0, sourceEnd: first.length, entryId: "a", order: 0 },
      { sourceStart: first.length, sourceEnd: first.length + second.length, entryId: "b", order: 3 },
    ] },
    { id: "call", kind: "tool-call", toolName: "read", rawText: "call payload", order: 1 },
    { id: "result", kind: "tool-result", toolName: "read", rawText: "result payload", order: 2 },
  ]);
  s.terminal.rows = 60;
  s.press(k.tools);
  const lines = s.render();
  const card = selectedCard(lines);
  const list = s.cards().join("\n");
  assert.equal(card.split("\n").length, 4);
  assert.ok(card.includes("..."));
  assert.equal(lines.filter(line => line.includes(theme.getFgAnsi("accent") + "╭")).length, 1);
  assert.equal(list.split("progress before tool").length - 1, 1);
  assert.equal(list.split("final after tool").length - 1, 1);
  assert.ok(list.indexOf("progress before tool") < list.indexOf("call payload"));
  assert.ok(list.indexOf("call payload") < list.indexOf("result payload"));
  assert.ok(list.indexOf("result payload") < list.indexOf("final after tool"));
});

test("selected parents recover from fewer than three list rows without losing selection", async () => {
  for (const kind of ["user", "assistant"] as const) {
    const s = setup([item("one", "one\ntwo\nthree\nfour", kind)]);
    s.terminal.rows = 10;
    assert.match(s.plain()[0]!, /Window too small/);
    s.press(k.enter);
    await settle();
    assert.deepEqual(s.copied, []);
    s.terminal.rows = kind === "user" ? 15 : 14;
    assert.equal(selectedCard(s.render()).split("\n").length, kind === "user" ? 5 : 4);
  }
});

test("parent, child and tool targets each have exactly one adaptive frame", async () => {
  const raw = "intro **markdown**\n\n```ts\nalpha\nbeta\ngamma\ndelta\n```\ntail";
  const s = setup([item("parent", raw), { id: "call", kind: "tool-call", toolName: "read", rawText: "tool line one\ntool line two\ntool line three\ntool line four" }]);
  s.terminal.rows = 60;
  const check = () => {
    const lines = s.render(45);
    assert.ok(selectedCard(lines).split("\n").length >= 3 && selectedCard(lines).split("\n").length <= 9);
    assert.equal(lines.filter(line => line.includes(theme.getFgAnsi("accent") + "╭")).length, 1);
    assert.ok(lines.every(line => visibleWidth(line) === 45));
  };
  check();
  s.press(k.down); check();
  s.press(k.up); check();
  s.press(k.tools); s.press(k.down); s.press(k.down); check();
  assert.match(selectedCard(s.render(45)), /tool line one/);
  assert.ok(s.cards().join("\n").includes("Tool call: read"));
  s.press("search absent"); s.press(k.enter); await settle();
  assert.deepEqual(s.copied, []);
});

test("one-line selected user has shaded interior and unshaded five-row frame", () => {
  const s = setup([item("user", "hello", "user")]);
  const lines = s.render(40);
  const start = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
  const frame = lines.slice(start, start + 5);
  assert.equal(selectedCard(lines).split("\n").length, 5);
  assert.ok(frame.slice(1, 4).every(line => line.includes(theme.getBgAnsi("userMessageBg"))));
  assert.ok(!frame[0]!.includes(theme.getBgAnsi("userMessageBg")));
  assert.ok(!frame[4]!.includes(theme.getBgAnsi("userMessageBg")));
  assert.ok(!stripTerminalSequences(frame.join("\n")).includes("..."));
});

test("code borders stay clean while fences and punctuation remain inside", () => {
  for (const [body, top, bottom] of [
    ["{\na()\n}", false, false],
    ["\na()\n", false, false],
    ["{\na()\nb()\nc()", true, false],
    ["a()\nb()\nc()\n}", false, true],
  ] as const) {
    const s = setup([item("code", `\`\`\`js\n${body}\n\`\`\``)]);
    s.press(k.down);
    const frame = selectedCard(s.render(60)).split("\n");
    assert.equal(frame.length, body.split("\n").length + 4);
    assert.equal(frame[0]!.includes("..."), false, body);
    assert.equal(frame.at(-1)!.includes("..."), false, body);
  }
});

test("selected user wraps a long source line into the adaptive frame and copies it intact", async () => {
  const text = "User: " + "word ".repeat(10) + "end";
  const s = setup([item("user", text, "user")]);
  const frame = selectedCard(s.render(40)).split("\n");
  assert.equal(frame.length, 6);
  assert.ok(frame.slice(1, -1).join(" ").includes("end"), frame.join("\n"));
  assert.ok(!frame.join("\n").includes("..."), frame.join("\n"));
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, [text]);
});


test("three-page navigation never copies until Enter and copies the visible selection exactly", async () => {
  for (const steps of [[], [k.left], [k.left, k.left], [k.left, k.left, k.right], [k.left, k.left, k.right, k.right]]) {
    const s = setup(Array.from({ length: 15 }, (_, i) => item(`entry-${i}`)));
    s.render();
    for (const key of steps) { s.press(key); s.render(); }
    await settle();
    assert.deepEqual(s.copied, []);
    const selected = selectedCard(s.render()).match(/entry-\d+/)?.[0];
    assert.ok(selected);
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [selected]);
  }
});

test("one huge user prose message has nine frame rows and a complete preview", async () => {
  const raw = "long ordinary prose ".repeat(2000) + "FINAL-TEXT";
  const s = setup([item("huge", raw, "user")]);
  const lines = s.render(45);
  const frame = selectedCard(lines).split("\n");
  assert.equal(frame.length, 9);
  assert.ok(frame[6]!.includes("..."));
  assert.ok(frame.slice(1, -1).every(line => line.startsWith("│") && line.endsWith("│")));
  assert.ok(lines.every(line => visibleWidth(line) === 45));
  s.press(k.end);
  assert.ok(s.render(45).map(stripTerminalSequences).some(line => line.includes("FINAL-TEXT")));
  s.press(k.enter); await settle(); assert.deepEqual(s.copied, [raw]);
});


test("whole-message summaries preserve fence delimiters without claiming omitted source", async () => {
  for (const raw of ["", "```js\na()\n```", "~~~js\na()\n~~~"]) {
    const s = setup([item("source", raw)]);
    const frame = selectedCard(s.render());
    assert.equal(frame.split("\n").length, raw ? 5 : 3);
    assert.ok(!frame.includes("..."), frame);
    if (raw) {
      assert.ok(frame.includes("a()"));
      assert.ok(frame.includes(raw.slice(0, 3)));
      s.press(k.enter); await settle(); assert.deepEqual(s.copied, [raw]);
    }
  }
});


test("tool toggles keep a later grouped child fully framed and restore source chronology", () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const text = (text: string) => ({ type: "text", text });
  const s = setup([...toPickerItems([
    entry("first", { role: "assistant", stopReason: "toolUse", content: [text("early-source"), { type: "toolCall", name: "read", arguments: { path: "x" } }] }),
    entry("tool", { role: "toolResult", toolName: "read", content: [text("output-source\n".repeat(25))] }),
    entry("final", { role: "assistant", stopReason: "stop", content: [text("late-source\n\n```js\nlater()\n```")] }),
  ])]);
  s.render(60); s.press(k.down);
  for (const key of [k.tools, k.tools, k.tools]) {
    s.press(key);
    const frame = selectedCard(s.render(60));
    assert.equal(frame.split("\n").length, 5);
    assert.ok(frame.includes("later()"));
  }
  s.terminal.rows = 100;
  const list = s.render(80).slice(3, dividerRow(100)).map(stripTerminalSequences).join("\n");
  const markers = ["early-source", "Tool call: read", "output-source", "late-source", "later()"];
  const positions = markers.map(marker => list.indexOf(marker));
  assert.ok(positions.every((pos, i) => pos >= 0 && (!i || pos > positions[i - 1]!)), list);
});

test("paging keeps a adaptive selection and copies the complete selected message", async () => {
  const items = Array.from({ length: 12 }, (_, i) => item(`message-${i}`, [`message-${i}`, ...Array.from({ length: 7 }, (_, n) => `line-${i}-${n}`)].join("\n")));
  for (const steps of [0, 1, 2, 3]) {
    const s = setup(items);
    s.terminal.rows = 20;
    s.render(60);
    for (let i = 0; i < steps; i++) { s.press(k.left); s.render(60); }
    const frame = selectedCard(s.render(60));
    assert.equal(frame.split("\n").length, 8);
    const id = frame.match(/message-\d+/)?.[0];
    const expected = items.find(entry => entry.id === id)?.rawText;
    assert.ok(expected, frame);
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [expected]);
  }
});

test("a long message selected by paging remains fully accessible in preview", () => {
  const items = Array.from({ length: 3 }, (_, i) => item(`long-${i}`, [`long-${i}`, ...Array.from({ length: 40 }, (_, n) => `source-${i}-${n}`)].join("\n")));
  const s = setup(items);
  s.terminal.rows = 20;
  s.render(60);
  s.press(k.left);
  const frame = selectedCard(s.render(60));
  assert.equal(frame.split("\n").length, 8);
  const id = Number(frame.match(/long-(\d+)/)?.[1]);
  assert.ok(Number.isInteger(id));
  s.press(k.end);
  const preview = s.render(60).slice(dividerRow(20) + 2).map(stripTerminalSequences).join("\n");
  assert.ok(preview.includes(`source-${id}-39`), preview);
});

test("summary preserves source order, blank runs and literal ellipses", () => {
  for (const [raw, expected] of [
    ["{\n\n\nfoo\n}\n", ["{", "...", "foo", "}"]],
    ["\nfirst\n\nlast", ["", "first", "", "last"]],
    ["\n\nfirst\r\n...\r\nlast", ["...", "first", "...", "last"]],
    ["a\nb\nc\nd\ne\nf\ng", ["a", "b", "c", "d", "e", "f", "g"]],
    ["a\nb\nc\nd\ne\nf\ng\nh", ["a", "b", "c", "d", "e", "f", "..."]],
  ] as const) {
    const s = setup([item("x", raw)]);
    const lines = s.render(50);
    const start = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
    const frame = selectedCard(lines).split("\n");
    assert.deepEqual(frame.slice(1, -1).map(line => line.slice(2, -1).trimEnd()), expected);
    assert.ok(!frame[0]!.includes("...") && !frame.at(-1)!.includes("..."));
    if (raw.includes("first\r\n...")) {
      assert.ok(lines[start + 1]!.includes(theme.fg("muted", "...")));
      assert.ok(!lines[start + 3]!.includes(theme.fg("muted", "...")));
    }
  }
});

test("selected summaries adapt to short windows and keep full copy", async () => {
  const raw = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight";
  const s = setup([item("x", raw)]);
  s.terminal.rows = 14;
  const frame = selectedCard(s.render(40)).split("\n");
  assert.equal(frame.length, 4);
  assert.ok(frame[1]!.includes("one"));
  assert.ok(frame[2]!.includes("..."));
  s.press(k.enter); await settle();
  assert.deepEqual(s.copied, [raw]);
  const tiny = setup([item("x", "one")]); tiny.terminal.rows = 10;
  assert.match(tiny.plain()[0]!, /Window too small/);
  tiny.press(k.enter); await settle(); assert.deepEqual(tiny.copied, []);
});

test("code and quote summaries include original delimiters without inventing closure", () => {
  for (const raw of ["```js\na\n```", "~~~js\na", "> a\n> b", "`inline`"]) {
    const s = setup([item("x", raw)]); s.press(k.down);
    const frame = selectedCard(s.render(50));
    for (const line of raw.split("\n")) assert.ok(frame.includes(line), frame);
    if (raw === "~~~js\na") assert.equal(frame.split("~~~").length - 1, 1);
  }
});


test("source truncation keeps a real final marker after a compacted gap", () => {
  const raw = "one\ntwo\nthree\nfour\nfive\n\n\nsix\nseven\neight";
  const s = setup([item("source", raw)]);
  const frame = selectedCard(s.render(50)).split("\n");
  assert.deepEqual(frame.slice(1, -1).map(line => line.slice(2, -1).trimEnd()),
    ["one", "two", "three", "four", "five", "...", "..."]);
  assert.ok(!frame[0]!.includes("...") && !frame.at(-1)!.includes("..."));
});

test("one-line user requires five list rows and recovers after resize", async () => {
  const s = setup([item("short", "hello", "user")]);
  s.terminal.rows = 11;
  assert.match(s.render(32)[0]!, /Window too small/);
  s.press(k.enter); await settle(); assert.deepEqual(s.copied, []);
  s.terminal.rows = 15;
  const lines = s.render(32);
  assert.deepEqual(selectedCard(lines).split("\n").map(row => row.slice(0, 1)), ["╭", "│", "│", "│", "╰"]);
  s.press(k.enter); await settle(); assert.deepEqual(s.copied, ["hello"]);
});

test("seven-row story covers user, assistant, quote and code sources of length 1 through 12", async () => {
  for (const kind of ["user", "assistant"] as const) for (const target of ["parent", "quote", "code"] as const) for (let length = 1; length <= 12; length++) {
    const payload = Array.from({ length }, (_, i) => `row-${i}`);
    const source = target === "quote" ? payload.map(row => `> ${row}`) : target === "code" ? ["```js", ...payload, "```"] : payload;
    const raw = source.join("\n");
    const s = setup([item("story", raw, kind)]); s.terminal.rows = 60;
    if (target !== "parent") s.press(k.down);
    const lines = s.render(50);
    const frame = selectedCard(lines).split("\n");
    const cap = kind === "user" && target === "parent" ? 5 : 7;
    const summary = source.length > cap ? [...source.slice(0, cap - 1), "..."] : source;
    const expected = kind === "user" && target === "parent" ? ["", ...summary, ""] : summary;
    const inset = target === "parent" ? 0 : 2;
    assert.deepEqual(frame.slice(1, -1).map(row => row.slice(inset + 2, -1).trimEnd()), expected, `${kind}/${target}/${length}`);
    assert.equal(frame.length, expected.length + 2);
    assert.ok(frame[0]!.startsWith(" ".repeat(inset) + "╭"));
    assert.ok(frame.at(-1)!.startsWith(" ".repeat(inset) + "╰"));
    assert.ok(!frame[0]!.includes("...") && !frame.at(-1)!.includes("..."));
    assert.ok(lines.every(row => visibleWidth(row) === 50));
    assert.equal(lines.filter(row => row.includes(theme.getFgAnsi("accent") + "╭")).length, 1);
    s.press(k.end);
    assert.ok(s.render(50).slice(dividerRow(60) + 2).map(stripTerminalSequences).join("\n").includes(`row-${length - 1}`));
    s.press(k.enter); await settle();
    assert.deepEqual(s.copied, [target === "quote" ? payload.join("\n") : target === "code" ? payload.join("\n") : raw]);
  }
});

test("source wrapping retains every space and grapheme rather than word reflow", () => {
  const raw = "abc     ".repeat(7) + "END";
  for (const kind of ["user", "assistant"] as const) {
    const s = setup([item("spaces", raw, kind)]);
    const frame = selectedCard(s.render(32)).split("\n");
    assert.deepEqual(frame.slice(kind === "user" ? 2 : 1, kind === "user" ? -2 : -1).map(row => row.slice(2, -2)), [raw.slice(0, 28), raw.slice(28, 56), raw.slice(56).padEnd(28)]);
  }
  const unicode = "中👨‍👩‍👧‍👦é ".repeat(8);
  const s = setup([item("unicode", unicode)]);
  const frame = selectedCard(s.render(32)).split("\n");
  assert.equal(frame.slice(1, -1).map(row => row.slice(2, -2).trimEnd()).join("").replace(/ /g, ""), unicode.replace(/ /g, ""));
  assert.ok(s.render(32).every(row => visibleWidth(row) === 32));
});

test("syntax colors are accurate in parent summaries and restored unselected source", () => {
  const code = "const answer = 42;";
  const expected = getMarkdownTheme().highlightCode?.(code, "javascript")?.[0];
  assert.ok(expected);
  const s = setup([item("code", `\`\`\`javascript\n${code}\n\`\`\``), item("next")]);
  s.terminal.rows = 60;
  assert.ok(s.render(80).some(row => row.includes(expected)));
  s.press(k.up);
  assert.ok(s.render(80).some(row => row.includes(expected)));
  s.press(k.down); s.press(k.down);
  assert.ok(s.render(80).slice(3, dividerRow(60)).some(row => row.includes(expected)));
});

test("drilldown frames reserve exactly two columns on both sides at 32 and 100 columns", async () => {
  for (const width of [32, 100]) for (const [raw, copy] of [["```js\nx()\n```", "x()"], ["> words", "words"], ["`inline`", "inline"]]) {
    const s = setup([item("inset", raw!)]);
    let lines = s.render(width);
    for (const [glyph, closing] of [["╭", "╮"], ["╰", "╯"]]) {
      const border = lines.find(row => row.includes(theme.getFgAnsi("accent") + glyph))!;
      assert.equal(stripTerminalSequences(border), glyph + "─".repeat(width - 2) + closing);
    }
    s.press(k.down);
    lines = s.render(width);
    for (const [glyph, closing] of [["╭", "╮"], ["╰", "╯"]]) {
      const border = lines.find(row => row.includes(theme.getFgAnsi("accent") + glyph))!;
      assert.equal(stripTerminalSequences(border), "  " + glyph + "─".repeat(width - 6) + closing + "  ");
    }
    assert.ok(lines.every(row => visibleWidth(row) === width));
    assert.ok(lines.slice(dividerRow(30) + 2).map(stripTerminalSequences).join("\n").includes(copy!));
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, [copy]);
  }
});

test("every usable short viewport adapts the source cap without losing preview or copy", async () => {
  const source = Array.from({ length: 12 }, (_, i) => `source-${i}`).join("\n");
  for (const rows of [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 30]) {
    const s = setup([item("tiny", source)]); s.terminal.rows = rows;
    const rendered = s.render(32);
    const frame = selectedCard(rendered).split("\n");
    const cap = Math.min(7, Math.floor((rows - 6) * .6) - 2);
    assert.equal(frame.length, cap + 2);
    assert.deepEqual(frame.slice(1, -1).map(row => row.slice(2, -1).trimEnd()), [...Array.from({ length: cap - 1 }, (_, i) => `source-${i}`), "..."]);
    assert.equal(rendered.length, rows);
    assert.ok(rendered.every(row => visibleWidth(row) === 32));
    s.press(k.end);
    assert.ok(s.render(32).slice(dividerRow(rows) + 2).map(stripTerminalSequences).join("\n").includes("source-11"));
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, [source]);
  }
});

test("nested code and tabs retain accurate syntax colors inside source prefixes", () => {
  for (const source of ["> ```javascript\n> const value = 1;\n> ```", "```javascript\n\tconst value = 1;\n```", "    const value = 1;"]) {
    const s = setup([item("nested", source)]);
    s.press(k.down);
    const lines = s.render(100);
    const row = lines.find(line => stripTerminalSequences(line).includes("const value"))!;
    const expected = getMarkdownTheme().highlightCode?.(source.includes("\t") ? "    const value = 1;" : "const value = 1;", source.startsWith("    ") ? undefined : "javascript")?.[0];
    assert.ok(expected && row.includes(expected), JSON.stringify({ source, row }));
    assert.ok(stripTerminalSequences(row).includes(source.startsWith(">") ? "> const value" : "    const value"));
    assert.ok(lines.every(line => visibleWidth(line) === 100));
  }
});

test("tool frames remain complete even when only three list rows fit", async () => {
  for (const kind of ["tool-call", "tool-result"] as const) {
    const s = setup([{ id: "tool", kind, toolName: "read", rawText: "first\nsecond\nthird" }]);
    s.press(k.tools); s.terminal.rows = 11;
    const lines = s.render(32);
    assert.deepEqual(selectedCard(lines).split("\n").map(row => row.slice(0, 1)), ["╭", "│", "╰"]);
    assert.equal(selectedCard(lines).split("\n")[1]!.slice(2, -1).trimEnd(), "...");
    s.press(k.end);
    assert.ok(s.render(32).slice(dividerRow(11) + 2).map(stripTerminalSequences).join("\n").includes("third"));
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, ["first\nsecond\nthird"]);
  }
});

test("control sequences cannot alter source frames and copying still returns original bytes", async () => {
  const body = "{\nvalue\x1b[31mRED\x1b[0m\x00\x07\n}";
  for (const kind of ["user", "assistant"] as const) for (const block of [false, true]) {
    const raw = block ? "```text\n" + body + "\n```" : body;
    const s = setup([item("controls", raw, kind)]);
    if (block) s.press(k.down);
    const lines = s.render(32);
    const frame = selectedCard(lines);
    assert.ok(frame.includes("valueRED"));
    assert.ok(frame.includes("{") && frame.includes("}"));
    assert.ok(lines.slice(3, dividerRow(30)).every(row => !row.includes("\x00") && !row.includes("\x07")));
    assert.ok(lines.every(row => visibleWidth(row) === 32));
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, [block ? body : raw]);
  }
});

test("grouped parent marks later text inside even a one-row frame and copies all", async () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const text = (text: string) => ({ type: "text", text });
  const items = toPickerItems([
    entry("p", { role: "assistant", stopReason: "toolUse", content: [text("progress"), { type: "toolCall", name: "read", arguments: {} }] }),
    entry("r", { role: "toolResult", toolName: "read", content: [text("result")] }),
    entry("f", { role: "assistant", stopReason: "stop", content: [text("final")] }),
  ]);
  const s = setup([...items]); s.terminal.rows = 11; s.press(k.tools);
  const lines = s.render(40); const frame = selectedCard(lines).split("\n");
  assert.equal(frame.length, 3); assert.match(frame[1]!, /│\s+\.\.\.\s+│/);
  assert.ok(lines.some(line => line.includes(theme.getFgAnsi("muted") + "...")));
  s.press(k.enter); await settle(); assert.deepEqual(s.copied, ["progress\n\nfinal"]);
});

test("tools follow text chunks within one assistant entry", () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const text = (text: string) => ({ type: "text", text });
  const s = setup([...toPickerItems([
    entry("a", { role: "assistant", stopReason: "stop", content: [text("first-source"), { type: "toolCall", name: "read", arguments: { p: 1 } }, text("middle-source"), { type: "toolCall", name: "write", arguments: { p: 2 } }, text("last-source")] }),
    entry("u", { role: "user", content: "later-user" }),
  ])]);
  s.terminal.rows = 100; s.press(k.tools);
  const list = s.render(80).slice(3, dividerRow(100)).map(stripTerminalSequences).join("\n");
  const positions = ["first-source", "Tool call: read", "middle-source", "Tool call: write", "last-source", "later-user"].map(x => list.indexOf(x));
  assert.ok(positions.every((x, i) => x >= 0 && (!i || x > positions[i - 1]!)), list);
});

test("grouped summaries distinguish later text, empty segments and literal ellipses", () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const text = (text: string) => ({ type: "text", text });
  const create = (later: string) => setup([...toPickerItems([
    entry("a", { role: "assistant", stopReason: "toolUse", content: [text("progress\n..."), { type: "toolCall", name: "read", arguments: {} }] }),
    entry("r", { role: "toolResult", toolName: "read", content: [text("result")] }),
    entry("b", { role: "assistant", stopReason: "stop", content: [text(later)] }),
  ])]);
  const s = create("final"); s.terminal.rows = 60; s.press(k.tools);
  const lines = s.render(80); const frame = selectedCard(lines);
  assert.match(frame, /progress/); assert.equal((frame.match(/\.\.\./g) ?? []).length, 2);
  const list = lines.slice(3, dividerRow(60)).map(stripTerminalSequences).join("\n");
  assert.ok(list.indexOf("progress") < list.indexOf("Tool call: read"));
  assert.ok(list.indexOf("Tool output: read") < list.indexOf("final"));
  assert.ok(lines.some(line => line.includes(theme.getFgAnsi("muted") + "...")));
  s.press(k.tools); const compact = selectedCard(s.render(80));
  assert.ok(compact.includes("progress") && compact.includes("final"));
  assert.equal((compact.match(/\.\.\./g) ?? []).length, 1);
  const empty = create("\n"); empty.terminal.rows = 60; empty.press(k.tools);
  assert.equal((selectedCard(empty.render(80)).match(/\.\.\./g) ?? []).length, 1);
});

test("keyboard selection follows blocks and calls in a single entry", async () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const text = (text: string) => ({ type: "text", text });
  const items = toPickerItems([entry("a", { role: "assistant", stopReason: "stop", content: [
    text("```js\none()\n```"), { type: "toolCall", name: "read", arguments: { path: "x" } }, text("```js\ntwo()\n```")
  ] })]);
  const s = setup([...items]); s.terminal.rows = 60; s.press(k.tools);
  for (const [key, expected] of [[k.down, "one()"], [k.down, '"path"'], [k.down, "two()"]] as const) {
    s.press(key); assert.ok(selectedCard(s.render()).includes(expected), selectedCard(s.render()));
  }
  s.press(k.enter); await settle(); assert.deepEqual(s.copied, ["two()"]);
  const off = setup([...items]); off.terminal.rows = 60; off.press(k.down); off.press(k.down);
  assert.ok(selectedCard(off.render()).includes("two()"));
});

test("a fence spanning a tool call keeps the call visible and its block selectable", () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const s = setup([...toPickerItems([entry("a", { role: "assistant", stopReason: "stop", content: [
    { type: "text", text: "```js\none()" }, { type: "toolCall", name: "read", arguments: {} },
    { type: "text", text: "two()\n```" },
  ] })])]);
  s.terminal.rows = 60; s.press(k.tools); s.press(k.down);
  const lines = s.render(80); const frame = selectedCard(lines);
  assert.ok(frame.includes("one()") && frame.includes("two()"));
  const list = lines.slice(3, dividerRow(60)).map(stripTerminalSequences).join("\n");
  assert.ok(list.includes("Tool call: read"), list);
  s.press(k.down); assert.ok(selectedCard(s.render(80)).includes("{}"));
});


test("selected spanning block is rendered once around interleaved tools", async () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const text = (text: string) => ({ type: "text", text });
  const items = toPickerItems([entry("a", { role: "assistant", stopReason: "stop", content: [
    text("```js\none()"), { type: "toolCall", name: "read", arguments: {} },
    text("two()\n```\ncontext after"), { type: "toolCall", name: "write", arguments: {} }, text("last"),
  ] })]);
  for (const tools of [true, false]) {
    const s = setup([...items]); s.terminal.rows = 80;
    if (tools) s.press(k.tools);
    s.press(k.down);
    const lines = s.render(80); const frame = selectedCard(lines);
    const list = lines.slice(3, dividerRow(80)).map(stripTerminalSequences).join("\n");
    assert.equal((list.match(/two\(\)/g) ?? []).length, 1, list);
    assert.ok(frame.includes("one()") && frame.includes("two()"));
    assert.ok(frame.split("\n").length <= 9);
    assert.ok(frame.split("\n").every(line => line.startsWith("  ") && line.length <= 78));
    assert.ok(list.includes("context after") && list.includes("last"), list);
    if (tools) {
      assert.ok(list.indexOf("Tool call: read") > list.indexOf("one()"));
      assert.ok(list.indexOf("Tool call: write") > list.indexOf("context after"));
      assert.equal((list.match(/Tool call: (?:read|write)/g) ?? []).length, 2);
    }
    const preview = lines.slice(dividerRow(80) + 1).map(stripTerminalSequences).join("\n");
    assert.ok(preview.includes("one()") && preview.includes("two()"));
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, ["one()\ntwo()"]);
  }
});


test("spanning code in progress retains final entry and ordered tool events", async () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const text = (text: string) => ({ type: "text", text });
  for (const newline of ["\n", "\r\n", "\r"]) {
    const items = toPickerItems([
      entry("p", { role: "assistant", stopReason: "toolUse", content: [text(`before${newline}\`\`\`js${newline}one()`),
        { type: "toolCall", name: "read", arguments: {} }, text(`two()${newline}\`\`\`${newline}context after`)] }),
      entry("r", { role: "toolResult", toolName: "read", content: [text("result")] }),
      entry("f", { role: "assistant", stopReason: "stop", content: [text("final")] }),
    ]);
    const s = setup([...items]); s.terminal.rows = 80; s.press(k.tools); s.press(k.down);
    const list = s.render(80).slice(3, dividerRow(80)).map(stripTerminalSequences).join("\n");
    assert.equal((list.match(/two\(\)/g) ?? []).length, 1, list);
    const positions = ["before", "one()", "Tool call: read", "context after", "Tool output: read", "final"].map(value => list.indexOf(value));
    assert.ok(positions.every((value, i) => value >= 0 && (!i || value > positions[i - 1]!)), list);
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, [`one()\ntwo()`]);
  }
});

test("a block closed before a tool does not suppress later matching content", () => {
  const entry = (id: string, message: unknown) => ({ type: "message", id, message } as SessionEntry);
  const text = (text: string) => ({ type: "text", text });
  const s = setup([...toPickerItems([entry("a", { role: "assistant", stopReason: "stop", content: [
    text("```js\none()\n```"), { type: "toolCall", name: "read", arguments: {} }, text("one()\nafter"),
  ] })])]);
  s.terminal.rows = 60; s.press(k.tools); s.press(k.down);
  const list = s.render(80).slice(3, dividerRow(60)).map(stripTerminalSequences).join("\n");
  assert.equal((list.match(/one\(\)/g) ?? []).length, 2, list);
  assert.ok(list.indexOf("after") > list.indexOf("Tool call: read"), list);
});

test("selected user separates decorative shading from genuine blank source rows", async () => {
  for (const [raw, summary] of [
    ["first\nlast", ["first", "last"]],
    ["first\n\nlast", ["first", "", "last"]],
    ["first\n\n\nlast", ["first", "...", "last"]],
    ["one\ntwo\nthree\nfour\nfive\nsix", ["one", "two", "three", "four", "..."]],
  ] as const) {
    const s = setup([item("user", raw, "user")]); s.terminal.rows = 40;
    const lines = s.render(32);
    const start = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
    const frame = selectedCard(lines).split("\n");
    assert.deepEqual(frame.slice(1, -1).map(row => row.slice(2, -1).trimEnd()), ["", ...summary, ""]);
    const bg = theme.getBgAnsi("userMessageBg");
    assert.ok(!lines[start]!.includes(bg) && !lines[start + frame.length - 1]!.includes(bg));
    assert.ok(lines.slice(start + 1, start + frame.length - 1).every(row => row.includes(bg)));
    assert.ok(!lines[start + 1]!.includes(theme.fg("muted", "...")));
    assert.ok(!lines[start + frame.length - 2]!.includes(theme.fg("muted", "...")));
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, [raw]);
  }
});

test("selected user child retains source context and does not gain parent padding", () => {
  const raw = "before\n> ```javascript\n> const value = 1;\n> ```\nafter";
  const s = setup([item("user", raw, "user")]); s.terminal.rows = 40;
  s.press(k.down);
  const lines = s.render(100);
  const frame = selectedCard(lines).split("\n");
  assert.ok(frame[0]!.startsWith("  ╭"));
  assert.ok(frame[1]!.includes("> ```javascript"));
  assert.ok(frame.at(-2)!.includes("> ```"));
  assert.ok(lines.some(row => stripTerminalSequences(row).includes("before")));
  assert.ok(lines.some(row => stripTerminalSequences(row).includes("after")));
  const highlighted = getMarkdownTheme().highlightCode?.("const value = 1;", "javascript")?.[0];
  assert.ok(highlighted && lines.some(row => row.includes(highlighted)));
});

test("adjacent user and assistant share the selected frame separators", () => {
  for (const items of [[item("u", "hello", "user"), item("a", "reply")], [item("a", "reply"), item("u", "hello", "user")]]) {
    const s = setup(items); s.terminal.rows = 40;
    if (items[0]!.kind === "user") s.press(k.up);
    const lines = s.render(100).slice(3, dividerRow(40)).map(stripTerminalSequences);
    const top = lines.findIndex(row => row.startsWith("╭"));
    const bottom = lines.findIndex(row => row.startsWith("╰"));
    const reply = lines.findIndex(row => row.includes("reply"));
    assert.equal(bottom - top, 4);
    assert.equal(Math.min(Math.abs(reply - top), Math.abs(reply - bottom)), 1);
  }
});

test("user decoration does not create hidden-content indicators", () => {
  const s = setup([item("user", "hello", "user")]);
  for (const rows of [15, 40]) {
    s.terminal.rows = rows;
    const lines = s.render(32).map(stripTerminalSequences);
    assert.equal(lines[2]!.trim(), "");
    assert.equal(lines[3 + Math.floor((rows - 6) * 0.6)]!.trim(), "");
    assert.equal(selectedCard(s.render(32)).split("\n").length, 5);
  }
});

test("whitespace source lines wrap independently of blank-line compression", async () => {
  for (const kind of ["user", "assistant"] as const) for (const raw of [" ".repeat(56), " ".repeat(200), "\t".repeat(50)]) {
    const s = setup([item("spaces", raw, kind)]); s.terminal.rows = 40;
    const lines = s.render(32);
    const start = lines.findIndex(line => line.includes(theme.getFgAnsi("accent") + "╭"));
    const frame = selectedCard(lines).split("\n");
    const padding = kind === "user" ? 1 : 0;
    const content = frame.slice(1 + padding, -1 - padding);
    const total = Math.ceil(raw.replace(/\t/g, "    ").length / 28);
    const cap = kind === "user" ? 5 : 7;
    assert.equal(content.length, Math.min(total, cap));
    assert.equal(content.at(-1)!.includes("..."), total > cap);
    if (total > cap) assert.ok(lines[start + padding + content.length]!.includes(theme.fg("muted", "...")));
    assert.ok(frame[0]!.startsWith("╭") && frame.at(-1)!.startsWith("╰"));
    if (padding) {
      const bg = theme.getBgAnsi("userMessageBg");
      assert.ok(!lines[start]!.includes(bg) && !lines[start + frame.length - 1]!.includes(bg));
      assert.ok(lines.slice(start + 1, start + frame.length - 1).every(row => row.includes(bg)));
      assert.equal(frame[1]!.slice(1, -1).trim(), "");
      assert.equal(frame.at(-2)!.slice(1, -1).trim(), "");
    }
    assert.ok(lines.every(row => visibleWidth(row) === 32));
    s.press(k.enter); await settle(); assert.deepEqual(s.copied, [raw]);
  }
  for (const kind of ["user", "assistant"] as const) for (const [gap, expected] of [[" \r\n", ""], [" \r\n\t\r\n", "..."]] as const) {
    const s = setup([item("gap", `first\r\n${gap}last`, kind)]); s.terminal.rows = 40;
    const lines = s.render(32); const frame = selectedCard(lines).split("\n");
    const content = frame.slice(kind === "user" ? 2 : 1, kind === "user" ? -2 : -1);
    assert.deepEqual(content.map(row => row.slice(2, -1).trimEnd()), ["first", expected, "last"]);
    assert.equal(lines.some(row => row.includes(theme.fg("muted", "..."))), expected === "...");
  }
  for (const kind of ["user", "assistant"] as const) {
    const s = setup([item("small", " ".repeat(200), kind)]); s.terminal.rows = kind === "user" ? 15 : 11;
    const lines = s.render(32); const frame = selectedCard(lines).split("\n");
    assert.equal(frame.length, kind === "user" ? 5 : 3);
    assert.ok(frame[kind === "user" ? 2 : 1]!.includes("..."));
    assert.ok(lines.some(row => row.includes(theme.fg("muted", "..."))));
  }
});

test("list clipping indicators inherit only the adjacent user row background", () => {
  for (const kind of ["user", "assistant"] as const) {
    const text = Array.from({ length: 40 }, (_, i) => `key-${i} 漢字`).join("\n");
    const s = setup([item("long", text, kind)]);
    s.terminal.rows = 18;
    s.press("key");
    const bg = theme.getBgAnsi("userMessageBg");
    const check = (line: string) => {
      assert.equal(stripTerminalSequences(line).trim(), "...");
      assert.equal(line.includes(bg), kind === "user");
      assert.ok(line.includes(theme.getFgAnsi("muted")));
      assert.equal(visibleWidth(line), 40);
    };
    let lines = s.render(40);
    assert.equal(stripTerminalSequences(lines[2]!).trim(), "");
    check(lines[3 + Math.floor((18 - 6) * 0.6)]!);
    s.press(k.right);
    lines = s.render(40);
    check(lines[2]!);
    check(lines[3 + Math.floor((18 - 6) * 0.6)]!);
    assert.ok(!lines[dividerRow(18)]!.includes(bg));
    assert.ok(lines.slice(dividerRow(18) + 1).every(line => !line.includes(bg)));
    for (let i = 0; i < 20; i++) s.press(k.right);
    lines = s.render(40);
    check(lines[2]!);
    assert.equal(stripTerminalSequences(lines[3 + Math.floor((18 - 6) * 0.6)]!).trim(), "");
  }
});

test("list indicators follow the nearest hidden row across user and assistant boundaries", () => {
  const bg = theme.getBgAnsi("userMessageBg");
  const make = (count: number) => {
    const s = setup([item("user", Array.from({ length: count }, (_, i) => `key-user-${i}`).join("\n"), "user"), item("assistant", "key-assistant")]);
    s.terminal.rows = 18;
    s.press("key");
    return s.render(40);
  };
  const userPadding = make(5);
  const separator = make(4);
  for (const [lines, shaded] of [[userPadding, true], [separator, false]] as const) {
    const indicator = lines[10]!;
    assert.equal(stripTerminalSequences(indicator).trim(), "...");
    assert.equal(indicator.includes(bg), shaded);
    assert.ok(!lines[11]!.includes(bg));
  }
});

test("shaded clipping indicators have plain margins and preserve muted foreground", () => {
  const s = setup([item("user", Array.from({ length: 30 }, (_, i) => `key-${i}`).join("\n"), "user")]);
  s.terminal.rows = 18;
  s.press("key");
  const line = s.render(41)[10]!;
  const bg = theme.getBgAnsi("userMessageBg");
  assert.ok(line.startsWith(" " + bg));
  assert.ok(line.endsWith("\x1b[49m "));
  assert.ok(line.includes(theme.fg("muted", "...")));
  assert.equal(visibleWidth(line), 41);
  assert.equal(stripTerminalSequences(line).indexOf("..."), 2);
});

test("clipping follows custom theme after search, resize and selection", () => {
  for (const color of ["#111122", "#eeeecc"]) {
    const custom = { ...colors, userMessageBg: color };
    const customTheme = new Theme(custom as unknown as ConstructorParameters<typeof Theme>[0], custom as unknown as ConstructorParameters<typeof Theme>[1], "truecolor");
    const s = setup([item("user", Array.from({ length: 40 }, (_, i) => `key-${i} 漢`).join("\n"), "user"), item("other", "other")], undefined, customTheme);
    s.terminal.rows = 18;
    s.press("key");
    for (const width of [32, 45]) {
      const lines = s.render(width);
      assert.ok(lines[10]!.includes(customTheme.getBgAnsi("userMessageBg")));
      assert.equal(visibleWidth(lines[10]!), width);
    }
    s.press(k.right);
    assert.ok(s.render(45)[2]!.includes(customTheme.getBgAnsi("userMessageBg")));
    s.press(k.down);
    const selected = s.render(45);
    assert.ok(selected.every(line => visibleWidth(line) === 45));
    assert.ok(!selected[dividerRow(18)]!.includes(customTheme.getBgAnsi("userMessageBg")));
  }
});

test("tool source clipping does not inherit a nearby user background", () => {
  const s = setup([item("user", "key-user", "user"), { id: "tool", kind: "tool-result", toolName: "read", rawText: Array.from({ length: 35 }, (_, i) => `key-tool-${i}`).join("\n") }]);
  s.terminal.rows = 18;
  s.press(k.tools);
  s.press("key");
  s.press(k.right);
  const lines = s.render(40);
  for (const line of [lines[2]!, lines[10]!]) {
    assert.equal(stripTerminalSequences(line).trim(), "...");
    assert.ok(!line.includes(theme.getBgAnsi("userMessageBg")));
  }
});

test("clipping indicators do not leave isolated user backgrounds at either edge", () => {
  const bg = theme.getBgAnsi("userMessageBg");
  const assistant = item("assistant", Array.from({ length: 12 }, (_, i) => `key-agent-${i}`).join("\n"));
  for (const [kind, count, indicator, adjacent] of [["bottom", 1, 10, 9], ["top", 4, 2, 3]] as const) {
    const user = item("user", Array.from({ length: count }, (_, i) => `key-user-${i}`).join("\n"), "user");
    const s = setup(kind === "bottom" ? [assistant, user] : [user, assistant]);
    s.terminal.rows = 18;
    s.press("key"); s.render(40); s.press(k.right);
    const rows = s.render(40);
    assert.equal(stripTerminalSequences(rows[indicator]!).trim(), "...");
    assert.ok(!rows[adjacent]!.includes(bg), `${kind} adjacent row has no user background`);
    assert.ok(!rows[indicator]!.includes(bg), `${kind} indicator should not have isolated background`);
    assert.ok(rows[indicator]!.includes(theme.fg("muted", "...")));
  }
});
