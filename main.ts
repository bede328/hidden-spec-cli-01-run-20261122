// main.ts is mend, the CLI SPEC.md specifies. It implements all ten sections of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, three-tier line matching (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Moves a successful edit performed, in order, for the `R` output lines (section 2). */
let moves: { old: string; new: string }[] = [];

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Files as lines (section 3) and matching (section 5)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** All 0-based positions where O occurs in `file` at `tier`, starting at or after `from`. */
function occurrences(O: string[], file: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(0, from); i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, file[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, or 0-2 unless strict) at which O occurs at least once, with its positions. */
function firstTier(O: string[], file: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(O, file, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line, the rest as written (or re-indented). */
interface NLine {
  text: string;
  ctx: boolean;
  /** Index into O for a context line, else null. */
  oIndex: number | null;
}

/**
 * Build the lines that replace O's match at `at`: context lines come from the file, other lines are
 * re-indented at tier 2 (section 5): P, the leading whitespace of O's first line, replaced by F, the
 * leading whitespace of the file's first matched line.
 */
function buildReplacement(O: string[], N: NLine[], file: string[], at: number, tier: number): string[] {
  const F = leadingWs(file[at] ?? '');
  const P = leadingWs(O[0] ?? '');
  return N.map((n) => {
    if (n.ctx) return file[at + (n.oIndex ?? 0)]!;
    if (tier !== 2) return n.text;
    if (n.text === '' || n.text.trim() === '') return n.text;
    if (!n.text.startsWith(P)) return n.text;
    return F + n.text.slice(P.length);
  });
}

/** Replace O's match at `at` by N in `lines`, returning the new lines. */
function replaceAt(lines: string[], at: number, O: string[], N: NLine[], tier: number): string[] {
  const rep = buildReplacement(O, N, lines, at, tier);
  return [...lines.slice(0, at), ...rep, ...lines.slice(at + O.length)];
}

/** Insert N's lines at `pos`; a bare insert has no context lines, so they are written as they are. */
function insertAt(lines: string[], pos: number, N: NLine[]): string[] {
  const rep = N.map((n) => n.text);
  return [...lines.slice(0, pos), ...rep, ...lines.slice(pos)];
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** The patch line as written; a bare empty line ends a body. */
  raw: string;
  /** A `\` line followed this body line. */
  bsAfter: boolean;
}

interface Hunk {
  /** A, the old start (1-based) from the `@@ -A[,B] +C[,D] @@` header. */
  a: number;
  body: BodyLine[];
}

interface UnifiedSection {
  oldPair: string | null;
  newPair: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, spaces removed. */
function unifiedPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnifiedSections(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    let sec: UnifiedSection;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPair: null, newPair: null, renameFrom: null, renameTo: null, diffOld: m[1]!, diffNew: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      i++;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPair: null, newPair: null, renameFrom: null, renameTo: null, diffOld: null, diffNew: null, isCreate: false, isDelete: false, hunks: [] };
    } else {
      i++;
      continue;
    }
    let havePair = false;
    let seenHunk = false;
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('@@')) {
        const hm = HUNK_HEAD.exec(h);
        if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
        const a = Number(hm[1]);
        i++;
        const body: BodyLine[] = [];
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
            if (b[0] === '\\') {
              if (body.length > 0) body[body.length - 1]!.bsAfter = true;
              i++;
              continue;
            }
            const kind = b === '' || b[0] === ' ' ? 'ctx' : b[0] === '-' ? 'old' : 'new';
            body.push({ kind, text: b === '' ? '' : b.slice(1), raw: b, bsAfter: false });
            i++;
            continue;
          }
          break;
        }
        while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
        sec.hunks.push({ a, body });
        seenHunk = true;
        continue;
      }
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (havePair || seenHunk) break;
          sec.oldPair = unifiedPath(h.slice(4));
          sec.newPair = unifiedPath(lines[i + 1]!.slice(4));
          havePair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (h.startsWith('rename from ')) {
        sec.renameFrom = h.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (h.startsWith('rename to ')) {
        sec.renameTo = h.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (h.startsWith('new file mode')) {
        sec.isCreate = true;
        i++;
        continue;
      }
      if (h.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i++;
        continue;
      }
      i++;
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** O is the hunk's context and `-` lines, N its context and `+` lines, each in body order. */
function hunkON(h: Hunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ text: b.text, ctx: true, oIndex: O.length - 1 });
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else {
      N.push({ text: b.text, ctx: false, oIndex: null });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') return b.bsAfter;
  }
  return false;
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  const oldPath = sec.oldPair ?? sec.renameFrom ?? sec.diffOld;
  const newPath = sec.newPair ?? sec.renameTo ?? sec.diffNew;
  const isCreate = sec.isCreate || oldPath === null;
  const isDelete = !isCreate && (sec.isDelete || newPath === null);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  if (oldPath === null && newPath === null) return () => {};
  if (isCreate && newPath === null) return () => {};
  if (isDelete && oldPath === null) return () => {};
  if (isCreate) {
    const target = newPath!;
    const plus: { text: string; bsAfter: boolean }[] = [];
    for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') plus.push({ text: b.text, bsAfter: b.bsAfter });
    const noEol = plus.length > 0 && plus[plus.length - 1]!.bsAfter;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const content = plus.length === 0 ? '' : plus.map((p) => p.text).join('\n') + (noEol ? '' : '\n');
      tree.now.set(target, content);
    };
  }
  if (isDelete) {
    const target = oldPath!;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  const from = oldPath!;
  const to = isMove ? newPath! : oldPath!;
  return (tree) => {
    if (!safe(from)) throw new Fail('unsafe', from);
    if (isMove && !safe(to)) throw new Fail('unsafe', to);
    const cur = tree.get(from);
    if (cur === null) throw new Fail('missing', from);
    if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
    const f = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const { O, N } = hunkON(h);
      if (O.length === 0) {
        const pos = Math.min(h.a + d, f.lines.length);
        const atEnd = pos === f.lines.length;
        f.lines = insertAt(f.lines, pos, N);
        if (atEnd) f.final = !hunkNoEol(h);
      } else {
        const found = firstTier(O, f.lines, strict);
        if (found === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let best = found.at[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.at) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const atEnd = best + O.length === f.lines.length;
        f.lines = replaceAt(f.lines, best, O, N, found.tier);
        if (atEnd) f.final = !hunkNoEol(h);
      }
      d += N.length - O.length;
    }
    const out = joinFile(f);
    if (isMove) {
      tree.now.set(to, out);
      tree.now.set(from, null);
      moves.push({ old: from, new: to });
    } else {
      tree.now.set(from, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnifiedSections(lines).map((sec) => unifiedEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

interface SearchReplaceBlock {
  path: string;
  searchLine: number;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    blocks.push({ path, searchLine, oldLines: lines.slice(searchLine + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function searchReplaceEdit(b: SearchReplaceBlock, strict: boolean): Edit {
  const p = b.path;
  if (b.oldLines.length === 0) {
    const content = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, content);
    };
  }
  const O = b.oldLines;
  const N: NLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oIndex: null }));
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = splitFile(cur);
    const found = firstTier(O, f.lines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.at.length > 1) throw new Fail('ambiguous', p);
    f.lines = replaceAt(f.lines, found.at[0]!, O, N, found.tier);
    tree.now.set(p, joinFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => searchReplaceEdit(b, strict));
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  O: string[];
  N: NLine[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** Add File: the file's lines. */
  lines: string[];
  chunks: V4aChunk[];
}

interface RawLine {
  text: string;
  /** 1-based patch line number. */
  no: number;
}

function v4aChunkBody(body: { kind: 'ctx' | 'old' | 'new'; text: string }[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ text: b.text, ctx: true, oIndex: O.length - 1 });
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else {
      N.push({ text: b.text, ctx: false, oIndex: null });
    }
  }
  return { O, N };
}

function parseV4aSection(kind: 'add' | 'delete' | 'update', path: string, headerLine: number, raw: RawLine[]): V4aSection {
  if (kind === 'add') {
    const lines: string[] = [];
    for (const r of raw) {
      if (r.text === '') lines.push('');
      else if (r.text[0] === '+') lines.push(r.text.slice(1));
      else throw new Exit2(`error: parse ${r.no}`);
    }
    return { kind, path, moveTo: null, lines, chunks: [] };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    return { kind, path, moveTo: null, lines: [], chunks: [] };
  }
  let j = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    j = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; body: { kind: 'ctx' | 'old' | 'new'; text: string }[]; eof: boolean } | null = null;
  const close = (): void => {
    if (cur === null) return;
    const { O, N } = v4aChunkBody(cur.body);
    chunks.push({ anchor: cur.anchor, O, N, eof: cur.eof });
    cur = null;
  };
  while (j < raw.length) {
    const r = raw[j]!;
    const t = r.text;
    if (t.startsWith('@@')) {
      close();
      cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), body: [], eof: false };
      j++;
      continue;
    }
    if (t.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.no}`);
      cur.eof = true;
      close();
      j++;
      continue;
    }
    if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
        cur = { anchor: null, body: [], eof: false };
      }
      const kind = t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new';
      cur.body.push({ kind, text: t === '' ? '' : t.slice(1) });
      j++;
      continue;
    }
    throw new Exit2(`error: parse ${r.no}`);
  }
  close();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return { kind, path, moveTo, lines: [], chunks };
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    const raw: RawLine[] = [];
    while (i < last) {
      const s = lines[i]!;
      if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
      raw.push({ text: s, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push(parseV4aSection(kind, path, headerLine, raw));
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** The first line at or after `cursor` equal to the anchor, at the first tier where one is. */
function anchorLine(anchor: string, file: string[], cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let k = cursor; k < file.length; k++) {
      if (lineEq(anchor, file[k]!, tier)) return k;
    }
  }
  return null;
}

/** First tier with an occurrence at or after `from` that ends at the file's last line (EOF chunks). */
function firstTierEof(O: string[], file: string[], strict: boolean, from: number): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(O, file, tier, from).filter((pos) => pos + O.length === file.length);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const content = sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n';
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, content);
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  const p = sec.path;
  const moveTo = sec.moveTo;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = anchorLine(ch.anchor, f.lines, cursor, strict);
        if (at === null) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      if (ch.O.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        f.lines = insertAt(f.lines, pos, ch.N);
        cursor = pos + ch.N.length;
      } else {
        const found = ch.eof ? firstTierEof(ch.O, f.lines, strict, cursor) : firstTier(ch.O, f.lines, strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        const at = found.at[0]!;
        f.lines = replaceAt(f.lines, at, ch.O, ch.N, found.tier);
        cursor = at + ch.N.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(p, null);
      moves.push({ old: p, new: moveTo });
    } else {
      tree.now.set(p, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((sec) => v4aEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// Running the patch (sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  moves = [];
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one per changed path, in byte order; a move replaces its D and A pair with one R line,
  // sorted by the new path (section 2).
  const rows = new Map<string, { key: string; text: string; move?: { old: string; new: string } }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  // Collapse move chains (a -> b, b -> c becomes a -> c) and replace D/A pairs by R lines.
  const follow = new Map<string, string>();
  for (const m of moves) follow.set(m.old, m.new);
  const collapsed: { old: string; new: string }[] = [];
  for (const m of moves) {
    let end = m.new;
    const seen = new Set<string>([m.old]);
    while (follow.has(end) && !seen.has(end)) {
      seen.add(end);
      end = follow.get(end)!;
    }
    collapsed.push({ old: m.old, new: end });
  }
  for (const m of collapsed) {
    const dRow = rows.get(m.old);
    const aRow = rows.get(m.new);
    if (dRow !== undefined && dRow.text.startsWith('D ') && aRow !== undefined && aRow.text.startsWith('A ')) {
      rows.delete(m.old);
      rows.delete(m.new);
      rows.set(`R ${m.old} -> ${m.new}`, { key: m.new, text: `R ${m.old} -> ${m.new}`, move: { old: m.old, new: m.new } });
    }
  }
  const sorted = [...rows.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = sorted.map((r) => r.text);
  if (!check) {
    for (const r of sorted) {
      const line = r.text;
      if (r.move !== undefined) {
        rmSync(r.move.old, { force: true });
        mkdirSync(dirname(r.move.new), { recursive: true });
        writeFileSync(r.move.new, tree.now.get(r.move.new)!);
      } else if (line.startsWith('D ')) {
        rmSync(line.slice(2), { force: true });
      } else {
        const p = line.slice(2);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, tree.now.get(p)!);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
