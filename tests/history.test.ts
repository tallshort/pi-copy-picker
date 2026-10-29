import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { toPickerItems } from "../src/history.js";

function entry(id: string, message: unknown): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message } as SessionEntry;
}

test("extracts text blocks in order without trimming or leaking thinking and metadata", () => {
  const items = toPickerItems([
    entry("u", { role: "user", content: "  原文\t\n\n" }),
    entry("a", { role: "assistant", content: [
      { type: "thinking", thinking: "SECRET", thinkingSignature: "SIGNATURE" },
      { type: "text", text: " first\n", textSignature: "SECRET" },
      { type: "toolCall", name: "bash", id: "call", arguments: { command: "pwd" }, thoughtSignature: "SECRET" },
      { type: "text", text: " last  " },
    ] }),
    entry("r", { role: "toolResult", toolName: "bash", content: [
      { type: "text", text: "  output\n" }, { type: "image", data: "SECRET", mimeType: "image/png" },
      { type: "text", text: "end\n" },
    ], details: { secret: "SECRET" } }),
  ]);
  assert.deepEqual(items.map(item => item.id), ["u:message", "a:message", "a:call:2", "r:result"]);
  assert.deepEqual(items.map(item => item.rawText), ["  原文\t\n\n", " first\n\n last  ", '{\n  "command": "pwd"\n}', "  output\n\nend\n"]);
  assert.equal(items[1]!.omittedNonText, true);
  assert.equal(items[2]!.kind, "tool-call");
  assert.equal(items[3]!.omittedNonText, true);
  assert.ok(!JSON.stringify(items).includes("SECRET"));
  assert.ok(Object.isFrozen(items) && items.every(Object.isFrozen));
});

test("retains image-only and empty messages, omits pure tool assistant and hidden roles", () => {
  const items = toPickerItems([
    entry("image", { role: "user", content: [{ type: "image", data: "hidden", mimeType: "image/png" }] }),
    entry("empty", { role: "assistant", content: [] }),
    entry("tool", { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] }),
    entry("think", { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] }),
    entry("result", { role: "toolResult", toolName: "read", content: [] }),
    ...["system", "custom", "bashExecution", "branchSummary", "compactionSummary", "unknown"].map(role => entry(role, { role, content: "hidden" })),
    { type: "custom_message", id: "custom", content: "hidden", display: true } as SessionEntry,
    { type: "compaction", id: "compact", summary: "hidden" } as SessionEntry,
  ]);
  assert.deepEqual(items.map(item => item.id), ["image:message", "empty:message", "tool:call:0", "result:result"]);
  assert.equal(items[0]!.rawText, "");
  assert.equal(items[0]!.omittedNonText, true);
  assert.equal(items[1]!.rawText, "");
  assert.equal(items[3]!.rawText, "");
});

test("active branch snapshot excludes abandoned messages and keeps pre-compaction originals", () => {
  const session = SessionManager.inMemory();
  const root = session.appendMessage({ role: "user", content: "original", timestamp: 0 });
  session.appendMessage({ role: "user", content: "abandoned", timestamp: 1 });
  session.branch(root);
  session.appendCompaction("summary", root, 100);
  session.appendMessage({ role: "user", content: "current", timestamp: 2 });
  const items = toPickerItems(session.getBranch());
  assert.deepEqual(items.map(item => item.rawText), ["original", "current"]);
});

test("source block extraction preserves Markdown and nested fenced and indented code", async () => {
  const { toPickTargets } = await import("../src/history.js");
  const blocks = (rawText: string) => toPickTargets({ id: "m", kind: "assistant", rawText });
  assert.equal(blocks("plain\n\nparagraph").length, 1);
  assert.equal(blocks("").length, 1);
  const raw = "# heading\r\n\r\n> ````js\r\n> const a = `x`;\r\n> ```\r\n> ````\r\n\r\n- item\n\n  ~~~python\n  print(1)\n  ~~~\n\n    indented\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n\nlast";
  const targets = blocks(raw);
  assert.equal(targets[0]!.rawText, raw);
  assert.deepEqual(targets.slice(1).map(target => target.rawText), ["const a = `x`;\r\n```\r\n", "print(1)\n"]);
  assert.deepEqual(blocks("```js\n```\n~~~py\nx\n~~~").slice(1).map(target => target.rawText), ["", "x\n"]);
  assert.deepEqual(blocks("# a\n# b\n> quote\n\nparagraph").slice(1).map(target => target.rawText), ["quote\n"]);
});

