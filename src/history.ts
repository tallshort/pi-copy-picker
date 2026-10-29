import { Marked } from "@earendil-works/pi-tui";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type ItemKind =
  | { readonly kind: "user" | "assistant" }
  | { readonly kind: "tool-call" | "tool-result"; readonly toolName: string };

export type PickItem = Readonly<ItemKind & {
  id: string;
  order?: number;
  segments?: readonly { sourceStart: number; sourceEnd: number; entryId: string; order: number }[];
  omittedNonText?: boolean;
  rawText: string;
}>;

export function toPickerItems(entries: readonly SessionEntry[]): readonly PickItem[] {
  const items: PickItem[] = [];
  let group: { index: number; id: string; rawText: string; omitted: boolean; segments: { sourceStart: number; sourceEnd: number; entryId: string; order: number }[] } | undefined;
  const flush = () => {
    if (!group) return;
    items[group.index] = Object.freeze({ id: group.id, kind: "assistant", rawText: group.rawText, omittedNonText: group.omitted, segments: group.segments, order: group.segments[0]?.order });
    group = undefined;
  };
  let order = 0;
  for (const entry of entries) {
    if (entry.type !== "message") { flush(); continue; }
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") { flush(); continue; }
    const content = message.content;
    const rawText = typeof content === "string"
      ? content
      : content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const omitted = typeof content !== "string" && content.some(block => block.type === "image" || block.type === "toolCall" || block.type === "thinking");
    if (message.role === "toolResult") {
      items.push(Object.freeze({ id: `${entry.id}:result`, kind: "tool-result", toolName: message.toolName, order: order++, omittedNonText: omitted, rawText }));
    } else if (message.role === "user") {
      flush();
      items.push(Object.freeze({ id: `${entry.id}:message`, kind: "user", order: order++, omittedNonText: omitted, rawText }));
    } else {
      const hasText = message.content.some(block => block.type === "text");
      const empty = message.content.length === 0 && message.stopReason !== "aborted";
      const include = (hasText || empty) && !(message.stopReason === "aborted" && !rawText.length);
      let segment: { sourceStart: number; sourceEnd: number; entryId: string; order: number } | undefined;
      let seenText = false;
      const append = (text: string) => {
        if (!group) {
          group = { index: items.length, id: `${entry.id}:message`, rawText: "", omitted, segments: [] };
          items.push(Object.freeze({ id: group.id, kind: "assistant", rawText: "", omittedNonText: omitted }));
        }
        if (!segment) {
          segment = { sourceStart: group.rawText.length, sourceEnd: 0, entryId: entry.id, order: order++ };
          group.segments.push(segment);
        }
        if (!seenText && group.rawText && rawText) {
          const trailing = (group.rawText.match(/(?:\r\n|\r|\n)+$/)?.[0].match(/\r\n|\r|\n/g) ?? []).length;
          const leading = (rawText.match(/^(?:\r\n|\r|\n)+/)?.[0].match(/\r\n|\r|\n/g) ?? []).length;
          const seam = trailing + leading - (group.rawText.endsWith("\r") && rawText.startsWith("\n") ? 1 : 0);
          group.rawText += "\n".repeat(Math.max(0, 2 - seam));
        }
        group.rawText += (seenText ? "\n" : "") + text;
        segment.sourceEnd = group.rawText.length;
        group.omitted ||= omitted;
        seenText = true;
      };
      if (include && empty) append("");
      message.content.forEach((block, index) => {
        if (block.type === "text" && include) append(block.text);
        else if (block.type === "toolCall") {
          segment = undefined;
          items.push(Object.freeze({ id: `${entry.id}:call:${index}`, kind: "tool-call", toolName: block.name, order: order++,
            rawText: JSON.stringify(block.arguments, null, 2) }));
        }
      });
      if (message.stopReason !== "toolUse") flush();
    }
  }
  flush();
  return Object.freeze(items);
}

export type PickTarget = Readonly<{
  id: string;
  messageId: string;
  message: PickItem;
  rawText: string;
} & ({ kind: "message" } | { kind: "block"; blockKind: "quote" | "code" | "inline-code"; language?: string; sourceText: string; sourceStart: number; sourceEnd: number; fence?: { opening: string; closing?: string } })>;

