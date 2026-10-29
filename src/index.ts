import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { copyText, toPickerItems, toPickTargets } from "./history.js";
import { PickerScreen } from "./picker.js";

export default function copyPicker(pi: ExtensionAPI): void {
  let generation = 0;
  pi.on("session_start", () => { generation++; });
  pi.on("session_shutdown", () => { generation++; });
  let copying = false;
  const copyBlock = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/copy-block requires interactive TUI mode", "error");
      return;
    }
    if (copying) return;
    const branch = ctx.sessionManager.getBranch();
    const item = [...toPickerItems(branch)].reverse().find(item => item.kind === "assistant");
    const targets = item ? toPickTargets(item) : [];
    const target = targets.filter(target => target.kind === "block" && copyText(target).length > 0).at(-1)
      ?? (item?.rawText.length ? targets[0] : undefined);
    if (!target) {
      ctx.ui.notify("No copyable text in the latest assistant message", "warning");
      return;
    }
    copying = true;
    const current = generation;
    try {
      await copyToClipboard(copyText(target));
      if (current === generation) ctx.ui.notify("Copied message to clipboard", "info");
    } catch (error) {
      if (current === generation) ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      copying = false;
    }
  };
  pi.registerShortcut("ctrl+shift+b", { description: "Copy last assistant block", handler: copyBlock });
  pi.registerCommand("copy-block", {
    description: "Copy the last block or message from the latest assistant reply (Ctrl+Shift+B)",
    handler: (_args, ctx) => copyBlock(ctx),
  });
  pi.registerCommand("copy-picker", {
    description: "Browse and copy current-branch messages in fullscreen",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/copy-picker requires interactive TUI mode", "error");
        return;
      }
      const current = ++generation;
      const items = toPickerItems(ctx.sessionManager.getBranch());
      let flash: (() => void) | undefined;
      const result = await ctx.ui.custom<"copied" | undefined>((tui, theme, kb, done) => {
        if (tui instanceof TuiAltScreen) flash = () => tui.flash("Copied!");
        return new PickerScreen(items, tui, theme, kb, done);
      }, {
          overlay: true,
          overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
        });
      if (result !== "copied" || current !== generation) return;
      if (flash) flash();
      else ctx.ui.notify("Copied message to clipboard", "info");
    },
  });
}