test("fence containers do not eat literal code quotes, short fences or deep list code", async () => {
  const { toPickTargets } = await import("../src/history.js");
  for (const [source, expected] of [
    ["````text\n> literal\n> ```\n````", "> literal\n> ```\n"],
    ["> ```text\n> > literal\n> ```", "> literal\n"],
    ["- outer\n  - inner\n\n    ```js\n    const x = 1;\n    ```", "const x = 1;\n"],
    ["```js\nconst x = `~~~`;\n~~~\n```", "const x = `~~~`;\n~~~\n"],
  ]) {
    const code = toPickTargets({ id: "m", kind: "assistant", rawText: source! }).filter(target => target.kind === "block" && target.blockKind === "code");
    assert.deepEqual(code.map(target => target.rawText), [expected]);
  }
});

test("unclosed quote fences stop at their container while top-level fences reach EOF", async () => {
  const { toPickTargets } = await import("../src/history.js");
  const blocks = (rawText: string) => toPickTargets({ id: "m", kind: "assistant", rawText }).slice(1);
  assert.deepEqual(blocks("> ```js\n> const x = 1;\n\nOutside paragraph.\n\n```sh\necho hello\n```\n").map(t => t.rawText),
    ["const x = 1;\n", "echo hello\n"]);
  assert.deepEqual(blocks("> > ```js\n> > x\n> outside\n").map(t => t.rawText), ["x\n", "outside\n"]);
  assert.deepEqual(blocks("```js\nx\n\noutside\n").map(t => t.rawText), ["x\n\noutside\n"]);
});

test("indented code starts four columns beyond list content and resets after list exit", async () => {
  const { toPickTargets } = await import("../src/history.js");
  for (const [prefix, indent] of [["- item", 2], ["10. item", 4], ["- outer\n  - inner\n    - deep", 6]] as const) {
    const source = `${prefix}\n\n${" ".repeat(indent + 2)}continued paragraph\n\n${" ".repeat(indent + 4)}const x = 1;  \r\n\n${" ".repeat(indent + 4)}  next\n\nExit list.\n\n    fresh\n`;
    const targets = toPickTargets({ id: "m", kind: "assistant", rawText: source }).slice(1);
    assert.ok(!targets.some(t => t.rawText.includes("continued paragraph")));
    assert.deepEqual(targets.filter(t => t.kind === "block" && t.blockKind === "code").map(t => t.rawText), ["const x = 1;  \r\n\n  next\n", "fresh\n"]);
  }
});

test("unclosed list fences stop at container exits and drop external trailing blanks", async () => {
  const { toPickTargets } = await import("../src/history.js");
  for (const quote of ["", "> ", "> > "]) {
    const source = "- item\n\n  ```js\n  x\n\nOutside paragraph.\n\n```sh\necho hello\n```\n"
      .split(/(?<=\n)/).map(line => quote + line).join("");
    const blocks = toPickTargets({ id: "m", kind: "assistant", rawText: source }).slice(1);
    assert.deepEqual(blocks.filter(t => t.kind === "block" && t.blockKind === "code").map(t => t.rawText), ["x\n", "echo hello\n"]);
    if (!quote) assert.ok(!blocks.some(t => t.rawText.includes("Outside paragraph")));
  }
  const blocks = toPickTargets({ id: "m", kind: "assistant", rawText: "- item\n\n  ```\n  x\n\n  y\n\n" });
  assert.deepEqual(blocks.filter(t => t.kind === "block" && t.blockKind === "code").map(t => t.rawText), ["x\n\ny\n"]);
});

