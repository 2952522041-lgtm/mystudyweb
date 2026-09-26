import type {
  CourseKnowledge,
  CourseManifest,
  DocumentDigest,
  SourceReference,
} from '../course-storage/types.ts';
import {
  buildMindmapLayout,
  computeMindmapGeometry,
  MINDMAP_MARGIN,
  MINDMAP_NODE_HEIGHT,
  MINDMAP_NODE_WIDTH,
} from './mindmap-layout.ts';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateLabel(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function formatSource(source: SourceReference): string {
  const pages =
    source.pageEnd && source.pageEnd !== source.pageStart
      ? `第 ${source.pageStart}–${source.pageEnd} 页`
      : `第 ${source.pageStart} 页`;
  return `${source.fileName} · ${pages}`;
}

function digestGenerationNote(digest: DocumentDigest): string {
  return digest.promptVersion === 'local-structure-v1'
    ? '本地结构化学习总结，可由应用重新生成。'
    : `AI 生成${digest.model ? `（模型 ${digest.model}）` : ''}，可随时重新生成。`;
}

export function renderDocumentSummary(digest: DocumentDigest): string {
  const sections = digest.sections
    .map((section) => {
      const pages =
        section.pageEnd > section.pageStart
          ? `第 ${section.pageStart}–${section.pageEnd} 页`
          : `第 ${section.pageStart} 页`;
      const points = section.points?.map((point) =>
        `${point.text}\n\n来源：第 ${point.pageStart}${point.pageEnd !== point.pageStart ? `–${point.pageEnd}` : ''} 页`,
      ).join('\n\n') ?? '';
      return `## ${section.title}\n\n${section.summary}\n\n${points}${points ? '\n\n' : ''}来源：${pages}`;
    })
    .join('\n\n');
  const questions = digest.unresolvedQuestions.length
    ? `\n\n## 待解决问题\n\n${digest.unresolvedQuestions.map((question) => `- ${question}`).join('\n')}\n`
    : '';
  return `# ${digest.title}\n\n> ${digestGenerationNote(digest)}\n\n## 内容概览\n\n${digest.overview}\n\n${sections}${questions}`;
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
  const evidence = knowledge.evidence?.length ? `\n## 关键元素（来源原文保留）\n\n${knowledge.evidence.map(item => `${item.text}\n\n来源：${item.sources.map(formatSource).join('；')}`).join('\n\n')}` : '';
  const generation = knowledge.promptVersion
    ? ` · AI 综合（模型 ${knowledge.model ?? '未知'}）`
    : '';
  const conflicts = knowledge.conflicts.length
    ? `\n## 资料冲突\n\n${knowledge.conflicts
        .map((conflict) => {
          const node = knowledge.nodes.find((item) => item.id === conflict.nodeId);
          const sources = conflict.sources.map(formatSource).join('；');
          return `### ${node?.label ?? conflict.nodeId}\n\n${conflict.descriptions
            .map((description) => `- ${description}`)
            .join('\n')}\n\n来源：${sources || '见上'}`;
        })
        .join('\n\n')}\n`
    : '';
  const questions = knowledge.unresolvedQuestions?.length
    ? `\n## 待解决问题\n\n${knowledge.unresolvedQuestions.map((question) => `- ${question}`).join('\n')}\n`
    : '';
  return `# ${manifest.name}课程总结\n\n> 版本 ${knowledge.version} · 汇总 ${manifest.documents.filter((item) => item.includedInCourse).length} 份 PDF · ${knowledge.updatedAt}${generation}\n\n${concepts || '尚未纳入课程资料。'}\n${conflicts}${questions}${evidence}`;
}

interface SvgNodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把结构化知识库渲染成关系型 SVG：节点按 AI relations 的层次分列，
 * 关系标签画在连线中点；横向关系用虚线。展示上限之外的节点会折叠计数，
 * 完整结构始终保存在 课程脑图.json 中。
 */
