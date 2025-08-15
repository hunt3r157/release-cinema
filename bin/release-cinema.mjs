#!/usr/bin/env node
// Release Cinema — render release trailers + CLI simulation (Node >= 18)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
function parseFlags(arr){
  const o={};
  for (let i=0;i<arr.length;i++){
    const a=arr[i];
    if (!a.startsWith('--')) continue;
    const nxt = arr[i+1];
    if (nxt && !nxt.startsWith('--')) { o[a.slice(2)] = nxt; i++; }
    else { const [k,v] = a.slice(2).split('='); o[k] = v ?? true; }
  }
  return o;
}
const cmd = (args[0] && !args[0].startsWith('--')) ? args[0] : 'render';
const flags = parseFlags(args);

if (!['render','analyze','simulate'].includes(cmd)) { usage(); process.exit(1); }

const theme = {
  bg: '#0b0f14',
  fg: '#e5e9f0',
  accent: '#7aa2f7',
  mono: 'DejaVu-Sans-Mono',
  sans: 'DejaVu-Sans',
  width: 1280,
  height: 720,
};

function run(cmd, opts={}) {
  return cp.execSync(cmd, { stdio: ['ignore','pipe','pipe'], encoding: 'utf8', ...opts }).trim();
}
function ensureTools() {
  try { run('convert -version'); } catch { fail('ImageMagick (convert) not found. Install it.'); }
  try { run('ffmpeg -version'); } catch { fail('ffmpeg not found. Install it.'); }
}
function isGitRepo() { try { run('git rev-parse --is-inside-work-tree'); return true; } catch { return false; } }
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
function q(s){ return '"' + String(s).replace(/(["\\$`])/g,'\\$1') + '"'; }

// ---------- Trailer: centered “card” frame ----------
function writeCardFrame(title, bodyLines, outPath, opts={}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));

  const W = Number(opts.width ?? theme.width);
  const H = Number(opts.height ?? theme.height);
  const cardW = Math.round(W*0.78);
  const cardH = Math.round(H*0.56);
  const bodyW = cardW - 140;
  const titlePt = Number(opts.titlePt ?? 64);
  const bodyPt  = Number(opts.bodyPt  ?? 34);

  const cardTop = Math.floor((H - cardH)/2);
  const titleY  = cardTop + 42;
  const bodyY   = cardTop + 120;

  const titleText = String(title);
  const bodyText  = Array.isArray(bodyLines) ? bodyLines.join("\\n") : String(bodyLines);

  // base
  const base = path.join(tmp,'base.png');
  run(['convert','-size',`${W}x${H}`,`xc:${theme.bg}`,q(base)].join(' '));

  // card with subtle border
  const card = path.join(tmp,'card.png');
  const draw1 = `roundrectangle 0,0 ${cardW-1},${cardH-1} 36,36`;
  const draw2 = `roundrectangle 1,1 ${cardW-2},${cardH-2} 36,36`;
  run(['convert','-size',`${cardW}x${cardH}`,'xc:none','-fill',q('rgba(255,255,255,0.06)'),
       '-draw',q(draw1),'-stroke',q('#7aa2f744'),'-strokewidth','2','-draw',q(draw2),q(card)].join(' '));

  // title (inline caption)
  const titlePng = path.join(tmp,'title.png');
  run(['convert','-background','none','-fill',q(theme.accent),'-font',q(theme.sans),
       '-pointsize',String(titlePt),'-size',`${bodyW}x`, q('caption:' + titleText), q(titlePng)].join(' '));

  // body (inline caption)
  const bodyPng = path.join(tmp,'body.png');
  run(['convert','-background','none','-fill',q(theme.fg),'-font',q(theme.sans),
       '-pointsize',String(bodyPt),'-size',`${bodyW}x`, q('caption:' + bodyText), q(bodyPng)].join(' '));

  // compose: base + card(center) + title + body
  const s1 = path.join(tmp,'s1.png');
  run(['convert', q(base), q(card), '-gravity','center','-composite', q(s1)].join(' '));
  const s2 = path.join(tmp,'s2.png');
  run(['convert', q(s1), q(titlePng), '-gravity','north','-geometry',`+0+${titleY}`, '-composite', q(s2)].join(' '));
  run(['convert', q(s2), q(bodyPng),  '-gravity','north','-geometry',`+0+${bodyY}`,  '-composite', q(outPath)].join(' '));

  fs.rmSync(tmp, { recursive: true, force: true });
}
function drawCard(title, bodyLines, frameNo, outDir){
  const out = path.join(outDir, `frame_${String(frameNo).padStart(4,'0')}.png`);
  writeCardFrame(title, bodyLines, out, {});
  return out;
}

// ---------- CLI sim: monospace, top-left ----------
function writeTTYImage(text, outPath, opts={}) {
  const W = Number(opts.width ?? theme.width);
  const H = Number(opts.height ?? theme.height);
  const body = String(text);
  run(['convert','-size',`${W}x${H}`,`xc:${theme.bg}`,
       '-fill',q(theme.fg),'-font',q(theme.mono),'-pointsize','28',
       q('caption:' + body),'-gravity','northwest','-geometry','+40+40','-composite', q(outPath)].join(' '));
}
function drawTTY(lines, frameNo, outDir){
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  const out = path.join(outDir, `frame_${String(frameNo).padStart(4,'0')}.png`);
  writeTTYImage(text, out, {});
  return out;
}

// ---------- Compile (3s per slide by default) ----------
function compile(outDir, outBase='trailer', slideSeconds=3, fpsOut=30) {
  const gif = path.join(outDir, `${outBase}.gif`);
  const mp4 = path.join(outDir, `${outBase}.mp4`);

  const gifDelay = Math.max(1, Math.round(slideSeconds * 100)); // centiseconds
  run(`convert -delay ${gifDelay} -loop 0 '${outDir}/frame_*.png' '${gif}'`);

  const inRate = Number.isInteger(slideSeconds) ? `1/${slideSeconds}` : (1/slideSeconds).toFixed(6);
  run(`ffmpeg -y -framerate ${inRate} -pattern_type glob -i '${outDir}/frame_*.png' -vf "fps=${fpsOut},pad=ceil(iw/2)*2:ceil(ih/2)*2" -r ${fpsOut} -pix_fmt yuv420p '${mp4}'`);

  return { gif, mp4 };
}

// ---------- Commands ----------
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
  release-cinema render --auto|--from <ref> --to <ref> [--out-dir assets] [--slide-seconds 3] [--fps 30]
  release-cinema analyze --from <ref> --to <ref>
  release-cinema simulate [--out assets/cli_sim.gif]
`);
}
function fail(msg){ console.error('✖ ' + msg); process.exit(2); }

(async () => {
  try {
    if (cmd === 'analyze') {
      if (!isGitRepo()) fail('Not a git repository.');
      const { from, to } = resolveRange(flags);
      console.log(JSON.stringify(analyze(from, to), null, 2));
    } else if (cmd === 'render') { render(flags); }
    else if (cmd === 'simulate') { simulate(flags); }
  } catch (e) { console.error(e.message || String(e)); process.exit(2); }
})();