test("closing fence indentation is relative to the container, not the opener", async () => {
  const { toPickTargets } = await import("../src/history.js");
  for (const [prefix, offset] of [["", ""], ["- item\n\n", "  "], ["> - item\n>\n", ">   "]] as const) {
    const source = prefix + `${offset}   \`\`\`text\n${offset}    \`\`\`\n${offset}keep\n${offset}   \`\`\`\n`;
    const code = toPickTargets({ id: "m", kind: "assistant", rawText: source }).filter(t => t.kind === "block" && t.blockKind === "code");
    assert.deepEqual(code.map(t => t.rawText), [" ```\nkeep\n"]);
  }
});

test("child filtering counts source nonblank lines and retains exact code source separately", async () => {
  const { toPickTargets } = await import("../src/history.js");
  const sources = ["~~~python\nprint(1)\n~~~", "> ````js\n> const x = 1;\n> ````", "- item\n\n  ```js\n  x\n  ```", "```unknown\nx", "    x\n    y"];
  for (const source of sources) {
    const targets = toPickTargets({ id: "m", kind: "user", rawText: source });
    assert.equal(targets[0]!.rawText, source);
    const code = targets.find(t => t.kind === "block" && t.blockKind === "code");
    assert.ok(code && code.kind === "block");
    assert.equal(code.sourceText, source.startsWith("- item") ? source.slice(8) : source);
  }
  const raw = "### JavaScript\n\nOne line that visually wraps. ".repeat(4) + "\n\n- one\n\n```js\nx\n```\n\nParagraph first\nparagraph second\n";
  const targets = toPickTargets({ id: "m", kind: "assistant", rawText: raw });
  assert.deepEqual(targets.slice(1).map(t => t.rawText), ["x\n"]);
});

test("quotes preserve source previews and remove exactly one prefix in a single target", async () => {
  const { toPickTargets } = await import("../src/history.js");
  for (const newline of ["\n", "\r\n"]) {
    const source = ["   >  first  ", ">", ">\tsecond\t ", "> > nested", "lazy continuation  "].join(newline) + newline;
    const raw = "# heading" + newline + newline + source + newline + "outside";
    const targets = toPickTargets({ id: "q", kind: "assistant", rawText: raw });
    assert.equal(targets[0]!.rawText, raw);
    assert.equal(targets.length, 2);
    const quote = targets[1]!;
    assert.ok(quote.kind === "block" && quote.blockKind === "quote");
    assert.equal(quote.sourceText, source);
    assert.equal(quote.rawText, [" first  ", "", "second\t ", "> nested", "lazy continuation  "].join(newline) + newline);
  }
  for (const rawText of [">", "> \n>\t\n", "# heading", "one line"]) {
    assert.equal(toPickTargets({ id: "empty", kind: "assistant", rawText }).length, 1);
  }
  const mixed = toPickTargets({ id: "mixed", kind: "assistant", rawText: "> text\n> ```js\n> const x = 1;\n> ```\n> after\n\nordinary first\nordinary second\n" });
  assert.deepEqual(mixed.slice(1).map(t => t.rawText), ["text\n", "const x = 1;\n", "after\n"]);
});

test("duplicate fenced blocks retain their source positions and independent preceding context", async () => {
  const { toPickTargets } = await import("../src/history.js");
  const rawText = "First\n\n```js\nx\n```\n\nSecond\n\n```js\nx\n```";
  const code = toPickTargets({ id: "a", kind: "assistant", rawText }).filter(t => t.kind === "block" && t.blockKind === "code");
  assert.deepEqual(code.map(t => t.kind === "block" && [t.sourceStart, t.sourceEnd]), [[2, 5], [8, 11]]);
});

