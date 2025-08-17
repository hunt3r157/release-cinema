#!/usr/bin/env node
// Release Cinema — render release trailers + CLI simulation (Node >= 18)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -------- flags --------
const argv = process.argv.slice(2);
function parseFlags(argv){
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;

    // --key=value (repeatable becomes array)
    const eq = a.indexOf('=');
    if (eq > 2) {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      if (out[k] === undefined) out[k] = v;
      else out[k] = Array.isArray(out[k]) ? out[k].concat(v) : [out[k], v];
      continue;
    }

    // --key value  OR  --flag
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[k] = next; i++; }
    else { out[k] = true; }
  }
  return out;
}
const cmd = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'render';
const flags = parseFlags(argv);

// -------- theme (Option A: JSON + --set) --------
const DEFAULT_THEME = {
  bg: '#0b0f14',
  fg: '#e5e9f0',
  accent: '#7aa2f7',
  mono: 'DejaVu-Sans-Mono',
  sans: 'DejaVu-Sans',
  width: 1280,
  height: 720,
  card: { radius: 36, glass: 'rgba(255,255,255,0.06)', stroke: '#7aa2f744' },
  spacing: { margin: 64, padTop: 42, gapTitleBody: 40, padBottom: 48 },
  typography: { titlePt: 64, bodyPt: 34 }
};
function coerceArray(v){ return v===undefined ? [] : Array.isArray(v) ? v : [v]; }
function setPath(obj, pathStr, val){
  const parts = String(pathStr).split('.');
  let o = obj;
  for (let i=0;i<parts.length-1;i++){
    const k = parts[i]; if (typeof o[k] !== 'object' || o[k] === null) o[k] = {};
    o = o[k];
  }
  o[parts[parts.length-1]] = val;
}
function tryJson(v){ try { return JSON.parse(v); } catch { return v; } }
function readTheme(flags){
  // start with defaults
  let theme = JSON.parse(JSON.stringify(DEFAULT_THEME));

  // optional theme file or name
  if (flags.theme) {
    let t = String(flags.theme);
    let themePath = t;
    if (!fs.existsSync(themePath)) {
      const candidate = path.join(__dirname,'../themes', t.endsWith('.json')? t : (t + '.json'));
      if (fs.existsSync(candidate)) themePath = candidate;
    }
    if (fs.existsSync(themePath)) {
      const override = JSON.parse(fs.readFileSync(themePath,'utf8'));
      theme = { ...theme, ...override };
      if (override.card)      theme.card      = { ...theme.card,      ...override.card };
      if (override.spacing)   theme.spacing   = { ...theme.spacing,   ...override.spacing };
      if (override.typography)theme.typography= { ...theme.typography,...override.typography };
    }
  }

  // --set key=val (repeatable)
  for (const kv of coerceArray(flags.set)) {
    const [k, raw=''] = String(kv).split('=');
    setPath(theme, k, tryJson(raw));
  }
  return theme;
}
const theme = readTheme(flags);

