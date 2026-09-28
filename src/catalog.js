import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';

const EVIDENCE = new Set(['request', 'conversation', 'response', 'receipts', 'changes', 'thinking', 'constraints']);
const EVENTS = new Set(['session_start', 'user_prompt', 'tool_start', 'tool_result', 'thinking_observed', 'response_end', 'interrupt', 'session_end']);
const TARGETS = new Set(['request', 'tool_call', 'response', 'response_span', 'code_change', 'thinking', 'thinking_span']);
function rejectUnknown(value, allowed, file, field) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(file, `${field}.${key}`, 'is not a supported field');
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
const fail = (file, field, message) => { throw new Error(`${file}: ${field}: ${message}`); };

function finiteProbability(value, file, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(file, field, 'must be a number from 0 to 1');
}

function validateDecision(detector, file) {
  const q = detector.question ?? {};
  const d = detector.decision ?? {};
  if (!d || typeof d !== 'object') fail(file, 'detector.decision', 'is required');
  if (q.type === 'choice') {
    rejectUnknown(d, ['violation', 'unknown_options', 'min_winner_probability'], file, 'detector.decision');
    const options = q.criteria && typeof q.criteria === 'object' ? Object.keys(q.criteria) : [];
    if (options.length < 2) fail(file, 'detector.question.criteria', 'choice requires at least two named options');
    const violation = d.violation;
    if (violation && typeof violation === 'object') rejectUnknown(violation, ['option', 'min_probability'], file, 'detector.decision.violation');
    if (!violation || !options.includes(violation.option)) fail(file, 'detector.decision.violation.option', `unknown option ${JSON.stringify(violation?.option)}`);
    finiteProbability(violation.min_probability, file, 'detector.decision.violation.min_probability');
    finiteProbability(d.min_winner_probability, file, 'detector.decision.min_winner_probability');
    if (d.unknown_options !== undefined && !Array.isArray(d.unknown_options)) fail(file, 'detector.decision.unknown_options', 'must be a list of option names');
    for (const option of d.unknown_options ?? []) if (!options.includes(option)) fail(file, 'detector.decision.unknown_options', `unknown option ${JSON.stringify(option)}`);
  } else if (q.type === 'noul') {
    rejectUnknown(d, ['violation_at_or_above', 'clear_at_or_below'], file, 'detector.decision');
    for (const k of ['violation_at_or_above', 'clear_at_or_below']) finiteProbability(d[k], file, `detector.decision.${k}`);
    if (d.clear_at_or_below >= d.violation_at_or_above) fail(file, 'detector.decision', 'Noul decision thresholds overlap');
  } else if (q.type === 'score') {
    rejectUnknown(d, ['violation_levels', 'clear_levels', 'min_probability'], file, 'detector.decision');
    const levels = Array.isArray(q.criteria) ? q.criteria.map((_, index) => String(index)) : [];
    for (const k of ['violation_levels', 'clear_levels']) {
      if (!Array.isArray(d[k]) || d[k].length === 0) fail(file, `detector.decision.${k}`, 'must name one or more score levels');
      for (const level of d[k]) if (typeof level !== 'string' || !levels.includes(level)) fail(file, `detector.decision.${k}`, `unknown score level ${JSON.stringify(level)}; use a zero-based level index as a string`);
    }
    if (d.violation_levels.some(x => d.clear_levels.includes(x))) fail(file, 'detector.decision', 'score decision ranges overlap');
    finiteProbability(d.min_probability, file, 'detector.decision.min_probability');
  }
}