test("standalone inline code targets preserve delimiters separately and follow source order", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  const rawText = "Intro\r\n`/tmp/example/report.html`\r\nAfter\r\n\r\n> quote\r\n\r\n```js\r\n`inside`\r\n```\r\n\r\n  `` `value` `` \t\r\n\r\nTail first\r\nTail second\r\n";
  const targets = toPickTargets({ id: "inline", kind: "assistant", rawText });
  assert.equal(copyText(targets[0]!), rawText);
  assert.deepEqual(targets.slice(1).map(t => copyText(t)), ["/tmp/example/report.html", "quote", "`inside`", " `value` "]);
  const inline = targets.filter(t => t.kind === "block" && t.blockKind === "inline-code");
  assert.deepEqual(inline.map(t => t.kind === "block" && t.sourceText), ["`/tmp/example/report.html`\r\n", "  `` `value` `` \t\r\n"]);
});

test("inline code excludes sentences, headings, containers, malformed and empty spans", async () => {
  const { toPickTargets } = await import("../src/history.js");
  for (const rawText of ["Use `x` here", "# `heading`", "`heading`\n---", "`heading`\n===", "`a` `b`", "\\`escaped`", "`unclosed", "``", "` `", "``   ``", "- `list`", "https://example.test/`path`", "\t`indented`", "    `indented`"]) {
    const targets = toPickTargets({ id: "x", kind: "assistant", rawText });
    assert.ok(!targets.some(t => t.kind === "block" && t.blockKind === "inline-code"), rawText);
  }
  for (const [rawText, expected] of [["`` a`b ``", " a`b "], ["`a\\\\b`", "a\\\\b"], ["```abc```", "abc"]] as const) {
    const targets = toPickTargets({ id: "x", kind: "assistant", rawText });
    assert.equal(targets[1]?.rawText, expected, rawText);
  }
  const quote = toPickTargets({ id: "q", kind: "assistant", rawText: "> `quoted`" });
  assert.equal(quote.length, 2);
  assert.equal(quote[1]?.kind === "block" && quote[1].blockKind, "quote");
  const fenced = toPickTargets({ id: "f", kind: "assistant", rawText: "```js\n`inside`\n```" });
  assert.equal(fenced.length, 2);
  assert.equal(fenced[1]?.kind === "block" && fenced[1].blockKind, "code");
});

test("inline extraction respects multiline headings and code spans", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  const targets = (rawText: string) => toPickTargets({ id: "m", kind: "assistant", rawText });
  for (const nl of ["\n", "\r\n"]) {
    const heading = ["`heading`", "continued title", "---"].join(nl);
    assert.deepEqual(targets(heading).map(copyText), [heading]);
    for (const raw of [["start `open", "`inner`", "close`"], ["start ``open", "``inner``", "close``"]]) {
      const source = raw.join(nl);
      assert.deepEqual(targets(source).map(copyText), [source], source);
    }
    for (const raw of [["description", "`value`"], ["`value`", "description"], ["unmatched `", "", "`value`"], ["\\`escaped", "`value`"]]) {
      const source = raw.join(nl);
      assert.ok(targets(source).some(t => t.kind === "block" && t.blockKind === "inline-code" && copyText(t) === "value"), source);
    }
  }
});

test("inline scanning resets at block boundaries and respects escaped openers", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  const blocks = (rawText: string) => toPickTargets({ id: "m", kind: "assistant", rawText }).filter(t => t.kind === "block" && t.blockKind === "inline-code").map(copyText);
  for (const source of ["unmatched `\n\n`value`", "unmatched `\n# heading\n`value`", "```text\nunmatched `\n```\n`value`", "\\`escaped\n`value`", "unmatched `` and ```\n`value`", "    `code`\n\n`value`", "> quote\n\n`value`", "- item\n\n`value`"]) {
    assert.deepEqual(blocks(source), ["value"], source);
  }
  for (const source of ["\\\\`open\n`inner`\nclose`", "start ``open ` literal\n``inner``\nclose``", "- item\n`value`", "> quote\n`value`"]) {
    assert.deepEqual(blocks(source), [], source);
  }
});


