import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = Object.freeze({ model: 'jev-1.13.0', reviewDeadlineMs: 2000, maxCorrectionsPerEpisode: 2, maxReviewRequests: 4, rules: {} });
const ALLOWED = new Set(['schema', 'model', 'reviewDeadlineMs', 'maxCorrectionsPerEpisode', 'maxReviewRequests', 'rules']);

function validateLayer(raw, source, diagnostics) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { diagnostics.push({ source, message: 'configuration must be a JSON object' }); return {}; }
  const valid = {};
  for (const key of Object.keys(raw)) if (!ALLOWED.has(key)) diagnostics.push({ source, message: `unsupported configuration field ${key}` });
  if (raw.schema !== undefined && raw.schema !== 'agent-rules/config-v1') diagnostics.push({ source, message: 'schema must be agent-rules/config-v1' });
  if (typeof raw.model === 'string' && raw.model.trim() && raw.model.length < 200) valid.model = raw.model;
  else if (raw.model !== undefined) diagnostics.push({ source, message: 'model must be a nonempty model identifier' });
  if (Number.isInteger(raw.reviewDeadlineMs) && raw.reviewDeadlineMs >= 100 && raw.reviewDeadlineMs <= 120000) valid.reviewDeadlineMs = raw.reviewDeadlineMs;
  else if (raw.reviewDeadlineMs !== undefined) diagnostics.push({ source, message: 'reviewDeadlineMs must be an integer from 100 to 120000' });
  if (Number.isInteger(raw.maxCorrectionsPerEpisode) && raw.maxCorrectionsPerEpisode >= 0 && raw.maxCorrectionsPerEpisode <= 20) valid.maxCorrectionsPerEpisode = raw.maxCorrectionsPerEpisode;
  else if (raw.maxCorrectionsPerEpisode !== undefined) diagnostics.push({ source, message: 'maxCorrectionsPerEpisode must be an integer from 0 to 20' });
  if (Number.isInteger(raw.maxReviewRequests) && raw.maxReviewRequests >= 1 && raw.maxReviewRequests <= 8) valid.maxReviewRequests = raw.maxReviewRequests;
  else if (raw.maxReviewRequests !== undefined) diagnostics.push({ source, message: 'maxReviewRequests must be an integer from 1 to 8' });
  if (raw.rules !== undefined) {
    if (!raw.rules || typeof raw.rules !== 'object' || Array.isArray(raw.rules)) diagnostics.push({ source, message: 'rules must be an object of rule IDs and modes' });
    else {
      valid.rules = {};
      for (const [id, mode] of Object.entries(raw.rules)) {
        if (!/^[\w.-]+$/.test(id) || !['off', 'observe', 'repair'].includes(mode)) diagnostics.push({ source, message: `invalid rule mode entry for ${id}` });
        else valid.rules[id] = mode;
      }
    }
  }
  return valid;
}

async function readConfig(file, diagnostics) {
  try {
    const text = await readFile(file, 'utf8');
    let raw;
    try { raw = JSON.parse(text); } catch { diagnostics.push({ source: file, message: 'invalid JSON configuration' }); return {}; }
    return validateLayer(raw, file, diagnostics);
  } catch (error) {
    if (error.code !== 'ENOENT') diagnostics.push({ source: file, message: `could not read configuration (${error.code ?? 'error'})` });
    return {};
  }
}

export async function loadConfig({ projectRoot = process.cwd(), configPath, home = process.env.HOME ?? '', env = process.env } = {}) {
  const diagnostics = [];
  const explicit = configPath ?? env.AGENT_RULES_CONFIG;
  let layers;
  if (explicit) {
    if (!path.isAbsolute(explicit) && (path.normalize(explicit).startsWith(`..${path.sep}`) || path.normalize(explicit) === '..')) throw new Error('config path must be absolute or remain within the working directory');
    layers = [path.resolve(explicit)];
  } else {
    layers = [path.join(home, '.config', 'agent-rules', 'config.json'), path.join(projectRoot, '.agent-rules', 'config.json')];
  }
  const merged = { ...DEFAULTS, rules: {} };
  for (const file of layers) {
    const part = await readConfig(file, diagnostics);
    for (const key of ['model', 'reviewDeadlineMs', 'maxCorrectionsPerEpisode', 'maxReviewRequests']) if (part[key] !== undefined) merged[key] = part[key];
    if (part.rules) Object.assign(merged.rules, part.rules);
  }
  merged.policyDirectories = explicit ? [] : [path.join(home, '.config', 'agent-rules', 'rules'), path.join(projectRoot, '.agent-rules', 'rules')];
  merged.stateDir = env.AGENT_RULES_STATE_DIR || path.join(home, '.local', 'state', 'agent-rules');
  return { config: Object.freeze(merged), diagnostics };
}
