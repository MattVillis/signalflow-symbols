# SignalFlow shared symbol library

The app lives at **https://mattvillis.github.io/signalflow/** (repo:
[MattVillis/signalflow](https://github.com/MattVillis/signalflow)). This repo is
its shared symbol library.

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
- `scripts/symbol.js` holds the validation/normalisation used by the workflows
  and by the maintainer bridge's direct publish.
