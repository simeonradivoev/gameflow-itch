# Gameflow itch.io Web Games

An external Gameflow source plugin for discovering and adding public itch.io HTML5 games. Curated titles come from the configured itch.io collection and launch inside Gameflow using itch.io's hosted web build.

The initial release is online-only. Installing a game adds it to the local Gameflow library; it does not copy the HTML5 build for offline use or grant access to paid/private uploads.

```bash
bun install
bun run test
bun run build
```

The default collection is <https://itch.io/c/8025379/gameflow-store>. It can be changed from the plugin settings page.
