type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Correct only the unambiguous child -> parent form of a containment edge.
 *
 * Model output occasionally reverses `包含` even though parentId is explicit.
 * The parent map is authoritative here: a relation is swapped only when its
 * `from` node explicitly names `to` as its parent, while `to` does not point
 * back to `from` (which would be a two-node cycle). Everything else is left
 * untouched for the normal validator to reject or handle.
 */
export function normalizeContainmentDirection(raw: unknown): {
  value: unknown;
  correctedEdges: number;
} {
  if (!isPlainRecord(raw)) return { value: raw, correctedEdges: 0 };
  const concepts = raw.concepts;
  const relations = raw.relations;
  if (!Array.isArray(concepts) || !Array.isArray(relations)) {
    return { value: raw, correctedEdges: 0 };
  }

  const idCounts = new Map<string, number>();
  const parentById = new Map<string, unknown>();
  for (const concept of concepts) {
    if (!isPlainRecord(concept)) continue;
    const id = concept.id;
    if (!nonEmptyString(id)) continue;
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    parentById.set(id, concept.parentId);
  }

  let correctedEdges = 0;
  let normalizedRelations: unknown[] | undefined;
  for (const [index, relation] of relations.entries()) {
    if (!isPlainRecord(relation) || relation.label !== '包含') continue;
    const from = relation.from;
    const to = relation.to;
    if (
      !nonEmptyString(from) ||
      !nonEmptyString(to) ||
      from === to ||
      idCounts.get(from) !== 1 ||
      idCounts.get(to) !== 1 ||
      parentById.get(from) !== to ||
      parentById.get(to) === from
    ) {
      continue;
    }

    if (!normalizedRelations) normalizedRelations = [...relations];
    normalizedRelations[index] = { ...relation, from: to, to: from };
    correctedEdges += 1;
  }

  if (!normalizedRelations) return { value: raw, correctedEdges: 0 };
  return {
    value: { ...raw, relations: normalizedRelations },
    correctedEdges,
  };
}
