import type {
  CourseKnowledge,
  CourseManifest,
  DocumentDigest,
  SourceReference,
} from '../course-storage/types.ts';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatSource(source: SourceReference): string {
  const pages =
    source.pageEnd && source.pageEnd !== source.pageStart
      ? `第 ${source.pageStart}–${source.pageEnd} 页`
      : `第 ${source.pageStart} 页`;
  return `${source.fileName} · ${pages}`;
}

export function renderDocumentSummary(digest: DocumentDigest): string {
  const sections = digest.sections
    .map(
      (section) =>
        `## ${section.title}\n\n${section.summary}\n\n来源：第 ${section.pageStart} 页`,
    )
    .join('\n\n');
  return `# ${digest.title}\n\n> 本地结构化学习总结，可由应用重新生成。\n\n## 内容概览\n\n${digest.overview}\n\n${sections}\n`;
}

export function renderCourseSummary(
  manifest: CourseManifest,
  knowledge: CourseKnowledge,
): string {
  const concepts = knowledge.nodes
    .filter((node) => node.kind !== 'course')
    .map((node) => {
      const sources = node.sources.map(formatSource).join('；') || '用户节点';
      return `## ${node.label}\n\n${node.description}\n\n来源：${sources}`;
    })
    .join('\n\n');
  return `# ${manifest.name}课程总结\n\n> 版本 ${knowledge.version} · 汇总 ${manifest.documents.filter((item) => item.includedInCourse).length} 份 PDF · ${knowledge.updatedAt}\n\n${concepts || '尚未纳入课程资料。'}\n`;
}

export function renderKnowledgeSvg(
  manifest: CourseManifest,
  knowledge: CourseKnowledge,
): string {
  const nodes = knowledge.nodes.slice(0, 24);
  const width = 1200;
  const rowHeight = 82;
  const height = Math.max(
    220,
    100 + Math.ceil(Math.max(1, nodes.length - 1) / 2) * rowHeight,
  );
  const root = nodes[0];
  const childNodes = nodes.slice(1);
  const childMarkup = childNodes
    .map((node, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = column === 0 ? 70 : 730;
      const y = 82 + row * rowHeight;
      const lineX = column === 0 ? 330 : 730;
      return `<path d="M 600 56 C 520 56 ${lineX} ${y + 24} ${lineX} ${y + 24}" fill="none" stroke="#c9d2df" stroke-width="2"/><rect x="${x}" y="${y}" width="400" height="50" rx="12" fill="#f7f8ff" stroke="#8f86dc"/><text x="${x + 18}" y="${y + 22}" font-size="14" font-weight="700" fill="#273447">${escapeXml(node.label.slice(0, 42))}</text><text x="${x + 18}" y="${y + 39}" font-size="11" fill="#687386">${node.sources.length} 个来源</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f5f7fa"/><rect x="480" y="28" width="240" height="56" rx="14" fill="#243a59"/><text x="600" y="61" text-anchor="middle" font-size="18" font-weight="700" fill="white">${escapeXml(root?.label ?? manifest.name)}</text>${childMarkup}</svg>`;
}
