# Development

## Setup and checks

On a local checkout, install dependencies with `npm ci` and run `npm run check`. To load the source directly in Pi, run `pi -e ./src/index.ts`. For directory installation, run `pi install "$PWD"` from the checkout, then use `/reload` or restart Pi.

On Linux with a shared virtiofs checkout, keep `node_modules` outside the checkout. Copy the current source to a fresh sandbox-local directory before installing dependencies:

```sh
sandbox="$(mktemp -d /tmp/pi-copy-picker-dev.XXXXXX)"
tar --exclude='./node_modules' --exclude='./.git' --exclude='*.tgz' -cf - . | tar -xf - -C "$sandbox"
cd "$sandbox"
npm ci
npm run check
```

Stop if dependency installation fails. Repeat the copy when source or metadata changes. `npm run check` runs type checking, functional tests, release tests, and a real tarball contract check. `npm pack` runs the same checks through `prepack`; the contract check uses `--ignore-scripts` to avoid recursion.

The package ships TypeScript source. Pi loads it with its TypeScript loader; the package contract check verifies command registration with that loader. IME positioning and actual clipboard reception still require a check in the target terminal. Clipboard tests may change the local clipboard.

## Implementation notes

`src/history.ts` converts branch history and finds selectable blocks. `src/picker.ts` handles selection, search, scrolling, rendering, and copy state. `src/index.ts` registers the commands and shortcut.

Each picker opening reads a `getBranch()` snapshot, including original text before compaction. Assistant text connected by tool-use steps forms one reply. Tool events remain in branch order when shown. Reopening loads newer messages.

The list displays Markdown source. The selected frame shows up to seven rows, subject to window size, and truncation does not change the preview or copied content. Search clears selection until the user selects a result. Display lines and previews are cached until width or theme changes; long histories can increase memory use until the picker closes.

The scanner recognizes fenced and indented code, blockquotes, and unambiguous standalone inline-code lines. It does not implement the full CommonMark container grammar. Tabs in list indentation and lazy container continuation have limitations; the whole-message copy retains the source when a child cannot be recognized.

Whole-message copy joins text blocks and retains surrounding whitespace. For grouped assistant records, it adds enough line breaks at each seam to form a paragraph separator. Code and quote copies remove trailing newlines while retaining internal whitespace. Quote copies remove one outer `>` and at most one following space or tab per line. Tool calls copy formatted argument JSON; tool results omit `details`.

Pi's clipboard helper may use a native clipboard or OSC 52. Pi 1.4.0 limits OSC 52 to 100000 Base64 characters. A successful helper call does not confirm terminal clipboard reception. Repeated copy requests are suppressed while a copy is pending.

For release steps, see [RELEASING.md](RELEASING.md).
