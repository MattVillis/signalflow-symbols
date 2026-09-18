# SignalFlow

AV signal-flow schematic editor for live event production.

## Open the app

**https://mattvillis.github.io/signalflow-symbols/** — nothing to install.

Works in any modern browser. Your custom symbols are kept in that browser
(localStorage) and the shared library below is synced in automatically.
Projects save as `.signalflow.json` files via the **Save** button.

## Optional: AI symbol research

The **AI symbol builder** can research a device's rear panel from the web and
build the symbol for you. It runs through a small local bridge on your machine
using your own Claude Code login, so nothing is metered to a shared key.

1. Install [Node.js](https://nodejs.org) (LTS).
2. Install Claude Code and sign in:
   `npm install -g @anthropic-ai/claude-code` then `claude login`.
3. Download **SignalFlow-bridge.zip** from the
   [latest release](../../releases/latest), unzip it anywhere, and double-click
   **SignalFlow.bat** (Windows) or **signalflow.command** (macOS).

That starts the bridge (a minimised window) and opens the app. The AI
builder's engine switches to **bridge** on its own when it sees one running.
Run `node sf-bridge.mjs test` in the unzipped folder if it doesn't.

Without the bridge you can still use the AI builder with your own Anthropic
API key (engine: **Claude API**) or paste JSON from any agent (engine: **Agent prompt**).

## Shared symbol library

`library.json` in this repo is the global symbol library every copy of the app
syncs from (on launch and every 30 minutes). Symbols in it are generic device
definitions — name, category, width and ports — with no show-specific VLAN or IP data.

### Submitting a symbol

In the app, hover a custom symbol in the library sidebar and click **⇡**.
That opens a pre-filled issue here; just press **Submit new issue**.
(You need a GitHub account; nothing else.)

A workflow validates the JSON and comments a port table. The maintainer then
either adds the **approved** label — which merges the symbol into `library.json`
and closes the issue — or closes the issue to reject it.

Resubmitting a symbol with the same `id` updates the existing entry (its `rev`
is bumped, so synced apps replace their copy unless the symbol is placed on a sheet).

## Maintainer notes

- Review queue: [open submissions](../../issues?q=is%3Aissue+is%3Aopen+label%3Asymbol).
- `index.html` and `bridge/` are deployed by `node build.mjs --deploy` from the
  private source project; don't edit them here.
- `scripts/symbol.js` holds the validation/normalisation used by the workflows
  and by the maintainer bridge's direct publish.
