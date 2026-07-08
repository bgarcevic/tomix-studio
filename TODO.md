# TODO

## Explorer
- [ ] Model-level Expressions root node: blocked on `tx` exposing expressions
      (no `--type expression` in `tx ls` today). When `tx` adds it, port the
      `expressions` container and leaf nodes following the relationships/cultures
      pattern in `src/explorer.ts`.
- [x] Explorer search: `tomix studio: Search Model` runs `tx find` over the
      active model and presents matches in a QuickPick (names + expressions +
      descriptions). Selecting a result opens the TMDL file at the object
      declaration via `resolveLocationByPath`.