// -------- utils --------
function run(cmd) {
  return cp.execSync(cmd, { stdio: ['ignore','pipe','pipe'], encoding: 'utf8' }).trim();
}
function ensureTools() {
  try { run('convert -version'); } catch { fail('ImageMagick (convert) not found. Install it.'); }
  try { run('ffmpeg -version'); } catch { fail('ffmpeg not found. Install it.'); }
}
function isGitRepo() { try { run('git rev-parse --is-inside-work-tree'); return true; } catch { return false; } }
function q(s){ return '"' + String(s).replace(/(["\\$`])/g,'\\$1') + '"'; }
function fail(msg){ console.error('✖ ' + msg); process.exit(2); }

// -------- git analyze --------
function resolveRange(flags) {
  if (flags.auto) {
    let to = 'HEAD', from = '';
    try { from = run('git describe --tags --abbrev=0'); }
    catch { from = run('git rev-list --max-parents=0 HEAD').split('\n').at(0); }
    return { from, to };
  }
  if (!flags.from || !flags.to) fail('Provide --from and --to, or use --auto');
  return { from: flags.from, to: flags.to };
}
function analyze(from, to) {
  const fmt = '%h|%an|%ad|%s';
  const log = run(`git log --date=short --pretty=format:"${fmt}" ${from}..${to}`);
  const lines = log ? log.split('\n') : [];
  const commits = lines.filter(Boolean).map(l => { const [sha, author, date, subject] = l.split('|'); return { sha, author, date, subject }; });
  const filesChanged = run(`git diff --name-only ${from}..${to}`).split('\n').filter(Boolean);
  const topDirsMap = new Map(); filesChanged.forEach(f => { const d = f.split('/')[0] || f; topDirsMap.set(d, (topDirsMap.get(d)||0)+1); });
  const topDirs = [...topDirsMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,count])=>({name,count}));
  const byAuthor = new Map(); commits.forEach(c => byAuthor.set(c.author, (byAuthor.get(c.author)||0)+1));
  const contributors = [...byAuthor.entries()].sort((a,b)=>b[1]-a[1]).map(([author,count])=>({author,count}));
  return { range: { from, to }, stats: { commits: commits.length, files: filesChanged.length, dirs: topDirs.length }, topCommits: commits.slice(0,5), contributors, topDirs };
}

// -------- render: centered card with auto-fit --------
function writeCardFrame(title, bodyLines, outPath, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));

  const W = Number(opts.width  ?? (theme.width  ?? 1280));
  const H = Number(opts.height ?? (theme.height ?? 720));

  const margin       = Number(theme.spacing?.margin       ?? 64);
  const padTop       = Number(theme.spacing?.padTop       ?? 42);
  const gapTitleBody = Number(theme.spacing?.gapTitleBody ?? 40);
  const padBottom    = Number(theme.spacing?.padBottom    ?? 48);

  const maxCardH = H - margin * 2;
  const cardW = Math.round(W * 0.78);
  const bodyW = cardW - 140;

  let titlePt = Number(opts.titlePt ?? theme.typography?.titlePt ?? 64);
  let bodyPt  = Number(opts.bodyPt  ?? theme.typography?.bodyPt  ?? 34);

  const cardRadius = Number(theme.card?.radius ?? 36);
  const cardGlass  = String(theme.card?.glass ?? 'rgba(255,255,255,0.06)');
  const cardStroke = String(theme.card?.stroke ?? '#7aa2f744');

  const titleText = String(title);
  const bodyText  = Array.isArray(bodyLines) ? bodyLines.join('\n') : String(bodyLines);

  function renderTextAndMeasure(ptTitle, ptBody) {
    const titlePng = path.join(tmp, 'title.png');
    const bodyPng  = path.join(tmp, 'body.png');

    run(['convert','-background','none','-fill',q(theme.accent),'-font',q(theme.sans),
         '-pointsize', String(ptTitle), '-size', `${bodyW}x`, q('caption:' + titleText), q(titlePng)].join(' '));
    run(['convert','-background','none','-fill',q(theme.fg),'-font',q(theme.sans),
         '-pointsize', String(ptBody), '-size', `${bodyW}x`, q('caption:' + bodyText), q(bodyPng)].join(' '));

    const titleH = Number(run(`identify -format "%h" ${q(titlePng)}`));
    const bodyH  = Number(run(`identify -format "%h" ${q(bodyPng)}`));
    return { titlePng, bodyPng, titleH, bodyH };
  }

  let { titlePng, bodyPng, titleH, bodyH } = renderTextAndMeasure(titlePt, bodyPt);
  const need = () => padTop + titleH + gapTitleBody + bodyH + padBottom;
  let cardH = Math.min(maxCardH, Math.max(Math.round(H * 0.40), need()));
  let attempts = 0;

  while (need() > maxCardH && attempts < 12) {
    bodyPt  = Math.max(20, bodyPt  - 2);
    titlePt = Math.max(36, Math.round(titlePt * 0.96));
    ({ titlePng, bodyPng, titleH, bodyH } = renderTextAndMeasure(titlePt, bodyPt));
    cardH = Math.min(maxCardH, Math.max(Math.round(H * 0.40), need()));
    attempts++;
  }

  const base = path.join(tmp, 'base.png');
  run(['convert','-size',`${W}x${H}`,`xc:${theme.bg}`, q(base)].join(' '));

  const card = path.join(tmp, 'card.png');
  const draw1 = `roundrectangle 0,0 ${cardW-1},${cardH-1} ${cardRadius},${cardRadius}`;
  const draw2 = `roundrectangle 1,1 ${cardW-2},${cardH-2} ${cardRadius},${cardRadius}`;
  run(['convert','-size',`${cardW}x${cardH}`,'xc:none','-fill',q(cardGlass),
       '-draw',q(draw1),'-stroke',q(cardStroke),'-strokewidth','2','-draw',q(draw2), q(card)].join(' '));

  const cardTop = Math.floor((H - cardH) / 2);
  const titleY  = cardTop + padTop;
  const bodyY   = titleY + titleH + gapTitleBody;

  const s1 = path.join(tmp, 's1.png');
  run(['convert', q(base), q(card), '-gravity','center','-composite', q(s1)].join(' '));
  const s2 = path.join(tmp, 's2.png');
  run(['convert', q(s1), q(titlePng), '-gravity','north','-geometry',`+0+${titleY}`, '-composite', q(s2)].join(' '));
  run(['convert', q(s2), q(bodyPng),  '-gravity','north','-geometry',`+0+${bodyY}`,  '-composite', q(outPath)].join(' '));

  fs.rmSync(tmp, { recursive: true, force: true });
}
function drawCard(title, bodyLines, frameNo, outDir){
  const out = path.join(outDir, `frame_${String(frameNo).padStart(4,'0')}.png`);
  writeCardFrame(title, bodyLines, out, {});
  return out;
}

