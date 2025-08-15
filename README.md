# Release Cinema

> Make your releases **cinematic**. Zero‑dep Node CLI + GitHub Action that renders a short trailer (GIF/MP4) summarizing a tag’s highlights **and** a **CLI simulation** of the release run.

[![build](https://img.shields.io/github/actions/workflow/status/hunt3r157/release-cinema/ci.yml?branch=main&label=build)](https://github.com/hunt3r157/release-cinema/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/actions/workflow/status/hunt3r157/release-cinema/release.yml?label=release)](https://github.com/hunt3r157/release-cinema/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/release-cinema.svg)](https://www.npmjs.com/package/release-cinema)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What it does
- Analyzes a range (`--from … --to …`) and extracts:
  - **Top commits** (subject lines)
  - **Contributors** (by count)
  - **Files changed** & top directories
- Renders a **trailer** (PNG frames → GIF/MP4 via ImageMagick + ffmpeg)
- Generates an animated **terminal simulation** of the release run (tag → push → CI steps)

> System tools needed to render: **ImageMagick** and **ffmpeg**. The GitHub Action installs these automatically on ubuntu runners.

---

## Quick start (local)

```bash
# ensure you have imagemagick + ffmpeg installed
# macOS: brew install imagemagick ffmpeg
# ubuntu: sudo apt-get update && sudo apt-get install -y imagemagick ffmpeg fonts-dejavu-core

# render trailer for last tag to HEAD
npx release-cinema render --auto --out-dir assets

# also render the CLI simulation
npx release-cinema simulate --out assets/cli_sim.gif
```

## GitHub Action usage
Add this workflow to generate and attach artifacts to the Release when you push a tag:

```yaml
name: Release
on:
  push:
    tags: ["v*.*.*"]
jobs:
  cinema:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Install render tools
        run: sudo apt-get update && sudo apt-get install -y imagemagick ffmpeg fonts-dejavu-core
      - name: Render trailer & CLI sim
        run: |
          node bin/release-cinema.mjs render --auto --out-dir assets
          node bin/release-cinema.mjs simulate --out assets/cli_sim.gif
      - name: Attach to Release
        uses: softprops/action-gh-release@v1
        with:
          files: |
            assets/trailer.gif
            assets/trailer.mp4
            assets/cli_sim.gif
```

---

## CLI

```bash
# auto-detect previous tag range → HEAD
release-cinema render --auto --out-dir assets

# explicit range
release-cinema render --from v0.1.0 --to v0.1.1 --out-dir assets

# just the terminal simulation GIF
release-cinema simulate --out assets/cli_sim.gif

# analysis only (prints JSON)
release-cinema analyze --from v0.1.0 --to v0.1.1
```

**Exit codes**
- `0` success
- `2` runtime error (e.g., no git repo)

---

## Security
No network calls. Reads `git` metadata and shells out to ImageMagick/ffmpeg for rendering.

---

## License
MIT © Release Cinema contributors

---

## Roadmap
- [ ] Per-frame theme customization
- [ ] Optional SVG-only output
- [ ] “Typewriter” speed controls for simulation
- [ ] Attach artifacts with SHA‑pinned action