export function renderKnowledgeSvg(
  manifest: CourseManifest,
  knowledge: CourseKnowledge,
): string {
  const layout = buildMindmapLayout(knowledge.nodes, knowledge.relations);
  if (!layout.rootId) {
    const width = 900;
    const height = 240;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f5f7fa"/><text x="450" y="120" text-anchor="middle" font-size="18" fill="#687386">${escapeXml(manifest.name)}：课程脑图还是空的</text></svg>`;
  }
  const geometry = computeMindmapGeometry(layout);
  const boxes = new Map<string, SvgNodeBox>();
  for (const node of layout.nodes) {
    const position = geometry.positions.get(node.id);
    if (!position) continue;
    boxes.set(node.id, {
      x: position.x,
      y: position.y,
      width: MINDMAP_NODE_WIDTH,
      height: MINDMAP_NODE_HEIGHT,
    });
  }

  const edgeMarkup = layout.edges
    .map((edge) => {
      const from = boxes.get(edge.from);
      const to = boxes.get(edge.to);
      if (!from || !to) return '';
      const startX = from.x + from.width;
      const startY = from.y + from.height / 2;
      const endX = to.x;
      const endY = to.y + to.height / 2;
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;
      const stroke = edge.cross ? '#a78bda' : '#9fb2cc';
      const dash = edge.cross ? ' stroke-dasharray="6 4"' : '';
      const path = `<path d="M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}" fill="none" stroke="${stroke}" stroke-width="2"${dash}/>`;
      const label = edge.label
        ? `<text x="${midX}" y="${midY - 6}" text-anchor="middle" font-size="10" fill="#7c68b8">${escapeXml(truncateLabel(edge.label, 6))}</text>`
        : '';
      return path + label;
    })
    .join('');

  const nodeMarkup = layout.nodes
    .map((node) => {
      const box = boxes.get(node.id)!;
      const isRoot = node.id === layout.rootId;
      const fill = isRoot ? '#243a59' : node.ownership === 'user' ? '#fff7e6' : '#f7f8ff';
      const stroke = isRoot ? '#243a59' : node.ownership === 'user' ? '#d9922a' : '#8f86dc';
      const titleFill = isRoot ? 'white' : '#273447';
      const subtitle = isRoot
        ? '课程核心主题'
        : node.ownership === 'user'
          ? '用户节点'
          : `${node.sources.length} 个来源`;
      return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="${isRoot ? 0 : 1.5}"/><text x="${box.x + 16}" y="${box.y + 26}" font-size="14" font-weight="700" fill="${titleFill}">${escapeXml(truncateLabel(node.label, 16))}</text><text x="${box.x + 16}" y="${box.y + 46}" font-size="11" fill="${isRoot ? '#c7d2e5' : '#687386'}">${escapeXml(subtitle)}${node.relationLabel ? ` · ${escapeXml(node.relationLabel)}` : ''}</text>`;
    })
    .join('');

  const hiddenNote =
    layout.hiddenCount > 0
      ? `<text x="${MINDMAP_MARGIN}" y="${geometry.height - 10}" font-size="11" fill="#8a94a6">已折叠 ${layout.hiddenCount} 个节点，完整结构见 课程脑图.json</text>`
      : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${geometry.width}" height="${geometry.height}" viewBox="0 0 ${geometry.width} ${geometry.height}"><rect width="100%" height="100%" fill="#f5f7fa"/>${edgeMarkup}${nodeMarkup}${hiddenNote}</svg>`;
}

/** Portable markmap-compatible Markdown; export includes nodes hidden in the UI. */
export function renderMindmapMarkdown(knowledge: CourseKnowledge): string {
  const layout = buildMindmapLayout(knowledge.nodes, knowledge.relations, { maxNodes: Infinity });
  const children = new Map<string | null, typeof layout.nodes>();
  for (const node of layout.nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node); children.set(node.parentId, list);
  }
  const escape = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>#]/g, '\\$&');
  const lines: string[] = [];
  const stack = [...(children.get(null) ?? [])].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    const indent = '  '.repeat(node.depth);
    lines.push(`${indent}- ${escape(node.label)}`);
    for (const source of node.sources) lines.push(`${indent}  - 来源：${escape(formatSource(source))}`);
    stack.push(...[...(children.get(node.id) ?? [])].reverse());
  }
  return lines.join('\n') + '\n';
}