// Source lines keep clipboard payloads independent of rendering.
export function toPickTargets(message: PickItem): readonly PickTarget[] {
  const parent: PickTarget = { kind: "message", id: message.id, messageId: message.id, message, rawText: message.rawText };
  if (message.kind !== "user" && message.kind !== "assistant") return [parent];
  if (message.segments && message.segments.length > 1) {
    const sourceLines = message.rawText.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
    const spans: { sourceStart: number; sourceEnd: number; entryId: string }[] = [];
    for (const segment of message.segments) {
      const last = spans.at(-1);
      if (last?.entryId === segment.entryId) last.sourceEnd = segment.sourceEnd;
      else spans.push({ ...segment });
    }
    const blocks = spans.flatMap(segment => {
      const start = segment.sourceStart + (message.rawText[segment.sourceStart - 1] === "\r" && message.rawText[segment.sourceStart] === "\n" ? 1 : 0);
      const offset = (message.rawText.slice(0, start).match(/\r\n|\r|\n/g) ?? []).length;
      return toPickTargets({ ...message, segments: undefined, rawText: message.rawText.slice(start, segment.sourceEnd) })
        .filter((target): target is Extract<PickTarget, { kind: "block" }> => target.kind === "block")
        .map(target => ({ ...target, message, sourceStart: target.sourceStart + offset, sourceEnd: target.sourceEnd + offset,
          id: `${message.id}:block:${target.sourceStart + offset}`,
          sourceText: sourceLines.slice(target.sourceStart + offset, target.sourceEnd + offset).join("") }));
    });
    return [parent, ...blocks];
  }
  const lines = message.rawText.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const blocks: PickTarget[] = [];
  let rich = false;
  const content = (line: string) => line.replace(/(?:\r\n|\r|\n)$/, "");
  const unquote = (line: string) => line.replace(/^(?: {0,3}>[ \t]?)+/, "");
  const listIndents: number[] = [];
  const listContext = (line: string) => {
    const text = unquote(content(line));
    if (!text.trim()) return;
    const indent = /^ */.exec(text)![0].length;
    while (listIndents.length && indent < listIndents.at(-1)!) listIndents.pop();
    const marker = /^( *)(?:[-+*]|\d+[.)])([ \t]+)/.exec(text);
    if (marker && indent <= (listIndents.at(-1) ?? 0) + 3) {
      const contentIndent = marker[0].length;
      if (listIndents.at(-1) !== contentIndent) listIndents.push(contentIndent);
    }
  };
  const codeIndent = () => (listIndents.at(-1) ?? 0) + 4;
  const fence = (line: string) => {
    const match = /^( *)(?:([-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})([^\r\n]*)$/.exec(unquote(content(line)));
    return match && (match[1]!.length <= (listIndents.at(-1) ?? 0) + 3) ? match : null;
  };
  const inlineCode = (line: string): string | undefined => {
    const text = content(line);
    const opener = /^ {0,3}(`+)(?!`)/.exec(text);
    if (!opener) return undefined;
    const runs = /`+/g;
    runs.lastIndex = opener[0].length;
    for (let match = runs.exec(text); match; match = runs.exec(text)) {
      if (match[0].length !== opener[1]!.length) continue;
      const payload = text.slice(opener[0].length, match.index);
      return /^[ \t]*$/.test(text.slice(match.index + match[0].length)) && payload.trim() ? payload : undefined;
    }
    return undefined;
  };
  const structure = (line: string) => /^(?: {0,3}(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d+[.)]\s)| {4}|\t)|^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(content(line));
  const inlineCandidates = new Map<number, { line: number; raw: string; payload: string }>();
  let sourceOffset = 0;
  for (let line = 0; line < lines.length; line++) {
    const text = content(lines[line]!);
    const payload = inlineCode(lines[line]!);
    if (payload !== undefined) {
      const indent = /^ */.exec(text)![0].length;
      inlineCandidates.set(sourceOffset + indent, { line, raw: text.slice(indent).trimEnd(), payload });
    }
    sourceOffset += lines[line]!.replace(/\r\n|\r/g, "\n").length;
  }
  const inlineTargets = new Map<number, string>();
  const normalized = message.rawText.replace(/\r\n|\r/g, "\n");
  const protectedLines = new Set<number>();
  {
    let offset = 0;
    let line = 0;
    for (const token of new Marked().lexer(normalized)) {
      if (!normalized.startsWith(token.raw, offset)) break;
      const count = (token.raw.match(/\n/g) ?? []).length;
      if (token.type === "paragraph" || token.type === "html") {
        for (let n = 1; n <= count; n++) {
          if (n < count || !token.raw.endsWith("\n")) protectedLines.add(line + n);
        }
      }
      line += count;
      if (token.type === "paragraph") {
        let innerOffset = offset;
        for (const inline of token.tokens ?? []) {
          if (!normalized.startsWith(inline.raw, innerOffset)) break;
          const candidate = inlineCandidates.get(innerOffset);
          if (inline.type === "codespan" && candidate?.raw === inline.raw) {
            inlineTargets.set(candidate.line, candidate.payload);
          }
          innerOffset += inline.raw.length;
        }
      }
      offset += token.raw.length;
    }
  }
  const inlineAt = (index: number) => inlineTargets.get(index);
  const add = (start: number, end: number, blockKind: "quote" | "code" | "inline-code", rawText = lines.slice(start, end).join(""), language?: string, fence?: { opening: string; closing?: string }) => {
    const sourceText = lines.slice(start, end).join("");
    if (blockKind === "quote") {
      rawText = lines.slice(start, end).map(line => line.replace(/^ {0,3}>[ \t]?/, "")).join("");
      if (!rawText.trim()) return;
    }
    blocks.push({ kind: "block", sourceStart: start, sourceEnd: end, id: `${message.id}:block:${start}`, messageId: message.id, message, blockKind, rawText, language, sourceText, fence });
  };
  let i = 0;
  while (i < lines.length) {
    if (!content(lines[i]!).trim()) { i++; continue; }
    listContext(lines[i]!);
    const start = i;
    const opening = fence(lines[i]!);
    if (opening && !(opening[3]![0] === "`" && opening[4]!.includes("`"))) {
      rich = true;
      const marker = opening[3]!;
      const indent = opening[1]!.length + (opening[2] ? opening[2].length + 1 : 0);
      const quotePrefix = /^(?: {0,3}>[ \t]?)+/.exec(lines[i]!)?.[0] ?? "";
      const quoteDepth = (quotePrefix.match(/>/g) ?? []).length;
      const removeContainer = (line: string) => {
        for (let depth = 0; depth < quoteDepth; depth++) line = line.replace(/^ {0,3}>[ \t]?/, "");
        return line;
      };
      const containerIndent = listIndents.at(-1) ?? 0;
      const payload: string[] = [];
      let closingFence: string | undefined;
      let externalBlankStart: number | undefined;
      i++;
      for (; i < lines.length; i++) {
        const prefix = /^(?: {0,3}>[ \t]?)+/.exec(lines[i]!)?.[0] ?? "";
        if ((prefix.match(/>/g) ?? []).length < quoteDepth) break;
        const line = removeContainer(lines[i]!);
        const blank = !content(line).trim();
        const lineIndent = /^ */.exec(line)![0].length;
        if (!blank && lineIndent < containerIndent) break;
        const closing = new RegExp(`^ {${containerIndent},${containerIndent + 3}}(\x60+|~+)[ \t]*$`).exec(content(line));
        if (closing && closing[1]![0] === marker[0] && closing[1]!.length >= marker.length) { closingFence = content(lines[i]!); externalBlankStart = undefined; i++; break; }
        if (!blank) externalBlankStart = undefined;
        else if (lineIndent < containerIndent) externalBlankStart ??= payload.length;
        payload.push(line.replace(new RegExp(`^ {0,${indent}}`), ""));
      }
      if (externalBlankStart !== undefined) payload.length = externalBlankStart;
      add(start, i, "code", payload.join(""), opening[4]!.trim().split(/\s+/)[0] || undefined, { opening: content(lines[start]!), closing: closingFence });
      continue;
    }
    const indentation = codeIndent();
    const indented = (line: string) => new RegExp(`^(?: {${indentation}}|\\t)`).test(line);
    if (indented(lines[i]!)) {
      rich = true;
      i++;
      while (i < lines.length && (indented(lines[i]!) || !content(lines[i]!).trim())) i++;
      while (i > start && !content(lines[i - 1]!).trim()) i--;
      add(start, i, "code", lines.slice(start, i).map(line => line.replace(new RegExp(`^(?: {${indentation}}|\\t)`), "")).join(""));
      continue;
    }
    const inline = inlineAt(i);
    if (inline !== undefined) {
      rich = true;
      i++;
      add(start, i, "inline-code", inline);
      continue;
    }
    const first = content(lines[i]!);
    const heading = /^ {0,3}#{1,6}(?:\s|$)/.test(first);
    const rule = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(first);
    const list = /^ {0,3}(?:[-+*]|\d+[.)])\s/.test(first);
    const quote = /^ {0,3}>/.test(first);
    rich ||= structure(lines[i]!);
    i++;
    if (!heading && !rule) {
      while (i < lines.length && content(lines[i]!).trim()) {
        listContext(lines[i]!);
        const continuation = protectedLines.has(i) || ((list || quote) && /^(?: {4}|\t)/.test(lines[i]!));
        if ((!list && inlineAt(i) !== undefined) || (quote && /^ {0,3}>[ \t]*$/.test(content(lines[i - 1]!)) && !/^ {0,3}>/.test(content(lines[i]!))) || fence(lines[i]!) || (!continuation && new RegExp(`^ {${codeIndent()}}`).test(lines[i]!))) break;
        if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(content(lines[i]!)) && !list && !quote) { rich = true; i++; break; }
        if (/^\s*\|?\s*:?-{3,}/.test(content(lines[i]!)) && first.includes("|")) rich = true;
        else if (structure(lines[i]!) && !continuation && !(list && /^(?: {0,3}(?:[-+*]|\d+[.)])\s|\s{1,})/.test(lines[i]!)) && !(quote && /^ {0,3}>/.test(lines[i]!))) break;
        i++;
      }
    }
    if (quote) add(start, i, "quote");
  }
  return rich ? [parent, ...blocks] : [parent];
}

export function copyText(target: PickTarget): string {
  return target.kind === "block" && (target.blockKind === "code" || target.blockKind === "quote")
    ? target.rawText.replace(/(?:\r\n|\n|\r)+$/, "") : target.rawText;
}