// -------- CLI sim (monospace) --------
function writeTTYImage(text, outPath, opts={}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const W = Number(opts.width ?? (theme.width ?? 1280));
  const H = Number(opts.height ?? (theme.height ?? 720));
  const body = String(text);

  const base = path.join(tmp, 'base.png');
  run(['convert','-size',`${W}x${H}`,`xc:${theme.bg}`, q(base)].join(' '));

  const cap = path.join(tmp, 'cap.png');
  run(['convert','-background','none','-fill',q(theme.fg),'-font',q(theme.mono),
       '-pointsize','28', q('caption:' + body), q(cap)].join(' '));

  run(['convert', q(base), q(cap), '-gravity','northwest','-geometry','+40+40','-composite', q(outPath)].join(' '));
  fs.rmSync(tmp, { recursive: true, force: true });
}
function drawTTY(lines, frameNo, outDir){
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  const out = path.join(outDir, `frame_${String(frameNo).padStart(4,'0')}.png`);
  writeTTYImage(text, out, {});
  return out;
}

// -------- compile GIF/MP4 --------
function compile(outDir, outBase='trailer', slideSeconds=3, fpsOut=30) {
  const gif = path.join(outDir, `${outBase}.gif`);
  const mp4 = path.join(outDir, `${outBase}.mp4`);

  const gifDelay = Math.max(1, Math.round(slideSeconds * 100)); // centiseconds
  run(`convert -delay ${gifDelay} -loop 0 '${outDir}/frame_*.png' '${gif}'`);

  const inRate = Number.isInteger(slideSeconds) ? `1/${slideSeconds}` : (1/slideSeconds).toFixed(6);
  run(`ffmpeg -y -framerate ${inRate} -pattern_type glob -i '${outDir}/frame_*.png' -vf "fps=${fpsOut},pad=ceil(iw/2)*2:ceil(ih/2)*2" -r ${fpsOut} -pix_fmt yuv420p '${mp4}'`);

  return { gif, mp4 };
}

