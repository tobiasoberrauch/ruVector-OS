/**
 * Security: sanitization for content that flows to LLM contexts (MCP)
 * and for HTML rendering (dashboard).
 *
 * Strategy: structural defenses — wrap document content in clear delimiter
 * tags so it's unambiguous to the LLM that the text is data, not instructions.
 */

/** Strip control characters that have no place in displayable text */
export function stripControlChars(text: string): string {
  // Keep \t (\x09), \n (\x0A), \r (\x0D) — strip everything else in C0 range
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Wrap file content for safe inclusion in MCP responses.
 * Uses delimiter tags that make it unambiguous to the LLM
 * that the enclosed text is document data, not instructions.
 */
export function wrapContentForMcp(
  content: string,
  filePath: string,
  maxLen: number,
): string {
  const cleaned = stripControlChars(content);
  const truncated = cleaned.length > maxLen
    ? cleaned.slice(0, maxLen) + '...[truncated]'
    : cleaned;
  return `[FILE_CONTENT path="${filePath}"]\n${truncated}\n[/FILE_CONTENT]`;
}

/** Escape HTML special characters for safe innerHTML interpolation */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
