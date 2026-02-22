/**
 * Estimate token count from text.
 * Uses the ~4 chars/token heuristic for fast, synchronous counting.
 * Accurate enough for threshold triggers — exact BPE counts aren't needed.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