// -------- commands --------
function render(flags) {
  if (!isGitRepo()) fail('Not a git repository.');
  ensureTools();
  const outDir = flags['out-dir'] ? String(flags['out-dir']) : 'assets';
  fs.mkdirSync(outDir, { recursive: true });
  const { from, to } = resolveRange(flags);
  const a = analyze(from, to);

  let f = 0;
  drawCard('RELEASE CINEMA',
           [`Range: ${a.range.from} → ${a.range.to}`,'',`Commits: ${a.stats.commits}    Files changed: ${a.stats.files}`],
           ++f, outDir);

  const topc = a.topCommits.length ? a.topCommits.map(c=>`• ${c.sha} — ${c.subject} (${c.author})`) : ['• No recent commits'];
  drawCard('HIGHLIGHTS', topc.slice(0,5), ++f, outDir);

  const contrib = a.contributors.slice(0,5).map(c=>`• ${c.author} — ${c.count} commit(s)`);
  drawCard('TOP CONTRIBUTORS', (contrib.length?contrib:['• —']), ++f, outDir);

  const dirs = a.topDirs.map(d=>`• ${d.name} — ${d.count} file(s)`);
  drawCard('CHANGED AREAS', (dirs.length?dirs:['• —']), ++f, outDir);

  drawCard('THANKS FOR SHIPPING 🚀', ['Made with Release Cinema', new Date().toISOString()], ++f, outDir);

  const slideSeconds = Math.max(1, Number(flags['slide-seconds'] ?? 3));
  const fpsOut = Math.max(1, Number(flags['fps'] ?? 30));
  const { gif, mp4 } = compile(outDir, 'trailer', slideSeconds, fpsOut);
  console.log(`✓ Wrote ${gif}`);
  console.log(`✓ Wrote ${mp4}`);
}
function simulate(flags) {
  ensureTools();
  const out = flags.out ? String(flags.out) : 'assets/cli_sim.gif';
  const osTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const outDir = osTmp;
  let f=0;

  function draw(text){ drawTTY([text], ++f, outDir); }
  function typeLine(prefix, text) { for (let i=1;i<=text.length;i+=2) draw(`${prefix}${text.slice(0,i)}_`); draw(`${prefix}${text}`); }
  function pause(lines, frames=8) { for (let i=0;i<frames;i++) drawTTY(lines, ++f, outDir); }

  typeLine('$ ', 'git tag -a vX.Y.Z -m "release: vX.Y.Z"');
  typeLine('$ ', 'git push origin vX.Y.Z');
  pause(['# GitHub Actions', '• build … running']);
  pause(['# GitHub Actions', '✔ build … passed']);
  pause(['# GitHub Actions', '• publish to npm … running']);
  pause(['# GitHub Actions', '✔ publish to npm … done']);
  pause(['# GitHub Actions', '• attach trailer … running']);
  pause(['# GitHub Actions', '✔ attach trailer … done']);

  run(`convert -delay 12 -loop 0 '${outDir}/frame_*.png' '${out}'`);
  console.log(`✓ Wrote ${out}`);
}
function usage() {
  console.log(`Release Cinema
Usage:
  release-cinema render --auto|--from <ref> --to <ref> [--out-dir assets] [--slide-seconds 3] [--fps 30] [--theme default|path] [--set key=val ...]
  release-cinema analyze --from <ref> --to <ref>
  release-cinema simulate [--out assets/cli_sim.gif]
`);
}

// -------- main --------
(async () => {
  try {
    if (cmd === 'analyze') {
      if (!isGitRepo()) fail('Not a git repository.');
      const { from, to } = resolveRange(flags);
      console.log(JSON.stringify(analyze(from, to), null, 2));
    } else if (cmd === 'render') { render(flags); }
    else if (cmd === 'simulate') { simulate(flags); }
    else { usage(); process.exit(1); }
  } catch (e) { console.error(e.message || String(e)); process.exit(2); }
})();
