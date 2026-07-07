# TODO

## Explorer
- [ ] Model-level Expressions root node: blocked on `tx` exposing expressions
      (no `--type expression` in `tx ls` today). When `tx` adds it, port the
      `expressions` container and leaf nodes following the relationships/cultures
      pattern in `src/explorer.ts`.
- [ ] Explorer search webview pane (was `ExplorerSearchViewProvider` in the old
      extension). Deferred until the tree is stable.
