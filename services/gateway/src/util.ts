/**
 * Split a message into chunks that fit within maxLength.
 * Tries to split on paragraph breaks first, then line breaks, then hard-splits.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;

    // Try paragraph break (double newline)
    const paraIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (paraIdx > maxLength * 0.3) {
      splitAt = paraIdx;
    }

    // Try line break
    if (splitAt === -1) {
      const lineIdx = remaining.lastIndexOf('\n', maxLength);
      if (lineIdx > maxLength * 0.3) {
        splitAt = lineIdx;
      }
    }

    // Try space
    if (splitAt === -1) {
      const spaceIdx = remaining.lastIndexOf(' ', maxLength);
      if (spaceIdx > maxLength * 0.3) {
        splitAt = spaceIdx;
      }
    }

    // Hard split
    if (splitAt === -1) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  return chunks;
}
