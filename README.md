# Gameflow itch.io

An external Gameflow source plugin for discovering itch.io games, playing hosted HTML5 builds, and downloading compatible itch.io uploads through Butler.

## Downloading games

The plugin follows itch.io's supported launcher integration and runs `butlerd` as a single managed process. On first use it downloads the current Butler build from the official Broth channel for the host platform, validates the archive and executable, and stores it under:

```text
<gameflow-download-path>/.gameflow/itch/
```

Butler's database is kept in the same stable state directory. Installed games are placed under `<gameflow-download-path>/roms/itch/`. The plugin asks Butler for uploads compatible with the current OS and architecture, reports install progress to Gameflow, supports cancellation, and records Butler's final cave folder as the local game path.

Supported runtime targets are Windows, Linux, and macOS on x64 or ARM64.

Hosted public HTML5 games can be played without signing in. Butler requires an itch.io profile before it can list downloadable uploads, including free uploads. Open the itch.io plugin settings in Gameflow, create an API key using the provided help action, paste it into **Connect**, and submit it.

The API key is a transient password field: Gameflow validates it and sends it directly to the local Butler daemon for that request. Neither Gameflow nor this plugin stores or logs the key. Butler stores the resulting login session in its private database so future downloads do not require the key. The settings page then shows the connected itch.io account.

Use **Disconnect** to delete all itch.io profiles saved in that private Butler database. You can also revoke the original API key at <https://itch.io/user/settings/api-keys>.

## Development

```bash
bun install
bun run test
bun run build
```

The default curated collection is <https://itch.io/c/8025379/gameflow-store>. It can be changed from the plugin settings page. Hosted HTML5 games continue to launch inside Gameflow; downloaded games fall through to Gameflow's local launch-command discovery.
Mixed-platform uploads (for example, one archive containing both Windows and Linux builds) are labeled for the host OS when supported. Native itch launch targets are checked before UMU, including for existing installations previously labeled Windows. On Linux, Windows targets are excluded from native selection; if no native target is available, Gameflow can fall back to UMU. This does not require redownloading an existing mixed-platform installation.