test("prose stays in the parent and adjacent code context, never in the child sequence", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  const raw = "First description\nsecond line\n\n```markdown\n# example\n```\n\nNext description\nsecond line\n\n```js\nrun()\n```\n\nTrailing text\nanother line\n";
  const targets = toPickTargets({ id: "m", kind: "assistant", rawText: raw });
  assert.deepEqual(targets.map(copyText), [raw, "# example", "run()"]);
  assert.deepEqual(targets.slice(1).map(t => t.kind === "block" && t.sourceText), ["```markdown\n# example\n```\n", "```js\nrun()\n```\n"]);
  const later = raw + "\n`later`\n\ntrailing prose\nmore prose\n";
  assert.equal(copyText(toPickTargets({ id: "m", kind: "assistant", rawText: later }).at(-1)!), "later");
});

test("inline targets follow Markdown token boundaries, not isolated lines", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  for (const nl of ["\n", "\r\n"]) {
    const invalid = [
      ["\\``open", "`value`"], ["start ```", "```value```"],
      ["<div>", "`value`"], ["<!-- comment", "`value`"],
      ["<script>", "", "`value`"], ["<![CDATA[", "`value`"],
      ["<?instruction", "`value`"], ["<!DOCTYPE html", "`value`"],
      ["<custom-tag>", "`value`"], ["- item", "  - nested", "    `value`"],
    ];
    for (const parts of invalid) {
      const source = parts.join(nl);
      assert.deepEqual(toPickTargets({ id: "m", kind: "assistant", rawText: source }).filter(t => t.kind === "block" && t.blockKind === "inline-code"), [], source);
    }
    for (const source of [ ["<div>", "</div>", "", "`value`"], ["<!-- comment", "-->", "`value`"], ["description", "`value`"], ["`value`", "description"] ].map(lines => lines.join(nl))) {
      assert.ok(toPickTargets({ id: "m", kind: "assistant", rawText: source }).some(t => t.kind === "block" && t.blockKind === "inline-code" && copyText(t) === "value"), source);
    }
  }
});

test("HTML block terminators and fences bound standalone inline targets", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  const inline = (rawText: string) => toPickTargets({ id: "m", kind: "assistant", rawText })
    .filter(t => t.kind === "block" && t.blockKind === "inline-code").map(copyText);
  for (const [open, close] of [["<script>", "</script>"], ["<pre>", "</pre>"], ["<style>", "</style>"], ["<textarea>", "</textarea>"], ["<!--", "-->"], ["<?xml", "?>"], ["<!DOCTYPE", ">"], ["<![CDATA[", "]]>"], ["<div>", "</div>"], ["<custom>", "</custom>"]]) {
    assert.deepEqual(inline(`${open}\n\`inside\`\n${close}\n\n\`after\``), ["after"], open);
  }
  for (const source of ["~~~js\n`inside`\n~~~\n\n`after`", "```js\r\n`inside`\r\n```\r\n\r\n`after`", "unmatched `` and ```\n`after`", "\\`escaped\n`after`"]) {
    assert.deepEqual(inline(source), ["after"], source);
  }
  assert.deepEqual(inline("~~~js\n`inside`"), []);
});

test("quoted blanks end lazy continuation while standalone code follows lexer boundaries", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  for (const nl of ["\n", "\r\n", "\r"]) {
    const source = ["> quote", ">", "`x`"].join(nl);
    const targets = toPickTargets({ id: "q", kind: "assistant", rawText: source });
    assert.deepEqual(targets.map(copyText), [source, "quote", "x"]);
    assert.equal(targets[1]?.kind === "block" && targets[1].sourceText, `> quote${nl}>${nl}`);
    const lazy = ["> quote", "`x`"].join(nl);
    assert.deepEqual(toPickTargets({ id: "q", kind: "assistant", rawText: lazy }).map(copyText), [lazy, `quote${nl}\`x\``]);
    for (const [parts, quote] of [
      [["> quote", "regular"], `quote${nl}regular`],
      [["> quote", ">", "regular"], "quote"],
    ] as const) {
      const rawText = parts.join(nl);
      assert.deepEqual(toPickTargets({ id: "q", kind: "assistant", rawText }).map(copyText), [rawText, quote]);
    }
  }
});

