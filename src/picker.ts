import { copyToClipboard, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Input, Key, Markdown, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type KeybindingsManager, type TUI,
} from "@earendil-works/pi-tui";
import { copyText, toPickTargets, type PickItem, type PickTarget } from "./history.js";

type CopyState = { kind: "idle" | "pending" } | { kind: "error"; message: string };
type Interaction = { kind: "active"; selectedId: string | undefined }
  | { kind: "unfocused" };
type LineStream = { lines: string[]; content: boolean[]; userBackground: boolean[]; ranges: { item: PickTarget; start: number; end: number; contentStart: number; contentEnd: number; userPadding?: { top: number; bottom: number } }[] };

function safeDisplay(text: string): string {
  return stripTerminalSequences(text.replace(/\r\n?/g, "\n")).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function fit(text: string, width: number): string {
  const line = truncateToWidth(text, width, "");
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

const sourceSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapSource(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const rows: string[] = [];
  let row = "";
  let columns = 0;
  let style = "";
  for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]+/g) ?? []) {
    if (token.startsWith("\x1b")) {
      row += token;
      style = token === "\x1b[0m" ? "" : style + token;
      continue;
    }
    for (const { segment } of sourceSegmenter.segment(token)) {
      const size = visibleWidth(segment);
      if (columns + size > width) {
        rows.push(row + (style ? "\x1b[0m" : ""));
        row = style;
        columns = 0;
      }
      row += segment;
      columns += size;
    }
  }
  rows.push(row + (style ? "\x1b[0m" : ""));
  return rows;
}

export class PickerScreen implements Component, Focusable {
  private readonly queryInput = new Input({ prompt: "type to search > " });
  private interaction: Interaction = { kind: "active", selectedId: undefined };
  private viewportStart = Infinity;
  private readonly sources = new Map<string, { width: number; rows: string[][] }>();
  private readonly lineStarts = new Map<string, number[]>();
  private revealSelection = true;
  private pageIndex: number | undefined;

  private get selectedId(): string | undefined {
    return this.interaction.kind === "active" ? this.interaction.selectedId : undefined;
  }
  private showTools = false;
  private scrollTop = 0;
  private copyState: CopyState = { kind: "idle" };
  private disposed = false;
  private width = 80;
  private renderedRows: number | undefined;
  private cachedWidth: number | undefined;
  private readonly previews = new Map<string, { rawText: string; lines: string[]; codeLines: string[] }>();
  private readonly targets = new Map<string, readonly PickTarget[]>();
  private filtered: { query: string; tools: boolean; items: readonly PickItem[] } | undefined;

