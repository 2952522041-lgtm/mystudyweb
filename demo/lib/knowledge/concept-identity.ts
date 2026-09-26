/** Conservative identity: punctuation and mathematical symbols are meaningful.
 * Semantic synonyms are unified by the provider, not guessed from spelling.
 */
export function conceptKey(value: string): string {
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return normalized.length === 1 ? normalized : normalized.toLowerCase();
}