test("mixed line endings preserve source and code clipboard data", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  for (const rawText of ["hello\rworld\n\n`x`", "hello\rworld\r\r  `` x `` \t\r", "hello\r\nworld\r\n\r\n`x`\r\n"]) {
    const targets = toPickTargets({ id: "m", kind: "assistant", rawText });
    assert.equal(copyText(targets[0]!), rawText);
    assert.equal(copyText(targets[1]!), rawText.includes("`` x ``") ? " x " : "x");
    assert.equal(targets[1]?.kind === "block" && targets[1].sourceText, rawText.slice(rawText.lastIndexOf(rawText.includes("`` x ``") ? "  ``" : "`x`")));
  }
  const rawText = "> quote\r>\r\n```js\r  x\r\ny\n```\r";
  const targets = toPickTargets({ id: "m", kind: "assistant", rawText });
  assert.equal(copyText(targets[0]!), rawText);
  assert.deepEqual(targets.slice(1).map(copyText), ["quote", "  x\r\ny"]);
});



test("groups assistant tool-use segments into one ordered reply without crossing boundaries", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  const a = (id: string, text: string, stopReason: string) => entry(id, { role: "assistant", stopReason, content: [
    { type: "text", text }, ...(stopReason === "toolUse" ? [{ type: "toolCall", name: "read", arguments: { id } }] : []),
    { type: "thinking", thinking: "secret" },
  ] });
  const result = (id: string) => entry(id, { role: "toolResult", toolName: "read", content: [{ type: "text", text: "tool secret" }] });
  const items = toPickerItems([entry("u", { role: "user", content: "question" }), a("p1", "Progress one\n", "toolUse"), result("r1"),
    a("p2", "\nProgress two", "toolUse"), result("r2"), a("final", "Final\n\n```js\nx\n```\n\n`y`\n\n> z", "stop"),
    a("retry", "independent", "stop"), a("abort", "partial", "aborted"), a("after", "after abort", "stop")]);
  assert.deepEqual(items.map(x => x.id), ["u:message", "p1:message", "p1:call:1", "r1:result", "p2:call:1", "r2:result", "retry:message", "abort:message", "after:message"]);
  const parent = items[1]!;
  assert.equal(parent.rawText, "Progress one\n\nProgress two\n\nFinal\n\n```js\nx\n```\n\n`y`\n\n> z");
  assert.deepEqual(toPickTargets(parent).map(copyText), [parent.rawText, "x", "y", "z"]);
  assert.ok(!parent.rawText.includes("secret"));
  const separated = toPickerItems([a("x", "first", "toolUse"), { type: "compaction", id: "c" } as SessionEntry, a("y", "second", "stop")]);
  assert.deepEqual(separated.filter(x => x.kind === "assistant").map(x => x.rawText), ["first", "second"]);
  assert.equal(toPickerItems([a("single", "  original\r\n", "stop")])[0]!.rawText, "  original\r\n");
  assert.deepEqual(toPickerItems([a("valid", "final", "stop"), a("empty-abort", "", "aborted")]).map(x => x.rawText), ["final"]);
  assert.equal(toPickerItems([a("a", "one\r", "toolUse"), a("b", "\ntwo", "stop")])[0]!.rawText, "one\r\n\ntwo");
});

test("assistant segment fences are independent and source offsets survive CRLF seams", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  for (const nl of ["\n", "\r\n", "\r"]) {
    const items = toPickerItems([
      entry("p", { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: `~~~js${nl}first()` }] }),
      entry("f", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `second${nl}${nl}\`value\`` }] }),
    ]);
    const targets = toPickTargets(items[0]!);
    assert.deepEqual(targets.slice(1).map(copyText), ["first()", "value"]);
    const lines = items[0]!.rawText.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)!;
    for (const target of targets) if (target.kind === "block") {
      assert.equal(lines.slice(target.sourceStart, target.sourceEnd).join(""), target.sourceText);
    }
  }
  const items = toPickerItems([
    entry("p", { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "one\r" }] }),
    entry("f", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "\n\n`two`" }] }),
  ]);
  const target = toPickTargets(items[0]!)[1]!;
  assert.equal(target.kind === "block" && target.sourceStart, 2);
  assert.equal(copyText(target), "two");
});

