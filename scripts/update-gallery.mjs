#!/usr/bin/env node
// Updates README.md with a Gallery section showing latest trailer/CLI sim.
// No deps; uses your own CLI for analyze/render when run in CI.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';

function run(cmd) {
  return cp.execSync(cmd, { stdio: ['ignore','pipe','pipe'], encoding: 'utf8' }).trim();
}
function fileExists(p){ try { return fs.existsSync(p); } catch { return false; } }

function analyzeAuto() {
  try {
    const json = run('node bin/release-cinema.mjs analyze --auto');
    return JSON.parse(json);
  } catch {
    // Fallback if analyze fails (e.g., not a git repo in dev shell)
    return { range: { from: 'HEAD~', to: 'HEAD' } };
  }
}

function makeGalleryMD(info) {
  const from = info?.range?.from ?? '?';
  const to   = info?.range?.to   ?? '?';
  const trailerGif = 'assets/trailer.gif';
  const trailerMp4 = 'assets/trailer.mp4';
  const cliGif     = 'assets/cli_sim.gif';

  const hasTrailerGif = fileExists(trailerGif);
  const hasTrailerMp4 = fileExists(trailerMp4);
  const hasCliGif     = fileExists(cliGif);

  // Build tiles
  const trailerTile = hasTrailerGif
    ? (hasTrailerMp4
        ? `[![Trailer](${trailerGif})](${trailerMp4})`
        : `![Trailer](${trailerGif})`)
    : '_(no trailer yet)_';

  const cliTile = hasCliGif
    ? `![CLI Simulation](${cliGif})`
    : '_(no CLI simulation yet)_';

  // Two-column table if both exist; otherwise, single
  const body = (hasTrailerGif || hasCliGif)
    ? `| Latest Trailer | CLI Simulation |
| --- | --- |
| ${trailerTile} | ${cliTile} |`
    : `_(no gallery assets yet)_`;

  const updated = new Date().toISOString().slice(0,10);

  return `<!-- GALLERY:START -->
## Gallery

${body}

_Last updated: ${updated} • Range: \`${from}\` → \`${to}\`_
<!-- GALLERY:END -->`;
}

function upsertSection(readmeText, newBlock) {
  const start = '<!-- GALLERY:START -->';
  const end   = '<!-- GALLERY:END -->';

  const i = readmeText.indexOf(start);
  const j = readmeText.indexOf(end);
  if (i !== -1 && j !== -1 && j > i) {
    // Replace existing block
    return readmeText.slice(0, i) + newBlock + readmeText.slice(j + end.length);
  }
  // Append to end (with spacing)
  const sep = readmeText.endsWith('\n') ? '' : '\n';
  return readmeText + sep + '\n\n' + newBlock + '\n';
}

(function main(){
  const readmePath = path.resolve('README.md');
  if (!fileExists(readmePath)) {
    console.error('README.md not found at repo root');
    process.exit(2);
  }
  const info = analyzeAuto();
  const block = makeGalleryMD(info);
  const old = fs.readFileSync(readmePath, 'utf8');
  const next = upsertSection(old, block);
  if (next !== old) {
    fs.writeFileSync(readmePath, next);
    console.log('README gallery updated.');
    process.exit(0);
  } else {
    console.log('No README changes (gallery up-to-date).');
    process.exit(0);
  }
})();
