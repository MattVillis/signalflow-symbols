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

### Suggesting a category

In the app, **Suggest a category** at the bottom of the library sidebar names a
category (a new one, or one that exists) and the symbols that belong in it. That
opens a `[category] NAME` issue. A workflow (`category.yml`) checks it and
comments a table. Adding the **approved** label files those symbols under the
category in `library.json`'s `catalog`, which every app applies on its next sync,
built-in symbols included. Closing the issue rejects it.

A symbol submitted in a category nobody has used yet creates that category when
it's approved.

### Class and category

Every symbol has a **class**, the department it belongs to (video, audio,
lighting, network, control, power), and a **category**, the finer filing under
it. The app's library filter works by class. The app works a class out for itself:
set on the symbol, else the class its category is allotted to, else from its ports.

The maintainer's symbol desk can change either one for any symbol, built-ins
included, and allot a category to a class. It opens a `[catalog] ...` issue and
adds the **approved** label; `catalog.yml` writes the change into `library.json`'s
`catalog`, which every app applies on its next sync:

```
"catalog": {
  "cats": ["Amplifiers"],                                  extra categories
  "defs": { "<symbol id>": { "class": "audio", "category": "Amplifiers" } },
  "catClass": { "amplifiers": "audio" }                    a category's class
}
```

## Maintainer notes

- Review queue: [open submissions](../../issues?q=is%3Aissue+is%3Aopen+label%3Asymbol),
  [category suggestions](../../issues?q=is%3Aissue+is%3Aopen+label%3Acategory).
- `scripts/symbol.js` holds the validation/normalisation used by the workflows
  and by the maintainer bridge's direct publish, the category-suggestion
  functions (`parseCategory`, `validateCategory`, `applyCategory`) and the
  catalog-edit ones (`parseCatalogEdit`, `validateCatalogEdit`, `applyCatalogEdit`).
  Its `APP_CATEGORIES` is a copy of the app's `CATEGORIES` and `CLASSES` of the
  app's classes: keep them in step.