test("indented paragraph continuations are prose, while separated code and later fences remain targets", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  for (const kind of ["user", "assistant"] as const) for (const nl of ["\n", "\r\n", "\r"]) {
    for (const indent of ["    ", "\t"]) {
      const prose = ["第一行普通文字", `${indent}第二行普通文字`].join(nl);
      assert.deepEqual(toPickTargets({ id: "m", kind, rawText: prose }).map(copyText), [prose]);
      const source = [prose, "```js", "real()", "```"].join(nl);
      const targets = toPickTargets({ id: "m", kind, rawText: source });
      assert.deepEqual(targets.map(copyText), [source, "real()"]);
      const code = targets[1]!;
      assert.ok(code.kind === "block");
      assert.deepEqual([code.sourceStart, code.sourceEnd, code.sourceText], [2, 5, ["```js", "real()", "```"].join(nl)]);
      const separated = ["paragraph", "", `${indent}code`].join(nl);
      assert.deepEqual(toPickTargets({ id: "m", kind, rawText: separated }).map(copyText), [separated, "code"]);
      const standalone = [`${indent}first`, `${indent}second`].join(nl);
      assert.deepEqual(toPickTargets({ id: "m", kind, rawText: standalone }).map(copyText), [standalone, `first${nl}second`]);
    }
    for (const source of [`- item${nl}      continuation`, `<pre>${nl}    raw${nl}</pre>`]) {
      assert.deepEqual(toPickTargets({ id: "m", kind, rawText: source }).map(copyText), [source]);
    }
    const quoted = `> quote${nl}    continuation`;
    assert.deepEqual(toPickTargets({ id: "m", kind, rawText: quoted }).map(copyText), [quoted, `quote${nl}    continuation`]);
  }
});

test("Markdown lexer distinguishes paragraph continuation from standalone indented code", async () => {
  const { Marked } = await import("@earendil-works/pi-tui");
  const lexer = new Marked();
  for (const indent of ["    ", "\t"]) {
    assert.deepEqual(lexer.lexer(`first\n${indent}second`).map(token => token.type), ["paragraph"]);
    assert.deepEqual(lexer.lexer(`${indent}first\n${indent}second`).map(token => token.type), ["code"]);
    assert.deepEqual(lexer.lexer(`first\n\n${indent}second`).map(token => token.type), ["paragraph", "space", "code"]);
  }
});

test("text around calls keeps raw bytes and a fence crossing chunks remains one block", async () => {
  const { toPickTargets, copyText } = await import("../src/history.js");
  const text = (text: string) => ({ type: "text", text });
  const items = toPickerItems([entry("a", { role: "assistant", stopReason: "stop", content: [
    { type: "thinking", thinking: "SECRET" }, text("```js\nfirst()"),
    { type: "toolCall", name: "read", arguments: { path: "x" } }, text("second()\n```"),
    { type: "toolCall", name: "write", arguments: {} }, text(""), text("tail"),
  ] })]);
  assert.deepEqual(items.map(item => item.id), ["a:message", "a:call:2", "a:call:4"]);
  assert.equal(items[0]!.rawText, "```js\nfirst()\nsecond()\n```\n\ntail");
  assert.deepEqual(toPickTargets(items[0]!).slice(1).map(copyText), ["first()\nsecond()"]);
  assert.ok(!JSON.stringify(items).includes("SECRET"));
});


test("thinking omitted from a text reply is marked without exposing it", () => {
  const items = toPickerItems([entry("a", { role: "assistant", stopReason: "stop", content: [
    { type: "thinking", thinking: "SECRET" }, { type: "text", text: "visible" },
  ] })]);
  assert.equal(items[0]!.omittedNonText, true);
  assert.equal(items[0]!.rawText, "visible");
  assert.ok(!JSON.stringify(items).includes("SECRET"));
});
