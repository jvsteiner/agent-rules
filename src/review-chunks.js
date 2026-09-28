// One review is one Jev request whenever it fits. Jev allows 32k tokens for the state plus the
// longest question (about 100k characters of English); this budget stays safely below that.
export const MAX_REVIEW_CHARS = 80000;
const OVERLAP = 256;

// Keep record identities and short context intact. Long evidence fields advance
// through overlapping windows together; shorter fields retain their final window.
export function chunkPayload(payload, { maxChars = MAX_REVIEW_CHARS, maxChunks = 4 } = {}) {
  const length = value => JSON.stringify(value).length;
  if (length(payload) <= maxChars) return [{ payload, coverage: { complete: true, count: 1, index: 0 } }];
  const fields = [];
  const add = (path, text) => { if (typeof text === 'string' && text.length > 2048) fields.push({ path, text }); };
  add(['response'], payload.state.response);
  for (const [i, candidate] of (payload.state.candidates ?? []).entries()) add(['candidates', i, 'text'], candidate.text);
  for (const [i, receipt] of (payload.state.receipts ?? []).entries()) {
    add(['receipts', i, 'input'], receipt.input); add(['receipts', i, 'result'], receipt.result);
  }
  for (const [i, change] of (payload.state.changes ?? []).entries()) {
    add(['changes', i, 'text'], change.text); add(['changes', i, 'context'], change.context);
  }
  for (const [i, thought] of (payload.state.thinking ?? []).entries()) add(['thinking', i, 'text'], thought.text);
  if (!fields.length) return [];
  const longest = Math.max(...fields.map(f => f.text.length));
  const countFor = width => Math.max(1, Math.ceil((longest - width) / (width - OVERLAP)) + 1);
  const build = (width, index, count) => {
    const copy = structuredClone(payload);
    const sources = fields.map(({ path, text }) => {
      const start = Math.min(index * (width - OVERLAP), Math.max(0, text.length - width));
      const end = Math.min(text.length, start + width);
      let parent = copy.state;
      for (const key of path.slice(0, -1)) parent = parent[key];
      parent[path.at(-1)] = text.slice(start, end);
      return { id: path.join('.'), start, end, total: text.length };
    });
    const coverage = { sources, index, count, complete: true };
    copy.state.review_chunk_coverage = { ...coverage, partial: true };
    for (const question of Object.values(copy.questions)) {
      const note = 'This state contains overlapping excerpts of long evidence fields. Record identities and short context are retained. Judge only explicit evidence in this excerpt; do not infer completion, absence, or intent from omitted text. Return an inconclusive answer when the missing context is needed.';
      question.instructions = typeof question.instructions === 'string'
        ? `${question.instructions}\n${note}` : { original: question.instructions, chunk_context: note };
    }
    return { payload: copy, coverage };
  };
  // Measure actual JSON including escaped text, coverage, and question overhead.
  let low = 512, high = Math.min(longest, maxChars), best = 0;
  while (low <= high) {
    const width = Math.floor((low + high) / 2), count = countFor(width);
    // At most maxChunks requests can be emitted; sample all of them, plus the
    // tail when the provisional plan is larger, without unbounded planning.
    const indexes = [...new Set([...Array(Math.min(count, maxChunks)).keys(), count - 1])];
    if (indexes.every(i => length(build(width, i, count).payload) <= maxChars)) { best = width; low = width + 1; }
    else high = width - 1;
  }
  if (!best) return [];
  const count = countFor(best);
  if (count > maxChunks) return [];
  const chunks = Array.from({ length: count }, (_, i) => build(best, i, count));
  return chunks.every(chunk => length(chunk.payload) <= maxChars) ? chunks : [];
}