export function parsePolicy(source, { file = '<policy>' } = {}) {
  const text = String(source).replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) fail(file, 'frontmatter', 'must begin with ---');
  const end = text.indexOf('\n---', 3);
  if (end < 0) fail(file, 'frontmatter', 'closing --- is missing');
  const doc = parseDocument(text.slice(4, end), { uniqueKeys: true });
  if (doc.errors.length) fail(file, 'YAML', doc.errors[0].message);
  const raw = doc.toJS();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(file, 'frontmatter', 'must be a mapping');
  rejectUnknown(raw, ['schema', 'id', 'revision', 'description', 'events', 'target', 'requires', 'uses', 'prefilter', 'priority', 'detector', 'intervention'], file, 'frontmatter');
  if (raw.schema !== 'agent-rules/v1') fail(file, 'schema', 'must be agent-rules/v1');
  if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(raw.id)) fail(file, 'id', 'must be a nonempty stable rule identifier');
  if (typeof raw.description !== 'string' || !raw.description.trim()) fail(file, 'description', 'is required');
  if (!Array.isArray(raw.events) || !raw.events.length || raw.events.some(x => !EVENTS.has(x))) fail(file, 'events', `must contain supported event names (${[...EVENTS].join(', ')})`);
  if (!TARGETS.has(raw.target)) fail(file, 'target', `must be one of ${[...TARGETS].join(', ')}`);
  if (!Array.isArray(raw.requires) || raw.requires.some(x => typeof x !== 'string' || !EVIDENCE.has(x))) {
    const bad = Array.isArray(raw.requires) ? raw.requires.find(x => typeof x !== 'string' || !EVIDENCE.has(x)) : undefined;
    fail(file, 'requires', `unsupported evidence name ${JSON.stringify(bad)} (supported: ${[...EVIDENCE].join(', ')})`);
  }
  // `uses` names evidence that is sent when present but, unlike `requires`, never blocks the review.
  if (raw.uses !== undefined && (!Array.isArray(raw.uses) || raw.uses.some(x => typeof x !== 'string' || !EVIDENCE.has(x)))) fail(file, 'uses', `must list supported evidence names (${[...EVIDENCE].join(', ')})`);
  // `prefilter` is a regular expression tested locally on each candidate; a candidate it does not match is clear without a Jev call.
  if (raw.prefilter !== undefined) {
    if (!raw.prefilter || typeof raw.prefilter !== 'object' || Array.isArray(raw.prefilter)) fail(file, 'prefilter', 'must be a mapping with pattern and optional flags');
    rejectUnknown(raw.prefilter, ['pattern', 'flags'], file, 'prefilter');
    if (typeof raw.prefilter.pattern !== 'string' || !raw.prefilter.pattern) fail(file, 'prefilter.pattern', 'is required');
    if (raw.prefilter.flags !== undefined && (typeof raw.prefilter.flags !== 'string' || /[^imsu]/.test(raw.prefilter.flags))) fail(file, 'prefilter.flags', 'may contain only i, m, s, and u');
    try { new RegExp(raw.prefilter.pattern, raw.prefilter.flags ?? ''); } catch (e) { fail(file, 'prefilter.pattern', `invalid regular expression: ${e.message}`); }
  }
  if (!Number.isInteger(raw.priority) || raw.priority < 0 || raw.priority > 1000) fail(file, 'priority', 'must be an integer from 0 to 1000');
  const detector = raw.detector;
  if (!detector || typeof detector !== 'object') fail(file, 'detector', 'is required');
  if (detector.type === 'regex') {
    rejectUnknown(detector, ['type', 'pattern', 'flags'], file, 'detector');
    if (typeof detector.pattern !== 'string' || !detector.pattern) fail(file, 'detector.pattern', 'is required');
    try { new RegExp(detector.pattern, detector.flags ?? ''); } catch (e) { fail(file, 'detector.pattern', `invalid regular expression: ${e.message}`); }
    if (typeof detector.flags !== 'undefined' && (typeof detector.flags !== 'string' || /[^dgimsuvy]/.test(detector.flags))) fail(file, 'detector.flags', 'contains unsupported regular expression flags');
  } else if (detector.type === 'jev') {
    rejectUnknown(detector, ['type', 'question', 'decision'], file, 'detector');
    const q = detector.question;
    if (q && typeof q === 'object') rejectUnknown(q, ['type', 'instructions', 'criteria'], file, 'detector.question');
    if (!q || !['choice', 'noul', 'score'].includes(q.type)) fail(file, 'detector.question.type', 'must be choice, noul, or score');
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) fail(file, 'detector.question.instructions', 'is required');
    if (q.type === 'choice' && (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2)) fail(file, 'detector.question.criteria', 'choice requires at least two named criteria');
    if (q.type === 'noul' && q.criteria !== undefined && q.criteria !== null && (typeof q.criteria !== 'object' || Array.isArray(q.criteria) || Object.keys(q.criteria).some(key => !['true', 'false'].includes(key)))) fail(file, 'detector.question.criteria', 'Noul criteria may contain only true and false descriptions');
    if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) fail(file, 'detector.question.criteria', 'Score criteria must be an ordered array with 2 to 10 levels');
    validateDecision(detector, file);
  } else fail(file, 'detector.type', 'must be jev or regex');
  const body = text.slice(end + 4).replace(/^\n/, '');
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex(line => /^## Correction\s*$/.test(line));
  let correction = '';
  if (heading >= 0) {
    let next = lines.findIndex((line, index) => index > heading && /^## /.test(line));
    if (next < 0) next = lines.length;
    correction = lines.slice(heading + 1, next).join('\n').trim();
  }
  const mode = raw.intervention ?? 'observe';
  if (!['observe', 'repair', 'block'].includes(mode)) fail(file, 'intervention', 'must be observe, repair, or block');
  if (['repair', 'block'].includes(mode) && !correction) fail(file, 'Correction', 'section is required for repair and block policies');
  const hash = createHash('sha256').update(JSON.stringify({ frontmatter: raw, correction })).digest('hex');
  return Object.freeze({ id: raw.id, description: raw.description, events: Object.freeze([...raw.events]), target: raw.target,
    requires: Object.freeze([...raw.requires]), uses: Object.freeze([...(raw.uses ?? [])]), prefilter: raw.prefilter ? Object.freeze({ ...raw.prefilter }) : undefined, priority: raw.priority, detector: Object.freeze(detector), correction, hash, mode });
}

export async function loadPolicies({ directories = [], modes = {} } = {}) {
  const chosen = new Map();
  const diagnostics = [];
  for (const directory of directories) {
    let entries;
    try { entries = (await readdir(directory, { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith('.md')).sort((a,b) => a.name.localeCompare(b.name)); }
    catch (error) { if (error.code === 'ENOENT') continue; diagnostics.push({ file: directory, message: error.message }); continue; }
    const seen = new Set();
    const pending = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      try { const parsed = parsePolicy(await readFile(file, 'utf8'), { file }); pending.push({ id: parsed.id, parsed, file }); }
      catch (error) {
        const sourceText = await readFile(file, 'utf8').catch(() => '');
        const id = /(?:^|\n)id:\s*['"]?([\w.-]+)/.exec(sourceText)?.[1];
        diagnostics.push({ file, ...(id ? { id } : {}), message: error.message });
        // Best-effort identity extraction ensures malformed overrides tombstone their lower-precedence version.
        if (id) pending.push({ id, parsed: null, file });
      }
    }
    for (const item of pending) {
      if (seen.has(item.id)) { chosen.set(item.id, null); diagnostics.push({ file: item.file, id: item.id, message: `duplicate policy id ${item.id} in ${directory}` }); }
      else { seen.add(item.id); chosen.set(item.id, item.parsed); }
    }
  }
  const policies = [];
  for (const [id, parsed] of chosen) {
    if (!parsed) continue;
    const mode = modes[id] ?? parsed.mode;
    if (!['off', 'observe', 'repair', 'block'].includes(mode)) { diagnostics.push({ id, message: `invalid mode ${JSON.stringify(mode)}; policy disabled` }); continue; }
    if (mode === 'off') continue;
    if (['repair', 'block'].includes(mode) && !parsed.correction) { diagnostics.push({ id, message: `${mode} mode requires a Correction section; policy disabled` }); continue; }
    policies.push(Object.freeze({ ...parsed, mode }));
  }
  return { policies: Object.freeze(policies), diagnostics };
}