  constructor(
    private readonly items: readonly PickItem[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly kb: KeybindingsManager,
    private readonly close: (result?: "copied") => void,
    private readonly copy: (text: string) => Promise<void> = copyToClipboard,
  ) {
    this.select(this.visibleItems().at(-1)?.id);
  }

  get focused(): boolean { return this.queryInput.focused; }
  set focused(value: boolean) { this.queryInput.focused = value; }

  private visibleItems(): readonly PickItem[] {
    const query = this.queryInput.getValue().toLowerCase();
    if (this.filtered?.query === query && this.filtered.tools === this.showTools) return this.filtered.items;
    const items = this.items.filter(item =>
      (this.showTools || item.kind === "user" || item.kind === "assistant") &&
      `${"toolName" in item ? item.toolName : ""}\n${item.rawText}`.toLowerCase().includes(query));
    this.filtered = { query, tools: this.showTools, items };
    return items;
  }

  private lineCountAt(message: PickItem, offset: number): number {
    let starts = this.lineStarts.get(message.id);
    if (!starts) {
      starts = Array.from(message.rawText.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g), match => match.index);
      this.lineStarts.set(message.id, starts);
    }
    let low = 0, high = starts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid]! < offset) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private visibleTargets(items = this.visibleItems(), showTools = this.showTools): readonly PickTarget[] {
    const events = items.flatMap((item, index) => {
      let targets = this.targets.get(item.id);
      if (!targets) { targets = toPickTargets(item); this.targets.set(item.id, targets); }
      if (!showTools || !item.segments?.length) return [{ order: item.order ?? index * 1000, targets }];
      return item.segments.map((segment, segmentIndex) => {
        const start = this.lineCountAt(item, segment.sourceStart);
        const end = segment.sourceEnd === item.rawText.length ? Infinity : this.lineCountAt(item, segment.sourceEnd);
        return { order: segment.order, targets: targets!.filter(target => target.kind === "message"
          ? segmentIndex === 0 : target.sourceStart >= start && target.sourceStart < end) };
      });
    });
    return events.sort((a, b) => a.order - b.order).flatMap(event => event.targets);
  }

  private select(id: string | undefined): void {
    if (id !== this.selectedId) {
      this.interaction = { kind: "active", selectedId: id };
      this.scrollTop = 0;
      this.pageIndex = undefined;
      this.revealSelection = true;
    }
  }

  private reconcile(): void {
    if (this.interaction.kind !== "active") return;
    const visible = this.visibleTargets();
    if (visible.some(item => item.id === this.selectedId)) return;
    const all = this.visibleTargets(this.items, true);
    const previousIndex = all.findIndex(item => item.id === this.selectedId);
    const visibleIds = new Set(visible.map(item => item.id));
    const previous = all.slice(0, Math.max(0, previousIndex)).reverse()
      .find(item => visibleIds.has(item.id));
    this.select(previous?.id ?? visible[0]?.id);
  }

  private listRows(): number { return Math.floor(Math.max(0, this.tui.terminal.rows - 6) * 0.6); }

  private windowTooSmall(): boolean {
    const selected = this.visibleTargets().find(target => target.id === this.selectedId);
    const minListRows = selected?.kind === "message" && selected.message.kind === "user" ? 5 : 3;
    return this.width < 32 || this.listRows() < minListRows || this.previewRows() < 2;
  }

  private previewRows(): number { return Math.max(0, this.tui.terminal.rows - 6 - this.listRows()); }

  private sourceLines(message: PickItem): string[] {
    const lines = (message.rawText.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [])
      .map(line => safeDisplay(line.replace(/(?:\r\n|\r|\n)$/, "")).replace(/\t/g, "    "));
    const targets = this.targets.get(message.id) ?? toPickTargets(message);
    for (const block of targets) {
      if (block.kind !== "block" || block.blockKind !== "code") continue;
      const payload = safeDisplay(block.rawText).replace(/\t/g, "    ").split("\n");
      const highlighted = getMarkdownTheme().highlightCode?.(payload.join("\n"), block.language);
      const start = block.sourceStart + (block.fence ? 1 : 0);
      for (let i = 0; i < payload.length && start + i < block.sourceEnd; i++) {
        const original = lines[start + i]!;
        const colored = highlighted?.[i];
        if (payload[i] && original.endsWith(payload[i]!) && colored !== undefined && stripTerminalSequences(colored) === payload[i]) {
          lines[start + i] = original.slice(0, original.length - payload[i]!.length) + colored;
        }
      }
    }
    return lines;
  }

  private sourceRows(message: PickItem, width: number): string[][] {
    const cached = this.sources.get(message.id);
    if (cached?.width === width) return cached.rows;
    const rows = this.sourceLines(message).map(line => wrapSource(line, Math.max(1, width - 4))
      .map(text => this.body(message, text, width - 2)));
    this.sources.set(message.id, { width, rows });
    return rows;
  }

  private stream(width = this.width): LineStream {
    const lines: string[] = [];
    const content: boolean[] = [];
    const userBackground: boolean[] = [];
    const add = (isContent: boolean, ...rows: string[]) => { lines.push(...rows); content.push(...rows.map(() => isContent)); userBackground.push(...rows.map(() => false)); };
    const addUser = (isContent: boolean, ...rows: string[]) => { add(isContent, ...rows); userBackground.fill(true, userBackground.length - rows.length); };
    const ranges: LineStream["ranges"] = [];
    this.visibleTargets();
    const events = this.visibleItems().flatMap((message, index) => {
      if (this.showTools && message.segments?.length) return message.segments.map(segment => ({ message,
        start: this.lineCountAt(message, segment.sourceStart),
        end: segment.sourceEnd === message.rawText.length ? this.sourceRows(message, width).length : this.lineCountAt(message, segment.sourceEnd), order: segment.order }));
      return [{ message, start: 0, end: this.sourceRows(message, width).length, order: message.order ?? index * 1000 }];
    }).sort((a, b) => a.order - b.order);
    let previousTool = false;
    const summarized = new Set<string>();
    for (const { message, start: sourceStart, end: sourceEnd } of events) {
      const group = this.targets.get(message.id)!;
      const parent = group[0]!;
      const selected = group.find(target => target.id === this.selectedId);
      const firstSegment = !summarized.has(message.id);
      const tool = message.kind === "tool-call" || message.kind === "tool-result";
      if (selected?.kind === "message" && firstSegment) {
        summarized.add(message.id);
        if (lines.length && (tool || previousTool)) add(false, "");
        if (tool) add(true, this.theme.fg("dim", ` Tool ${message.kind === "tool-call" ? "call" : "output"}: ${safeDisplay(message.toolName)}`));
        const shared = lines.length > 0 && !tool && !previousTool;
        if (shared) { lines.pop(); content.pop(); userBackground.pop(); }
        const start = lines.length;
        const card = this.card(selected, width, this.showTools && message.segments?.length ? message.rawText.split(/\r\n|\r|\n/).slice(sourceStart, sourceEnd).join("\n") : undefined,
          this.showTools && !!message.segments?.slice(1).some(segment => message.rawText.slice(segment.sourceStart, segment.sourceEnd).trim()));
        const padding = message.kind === "user" ? 1 : 0;
        add(false, card[0]!);
        if (padding) addUser(false, card[1]!);
        (padding ? addUser : add)(true, ...card.slice(1 + padding, card.length - 1 - padding));
        if (padding) addUser(false, card[card.length - 2]!);
        add(false, card[card.length - 1]!);
        ranges.push({ item: selected, start, end: start + card.length, contentStart: start + 1 + padding, contentEnd: start + card.length - 1 - padding });
        previousTool = tool;
        continue;
      }
      const border = (top: boolean) => this.theme.fg("dim", (top ? "╭" : "╰") + "─".repeat(width - 2) + (top ? "╮" : "╯"));
      if (lines.length && (tool || previousTool)) add(false, "");
      const shared = lines.length > 0 && !tool && !previousTool;
      const start = lines.length - (shared ? 1 : 0);
      if (!shared) add(false, tool ? border(true) : "");
      previousTool = tool;
      const top = lines.length;
      const decorate = (line: string) => tool ? this.theme.fg("dim", "│") + line + this.theme.fg("dim", "│") : " " + line + " ";
      if (message.kind === "user") addUser(false, decorate(this.body(message, "", width - 2)));
      if (tool) add(true, decorate(this.body(message, `Tool ${message.kind === "tool-call" ? "call" : "output"}: ${safeDisplay(message.toolName)}`, width - 2)));
      const rows = this.sourceRows(message, width);
      let focusStart = -1;
      let focusEnd = -1;
      for (let source = sourceStart; source < sourceEnd; source++) {
        if (selected?.kind === "block" && source === selected.sourceStart) {
          focusStart = lines.length;
          const card = this.card(selected, width);
          add(true, card[0]!);
          (message.kind === "user" ? addUser : add)(true, ...card.slice(1, -1));
          add(true, card[card.length - 1]!);
          focusEnd = lines.length;
          source = selected.sourceEnd - 1;
        } else if (selected?.kind !== "block" || source < selected.sourceStart || source >= selected.sourceEnd) {
          (message.kind === "user" ? addUser : add)(true, ...rows[source]!.map(decorate));
        }
      }
      const bottom = lines.length;
      if (message.kind === "user") addUser(false, decorate(this.body(message, "", width - 2)));
      add(false, tool ? border(false) : "");
      ranges.push({ item: focusStart >= 0 ? selected! : parent, start: focusStart >= 0 ? focusStart : start,
        end: focusStart >= 0 ? focusEnd : lines.length, contentStart: top, contentEnd: bottom,
        userPadding: message.kind === "user" ? { top, bottom } : undefined });
    }
    return { lines, content, userBackground, ranges };
  }

  private clampViewport(stream: LineStream): void {
    const rows = Math.max(1, this.listRows());
    const max = Math.max(0, stream.lines.length - rows);
    this.viewportStart = Math.max(0, Math.min(max, this.viewportStart));
    if (this.revealSelection && this.interaction.kind === "active") {
      const target = this.visibleTargets().find(item => item.id === this.selectedId);
      const range = stream.ranges.find(entry => entry.item.id === target?.id) ?? stream.ranges.find(entry => entry.item.messageId === target?.messageId);
      if (range) {
        if (range.end - range.start > rows) this.viewportStart = range.start;
        else this.viewportStart = range.start - Math.floor((rows - (range.end - range.start)) / 2);
        this.viewportStart = Math.max(0, Math.min(max, this.viewportStart));
      }
    }
    this.revealSelection = false;
  }

  private pageMove(delta: number): void {
    const stream = this.stream();
    this.clampViewport(stream);
    const rows = Math.max(1, this.listRows());
    const max = Math.max(0, stream.lines.length - rows);
    const currentPage = this.pageIndex ?? (this.viewportStart === max ? Math.ceil(stream.lines.length / rows) - 1 : Math.ceil(this.viewportStart / rows));
    const nextPage = Math.max(0, Math.min(Math.ceil(stream.lines.length / rows) - 1, currentPage + delta));
    const start = Math.max(0, Math.min(max, this.viewportStart + delta * rows));
    if (start === this.viewportStart) return;
    this.viewportStart = start;
    if (this.interaction.kind !== "active") { this.pageIndex = nextPage; return; }
    const visible = stream.ranges.filter(range => range.contentStart < start + rows && range.contentEnd > start);
    const choice = start === 0 ? visible[0] : start === max ? visible.at(-1)
      : visible.find(range => range.item.id === this.selectedId && range.start >= start && range.end <= start + rows) ?? visible[0];
    if (!choice) return;
    this.select(choice.item.id);
    const updated = this.stream();
    const selected = updated.ranges.find(range => range.item.id === this.selectedId);
    const updatedMax = Math.max(0, updated.lines.length - rows);
    if (selected) {
      // Keep the same source anchor when replacing the selected card changes row counts.
      const anchored = start === max ? updatedMax : start === 0 ? 0 : start + selected.start - choice.start;
      this.viewportStart = Math.max(0, Math.min(updatedMax,
        Math.min(selected.start, Math.max(anchored, selected.end - rows))));
    }
    this.revealSelection = false;
    this.pageIndex = nextPage;
  }

  private previewLines(item: PickTarget | undefined, width: number): string[] {
    if (!item) return ["No matching messages"];
    if (!item.rawText.length) return ["No copyable text"];
    if (this.cachedWidth !== width) {
      this.previews.clear();
      this.cachedWidth = width;
    }
    let cached = this.previews.get(item.id);
    if (!cached || cached.rawText !== item.rawText) {
      const markdownTheme = getMarkdownTheme();
      const codeLines: string[] = [];
      const code = item.kind === "block" && item.blockKind === "code";
      const source = safeDisplay(item.kind === "block" && (item.blockKind === "quote" || item.blockKind === "inline-code") ? item.sourceText : item.rawText).replace(/\t/g, "    ");
      if (code) codeLines.push(...(markdownTheme.highlightCode?.(source, item.language)
        ?? source.split("\n").map(line => markdownTheme.codeBlock(line))));
      const lines = code
        ? codeLines.flatMap(line => wrapTextWithAnsi(line, width))
        : new Markdown(source, 0, 0, {
        ...markdownTheme,
        highlightCode: (code, lang) => {
          const highlighted = markdownTheme.highlightCode?.(code, lang)
            ?? code.split("\n").map(line => markdownTheme.codeBlock(line));
          codeLines.push("", ...highlighted, "");
          return highlighted;
        },
      }).render(width);
      cached = { rawText: item.rawText, lines, codeLines };
      this.previews.set(item.id, cached);
    }
    return cached.lines;
  }

  private scroll(delta: number): void {
    if (this.interaction.kind !== "active") return;
    const item = this.visibleTargets().find(item => item.id === this.selectedId);
    const lines = this.previewLines(item, Math.max(1, this.width - 2));
    const max = Math.max(0, lines.length - this.previewRows());
    this.scrollTop = Math.max(0, Math.min(max, this.scrollTop + delta));
  }

  private move(delta: number): void {
    if (this.interaction.kind === "unfocused") {
      const stream = this.stream();
      this.clampViewport(stream);
      const visible = stream.ranges.filter(range => range.contentStart < this.viewportStart + this.listRows() && range.contentEnd > this.viewportStart);
      const item = delta < 0 ? visible.at(-1)?.item : visible[0]?.item;
      if (item) this.select(item.id);
      return;
    }
    const visible = this.visibleTargets();
    const index = visible.findIndex(item => item.id === this.selectedId);
    this.select(visible[Math.max(0, Math.min(visible.length - 1, index + delta))]?.id);
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.escape) || this.kb.matches(data, "tui.select.cancel")) {
      this.dispose();
      this.close();
      return;
    }
    const baseTooSmall = this.windowTooSmall();
    if (baseTooSmall && (
      [Key.enter, Key.ctrl("t"), Key.pageUp, Key.pageDown, Key.shift("up"), Key.shift("down"),
        Key.ctrl("home"), Key.ctrl("end"), Key.up, Key.down, Key.left, Key.right].some(key => matchesKey(data, key))
      || this.kb.matches(data, "tui.select.confirm") || this.kb.matches(data, "tui.input.submit")
      || this.kb.matches(data, "tui.select.up") || this.kb.matches(data, "tui.select.down")
      || [this.kb.getResolvedBindings()["ui.editor.submit"]].flat().some(key => key !== undefined && matchesKey(data, key))
    )) return;
    if (matchesKey(data, Key.enter)) {
      void this.copySelected();
      return;
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.showTools = !this.showTools;
      this.pageIndex = undefined;
      this.reconcile();
      this.revealSelection = true;
    } else if (matchesKey(data, Key.pageUp)) this.scroll(-(this.previewRows() - 1));
    else if (matchesKey(data, Key.pageDown)) this.scroll(this.previewRows() - 1);
    else if (matchesKey(data, Key.shift("up"))) this.scroll(-1);
    else if (matchesKey(data, Key.shift("down"))) this.scroll(1);
    else if (matchesKey(data, Key.ctrl("home"))) this.scroll(-Infinity);
    else if (matchesKey(data, Key.ctrl("end"))) this.scroll(Infinity);
    else if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.left)) this.pageMove(-1);
    else if (matchesKey(data, Key.right)) this.pageMove(1);
    else if (this.kb.matches(data, "tui.select.confirm") || this.kb.matches(data, "tui.input.submit")
      || [this.kb.getResolvedBindings()["ui.editor.submit"]].flat().some(key => key !== undefined && matchesKey(data, key))) {
      void this.copySelected();
      return;
    } else if (this.kb.matches(data, "tui.select.up")) this.move(-1);
    else if (this.kb.matches(data, "tui.select.down")) this.move(1);
    else {
      const before = this.queryInput.getValue();
      this.queryInput.handleInput(data);
      const query = this.queryInput.getValue();
      const safe = safeDisplay(query).replace(/[\n\t]/g, " ");
      if (safe !== query) this.queryInput.setValue(safe);
      if (safe !== before) {
        this.interaction = { kind: "unfocused" };
        this.viewportStart = safe ? 0 : Infinity;
        this.pageIndex = undefined;
        this.revealSelection = false;
        this.scrollTop = 0;
        if (this.copyState.kind === "error") this.copyState = { kind: "idle" };
      }
    }
    this.tui.requestRender();
  }

  private async copySelected(): Promise<void> {
    if (this.copyState.kind === "pending") return;
    if (this.interaction.kind !== "active") return;
    const item = this.visibleTargets().find(item => item.id === this.selectedId);
    if (!item?.rawText.length) return;
    const rawText = copyText(item);
    if (!rawText.length) return;
    this.copyState = { kind: "pending" };
    this.tui.requestRender();
    try {
      await this.copy(rawText);
      if (this.disposed) return;
      this.dispose();
      this.close("copied");
      return;
    } catch (error) {
      if (this.disposed) return;
      this.copyState = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    this.tui.requestRender();
  }

  private status(): string {
    if (this.copyState.kind === "pending") return "Copying...";
    if (this.copyState.kind === "error") return `Copy failed: ${safeDisplay(this.copyState.message).replace(/\s+/g, " ")} · Enter to retry`;
    return "";
  }

  private body(item: PickItem, line: string, width: number): string {
    const text = fit(" " + line, width);
    return item.kind === "user"
      ? this.theme.bg("userMessageBg", this.theme.fg("userMessageText", text)) : text;
  }

  private card(target: PickTarget, width: number, segmentSource?: string, hasLaterSource = false): string[] {
    const block = target.kind === "block" ? target : undefined;
    const inset = block ? "  " : "";
    width -= inset.length * 2;
    const source = block && block.blockKind !== "inline-code"
      ? this.sourceLines(target.message).slice(block.sourceStart, block.sourceEnd)
      : !block && segmentSource === undefined ? this.sourceLines(target.message)
      : ((segmentSource ?? block?.sourceText ?? target.rawText).match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [])
        .map(line => safeDisplay(line.replace(/(?:\r\n|\r|\n)$/, "")).replace(/\t/g, "    "));
    const rows: { text: string; synthetic: boolean }[] = [];
    for (let i = 0; i < source.length;) {
      if (!stripTerminalSequences(source[i]!).trim()) {
        let end = i + 1;
        while (end < source.length && !stripTerminalSequences(source[end]!).trim()) end++;
        if (end - i > 1) rows.push({ text: "...", synthetic: true });
        else for (const text of wrapSource(source[i]!, Math.max(1, width - 4))) rows.push({ text, synthetic: false });
        i = end;
      } else {
        for (const text of wrapSource(source[i]!, Math.max(1, width - 4))) rows.push({ text, synthetic: false });
        i++;
      }
    }
    if (!rows.length) rows.push({ text: "No copyable text", synthetic: false });
    const userPadding = !block && target.message.kind === "user";
    const cap = Math.max(1, Math.min(7, this.listRows() - 2) - (userPadding ? 2 : 0));
    if (rows.length > cap) {
      rows.length = cap - 1;
      rows.push({ text: "...", synthetic: true });
    }
    if (hasLaterSource && !rows.at(-1)?.synthetic) {
      if (rows.length >= cap) rows.length = cap - 1;
      rows.push({ text: "...", synthetic: true });
    }
    const markdown = getMarkdownTheme();
    const excerpt = rows.map(row => row.synthetic ? this.theme.fg("muted", row.text)
      : block?.blockKind === "inline-code" ? markdown.code(row.text) : row.text);
    if (userPadding) { excerpt.unshift(""); excerpt.push(""); }
    const border = (top: boolean) => this.theme.fg("accent", (top ? "╭" : "╰") + "─".repeat(width - 2) + (top ? "╮" : "╯"));
    return [border(true), ...excerpt.map(line => this.theme.fg("accent", "│") + this.body(target.message, line, width - 2) + this.theme.fg("accent", "│")), border(false)].map(line => inset + line + inset);
  }

  render(width: number): string[] {
    const oldWidth = this.width;
    this.width = Math.max(0, width);
    const rows = Math.max(0, this.tui.terminal.rows);
    const tooSmall = () => Array.from({ length: rows }, (_, i) => fit(i === 0 ? "Window too small. Esc to close." : "", this.width));
    if (this.windowTooSmall()) return tooSmall();
    this.reconcile();
    const stream = this.stream(width);
    if (this.renderedRows !== rows || oldWidth !== this.width) this.pageIndex = undefined;
    this.revealSelection ||= this.renderedRows !== rows || oldWidth !== this.width;
    this.renderedRows = rows;
    this.clampViewport(stream);
    const item = this.visibleTargets().find(target => target.id === this.selectedId);
    const pageCount = Math.max(1, Math.ceil(stream.lines.length / this.listRows()));
    const maxStart = Math.max(0, stream.lines.length - this.listRows());
    const pageIndex = this.viewportStart === 0 ? 0 : this.viewportStart === maxStart ? pageCount - 1
      : Math.min(pageCount - 1, this.pageIndex ?? Math.ceil(this.viewportStart / this.listRows()));
    const help = "Enter copy · ←/→ prev/next page · Ctrl+T tools · PgUp/PgDn scroll preview · Esc close";
    const status = this.status();
    const matches = this.visibleItems().length;
    const countText = this.queryInput.getValue() ? `${matches} ${matches === 1 ? "match" : "matches"}` : "";
    const matchCount = countText && width >= visibleWidth("type to search > ") + visibleWidth(this.queryInput.getValue()) + visibleWidth(countText) + 2 ? " " + this.theme.fg("dim", countText) : "";
    const prefix = `Page ${pageIndex + 1}/${pageCount} ${this.theme.fg("dim", `(tool messages ${this.showTools ? "included" : "excluded"})`)}, `;
    const inputWidth = Math.min(width - visibleWidth(matchCount), visibleWidth("type to search > ") + visibleWidth(this.queryInput.getValue()) + 1);
    const shownPrefix = truncateToWidth(prefix, Math.max(0, width - visibleWidth(matchCount) - inputWidth), "");
    const arrow = (show: boolean, shaded: boolean) => {
      if (!show) return "";
      const text = " " + this.theme.fg("muted", "...");
      return shaded ? " " + this.theme.bg("userMessageBg", fit(text, width - 2)) + " " : " " + text;
    };
    let visibleStart = this.viewportStart;
    let visibleEnd = Math.min(stream.lines.length, visibleStart + this.listRows());
    const padding = new Set(stream.ranges.flatMap(range => range.userPadding
      ? [ ...(range.contentStart + 1 >= visibleEnd ? [range.userPadding.top] : []),
          ...(range.contentEnd <= visibleStart ? [range.userPadding.bottom] : []) ] : []));
    while (padding.has(visibleStart) && visibleStart < stream.lines.length) { visibleStart++; visibleEnd = Math.min(stream.lines.length, visibleStart + this.listRows()); }
    while (padding.has(visibleEnd - 1) && visibleEnd > visibleStart) visibleEnd--;
    const lines = [this.theme.fg("dim", help),
      status ? this.theme.fg(this.copyState.kind === "error" ? "error" : "muted", status)
        : shownPrefix + this.queryInput.render(Math.max(1, width - visibleWidth(shownPrefix) - visibleWidth(matchCount)))[0] + matchCount,
      arrow(stream.content.slice(0, visibleStart).some(Boolean), !!stream.userBackground[visibleStart - 1] && !!stream.userBackground[visibleStart])];
    const cardRows = stream.lines.slice(visibleStart, visibleEnd);
    if (!stream.lines.length) cardRows.push(" No matching messages");
    while (cardRows.length < this.listRows()) cardRows.push("");
    lines.push(...cardRows, arrow(stream.content.slice(visibleEnd).some(Boolean), !!stream.userBackground[visibleEnd] && !!stream.userBackground[visibleEnd - 1]));
    const label = " preview ";
    const left = Math.floor((width - label.length) / 2);
    lines.push(this.theme.fg("dim", "─".repeat(left) + label + "─".repeat(width - label.length - left)));
    lines.push("");
    if (this.interaction.kind !== "active") {
      const prompt = "Use ↑/↓ to select a message";
      const usable = rows - lines.length;
      const middle = Math.floor((usable - 1) / 2);
      for (let row = 0; row < usable; row++) {
        lines.push(row === middle
          ? " ".repeat(Math.max(0, Math.floor((width - visibleWidth(prompt)) / 2))) + this.theme.fg("dim", prompt)
          : "");
      }
      return lines.map(line => fit(line, width));
    }
    const preview = this.previewLines(item, Math.max(1, width - 2));
    const count = this.previewRows();
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, preview.length - count));
    const viewport = preview.slice(this.scrollTop, this.scrollTop + count);
    if (this.scrollTop + count < preview.length) viewport[count - 1] = this.theme.fg("muted", "...");
    lines.push(...viewport.map(line => " " + line));
    while (lines.length < rows) lines.push("");
    return lines.map(line => fit(line, width));
  }

  invalidate(): void {
    this.previews.clear();
    this.sources.clear();
    this.cachedWidth = undefined;
    this.queryInput.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.previews.clear();
    this.sources.clear();
    this.lineStarts.clear();
  }
}
