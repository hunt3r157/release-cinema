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

function run(cmd, opts={}) {
  return cp.execSync(cmd, { stdio: ['ignore','pipe','pipe'], encoding: 'utf8', ...opts }).trim();
}

function ensureTools() {
  try { run('convert -version'); } catch { fail('ImageMagick (convert) not found. Install it.'); }
  try { run('ffmpeg -version'); } catch { fail('ffmpeg not found. Install it.'); }
}

function isGitRepo() {
  try { run('git rev-parse --is-inside-work-tree'); return true; } catch { return false; }
}

function resolveRange(flags) {
  if (flags.auto) {
    let to = 'HEAD';
    let from = '';
    try {
      const lastTag = run('git describe --tags --abbrev=0');
      from = lastTag;
    } catch {
      from = run('git rev-list --max-parents=0 HEAD').split('\n').at(0);
    }
    return { from, to };
  }
  if (!flags.from || !flags.to) fail('Provide --from and --to, or use --auto');
  return { from: flags.from, to: flags.to };
}

function analyze(from, to) {
  const fmt = '%h|%an|%ad|%s';
  const log = run(`git log --date=short --pretty=format:"${fmt}" ${from}..${to}`);
  const lines = log ? log.split('\n') : [];
  const commits = lines.filter(Boolean).map(l => {
    const [sha, author, date, subject] = l.split('|');
    return { sha, author, date, subject };
  });

  const filesChanged = run(`git diff --name-only ${from}..${to}`).split('\n').filter(Boolean);
  const topDirsMap = new Map();
  filesChanged.forEach(f => {
    const d = f.split('/')[0] || f;
    topDirsMap.set(d, (topDirsMap.get(d)||0)+1);
  });
  const topDirs = [...topDirsMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,count])=>({name,count}));

  const byAuthor = new Map();
  commits.forEach(c => byAuthor.set(c.author, (byAuthor.get(c.author)||0)+1));
  const contributors = [...byAuthor.entries()].sort((a,b)=>b[1]-a[1]).map(([author,count])=>({author,count}));

  return {
    range: { from, to },
    stats: { commits: commits.length, files: filesChanged.length, dirs: topDirs.length },
    topCommits: commits.slice(0, 5),
    contributors,
    topDirs
  };
}

// Safely build a caption image via ImageMagick
function writeTextImage(text, outPath, opts={}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const tf = path.join(tmp, 'text.txt');
  fs.writeFileSync(tf, text, 'utf8');
  const W = Number(opts.width ?? 1280);
  const H = Number(opts.height ?? 720);
  const pt = Number(opts.point ?? 28);
  const fg = String(opts.fg ?? '#e5e9f0');
  const bg = String(opts.bg ?? '#0b0f14');
  const font = String(opts.font ?? 'DejaVu-Sans-Mono');
  const q = s => '"' + String(s).replace(/(["\\$`])/g,'\\$1') + '"';
  const cmd = [
    'convert',
    `-size ${W}x${H}`,
    `-background ${q(bg)}`,
    `-fill ${q(fg)}`,
    `-font ${q(font)}`,
    `-pointsize ${pt}`,
    `caption:@${q(tf)}`,
    '-gravity', 'northwest',
    '-compose', 'over',
    '-geometry', '+40+40',
    '-composite',
    q(outPath)
  ].join(' ');
  run(cmd);
  fs.rmSync(tmp, { recursive: true, force: true });
}

function drawFrame(lines, frameNo, outDir){
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  const out = path.join(outDir, `frame_${String(frameNo).padStart(4,'0')}.png`);
  writeTextImage(text, out, {});
  return out;
}

function compile(outDir, outBase='trailer') {
  const gif = path.join(outDir, `${outBase}.gif`);
  const mp4 = path.join(outDir, `${outBase}.mp4`);
  run(`convert -delay 6 -loop 0 '${outDir}/frame_*.png' '${gif}'`);
  run(`ffmpeg -y -framerate 24 -pattern_type glob -i '${outDir}/frame_*.png' -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" -pix_fmt yuv420p '${mp4}'`);
  return { gif, mp4 };
}

function render(flags) {
  if (!isGitRepo()) fail('Not a git repository.');
  ensureTools();
  const outDir = flags['out-dir'] ? String(flags['out-dir']) : 'assets';
  fs.mkdirSync(outDir, { recursive: true });
  const { from, to } = resolveRange(flags);
  const a = analyze(from, to);

  let f = 0;
  drawFrame([
    'RELEASE CINEMA',
    '',
    `Range: ${a.range.from} → ${a.range.to}`,
    '',
    `Commits: ${a.stats.commits}    Files changed: ${a.stats.files}`
  ], ++f, outDir);

  const topc = a.topCommits.length ? a.topCommits.map(c=>`• ${c.sha} — ${c.subject} (${c.author})`) : ['• No recent commits'];
  drawFrame(['HIGHLIGHTS', '', ...topc.slice(0,5)], ++f, outDir);

  const contrib = a.contributors.slice(0,5).map(c=>`• ${c.author} — ${c.count} commit(s)`);
  drawFrame(['TOP CONTRIBUTORS', '', ...(contrib.length?contrib:['• —'])], ++f, outDir);

  const dirs = a.topDirs.map(d=>`• ${d.name} — ${d.count} file(s)`);
  drawFrame(['CHANGED AREAS', '', ...(dirs.length?dirs:['• —'])], ++f, outDir);

  drawFrame([
    'THANKS FOR SHIPPING 🚀',
    '',
    'Made with Release Cinema',
    new Date().toISOString()
  ], ++f, outDir);

  const { gif, mp4 } = compile(outDir, 'trailer');
  console.log(`✓ Wrote ${gif}`);
  console.log(`✓ Wrote ${mp4}`);
}

function simulate(flags) {
  ensureTools();
  const out = flags.out ? String(flags.out) : 'assets/cli_sim.gif';
  const osTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const outDir = osTmp;
  let f=0;

  function draw(text){ drawFrame([text], ++f, outDir); }
  function typeLine(prefix, text) {
    for (let i=1;i<=text.length;i+=2) draw(`${prefix}${text.slice(0,i)}_`);
    draw(`${prefix}${text}`);
  }
  function pause(lines, frames=8) {
    for (let i=0;i<frames;i++) drawFrame(lines, ++f, outDir);
  }

  typeLine('$ ', 'git tag -a vX.Y.Z -m "release: vX.Y.Z"');
  typeLine('$ ', 'git push origin vX.Y.Z');
  pause(['# GitHub Actions', '• build … running']);
  pause(['# GitHub Actions', '✔ build … passed']);
  pause(['# GitHub Actions', '• publish to npm … running']);
  pause(['# GitHub Actions', '✔ publish to npm … done']);
  pause(['# GitHub Actions', '• attach trailer … running']);
  pause(['# GitHub Actions', '✔ attach trailer … done']);

  run(`convert -delay 6 -loop 0 '${outDir}/frame_*.png' '${out}'`);
  console.log(`✓ Wrote ${out}`);
}

function usage() {
  console.log(`Release Cinema
Usage:
  release-cinema render --auto|--from <ref> --to <ref> [--out-dir assets]
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
    } else if (cmd === 'render') {
      render(flags);
    } else if (cmd === 'simulate') {
      simulate(flags);
    }
  } catch (e) {
    console.error(e.message || String(e));
    process.exit(2);
  }
})();
