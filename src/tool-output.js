import { randomUUID } from 'node:crypto';

/** Preserve a host result's schema and metadata; delimit payload text with rule-supplied instructions. */
export function wrapToolOutput(name, output, instruction) {
  const boundary = randomUUID();
  const begin = `[Agent Rules]\n${instruction}\n[Begin tool content ${boundary}]\n`;
  const end = `\n[End tool content ${boundary}]\n[Agent Rules]\n${instruction}`;
  const wrap = text => `${begin}${text}${end}`;
  if (typeof output === 'string') return { output: wrap(output), wrapped: true };
  if (name?.startsWith('mcp__')) {
    // MCP outputs have no built-in-tool schema validation. Keep resource/binary blocks intact.
    const blocks = Array.isArray(output) ? output : output?.content;
    if (Array.isArray(blocks)) {
      const content = [{ type: 'text', text: begin }, ...blocks, { type: 'text', text: end }];
      return { output: Array.isArray(output) ? content : { ...output, content }, wrapped: true };
    }
    // Nonstandard structured MCP results remain intact, inside a content envelope.
    if (output && typeof output === 'object') return { output: { ...output, content: [{ type: 'text', text: wrap(JSON.stringify(output)) }] }, wrapped: true };
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { wrapped: false };
  if (name === 'Read' && output.type === 'text' && typeof output.file?.content === 'string') {
    return { output: { ...output, file: { ...output.file, content: wrap(output.file.content) } }, wrapped: true };
  }
  // These fields are textual payloads, not paths, discriminators, counts or binary data.
  const keys = ['stdout', 'stderr', 'content', 'text', 'output', 'message'];
  const fields = keys.filter(key => typeof output[key] === 'string' && output[key].length);
  if (!fields.length) return { wrapped: false };
  return { output: { ...output, ...Object.fromEntries(fields.map(key => [key, wrap(output[key])])) }, wrapped: true };
}
