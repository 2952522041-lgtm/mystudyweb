'use client';

import { useEffect, useMemo, useState } from 'react';
import { KnowledgeMarkdown } from '@/components/knowledge-section';
import { Button } from '@/components/ui/button';
import { SummaryDiffView } from '@/components/summary-diff-view';
import type {
  CourseKnowledge,
  CourseStorage,
} from '@/lib/course-storage/types';
import {
  compareKnowledge,
  type CourseHistoryEntry,
} from '@/lib/course-storage/study-tools';
import { formatSource } from '@/lib/knowledge/artifact-renderer';

export function CourseHistoryPanel({
  storage,
  current,
  currentSummary,
}: {
  storage: CourseStorage;
  current: CourseKnowledge;
  currentSummary?: string;
}) {
  const [entries, setEntries] = useState<CourseHistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [compareId, setCompareId] = useState('current');
  const [status, setStatus] = useState('正在读取成果版本…');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (storage.listHistory?.() ?? Promise.resolve([]))
      .then((values) => {
        if (cancelled) return;
        setEntries(values);
        setSelectedId((previous) =>
          values.some((value) => value.id === previous)
            ? previous
            : (values[0]?.id ?? ''),
        );
        setStatus(
          values.length ? '' : '还没有历史成果版本。更新课程成果后会自动保留。',
        );
      })
      .catch((error) => {
        if (!cancelled)
          setStatus(
            error instanceof Error ? error.message : '历史版本读取失败。',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [storage, current.version, refresh]);
  const selected = entries.find((entry) => entry.id === selectedId);
  const comparedEntry = entries.find((entry) => entry.id === compareId);
  // A refresh can remove a history file. Keep the selector and comparison in sync.
  const effectiveCompareId = comparedEntry ? compareId : 'current';
  const compared = comparedEntry?.knowledge ?? current;
  const fullSummaries =
    selected?.source === 'snapshot' &&
    (comparedEntry
      ? comparedEntry.source === 'snapshot'
      : currentSummary !== undefined);
  const knowledgeText = (knowledge: CourseKnowledge) =>
    knowledge.nodes
      .map((node) => `## ${node.label}\n\n${node.description}`)
      .join('\n\n');
  const diff = useMemo(
    () =>
      selected && compared
        ? compareKnowledge(selected.knowledge, compared)
        : null,
    [selected, compared],
  );
  return (
    <section className="space-y-4 p-6" aria-label="成果历史">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">成果版本与差异</h2>
          <p className="mt-1 text-xs leading-6 text-slate-500">
            历史记录供总结和脑图预览比较，未包含完整
            PDF、逐篇摘要或笔记，不支持整门课程恢复。
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新
        </Button>
      </div>
      <output className="text-xs text-slate-500" aria-live="polite">
        {status}
      </output>
      {entries.length ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label>
            起始版本{' '}
            <select
              aria-label="历史起始版本"
              className="rounded border p-2"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {entries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  v{entry.knowledge.version} ·{' '}
                  {entry.revision !== undefined
                    ? `修订 ${entry.revision} · `
                    : ''}
                  {entry.updatedAt.slice(0, 16).replace('T', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label>
            对比版本{' '}
            <select
              aria-label="历史对比版本"
              className="rounded border p-2"
              value={effectiveCompareId}
              onChange={(event) => setCompareId(event.target.value)}
            >
              <option value="current">当前 v{current.version}</option>
              {entries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  v{entry.knowledge.version} ·{' '}
                  {entry.updatedAt.slice(0, 16).replace('T', ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {selected && compared ? (
        <div className="space-y-2">
          {!fullSummaries ? (
            <p className="text-xs text-amber-700">
              部分版本缺少完整总结，以下只比较知识点说明。
            </p>
          ) : null}
          <SummaryDiffView
            before={
              fullSummaries
                ? selected.summary
                : knowledgeText(selected.knowledge)
            }
            after={
              fullSummaries
                ? comparedEntry
                  ? comparedEntry.summary
                  : currentSummary!
                : knowledgeText(compared)
            }
            beforeLabel={`起始 v${selected.knowledge.version}`}
            afterLabel={`${comparedEntry ? '对比' : '当前'} v${compared.version}`}
          />
        </div>
      ) : null}
      {diff ? (
        <div className="rounded-xl border p-4 text-sm">
          <p>
            对比版本新增 {diff.added.length} 项 · 移除 {diff.removed.length} 项
            · 修改 {diff.changed.length} 项
          </p>
          {(
            [
              ['新增', diff.added],
              ['移除', diff.removed],
              ['修改', diff.changed],
            ] as const
          ).map(([label, nodes]) =>
            nodes.length ? (
              <details key={label} className="mt-3">
                <summary>{label}的知识点</summary>
                {nodes.map((node) => (
                  <div key={node.id} className="mt-2 rounded bg-slate-50 p-3">
                    <strong>{node.label}</strong>
                    {label === '修改' ? (
                      <>
                        <p className="mt-2 text-xs text-slate-500">原说明</p>
                        <KnowledgeMarkdown>
                          {selected?.knowledge.nodes.find(
                            (item) => item.id === node.id,
                          )?.description ?? ''}
                        </KnowledgeMarkdown>
                        <p className="text-xs text-slate-500">新说明</p>
                      </>
                    ) : null}
                    <KnowledgeMarkdown>{node.description}</KnowledgeMarkdown>
                  </div>
                ))}
              </details>
            ) : null,
          )}
          {diff.questionsAdded.map((question) => (
            <p key={question} className="mt-2 text-emerald-700">
              新增问题：{question}
            </p>
          ))}
          {diff.questionsRemoved.map((question) => (
            <p key={question} className="mt-2 text-amber-700">
              移除问题：{question}
            </p>
          ))}
          {diff.relationsAdded.map((relation, index) => (
            <p key={`add-${index}`} className="mt-2 text-emerald-700">
              新增关系：
              {compared?.nodes.find((node) => node.id === relation.from)
                ?.label ?? relation.from}{' '}
              →{' '}
              {compared?.nodes.find((node) => node.id === relation.to)?.label ??
                relation.to}
              （{relation.label}）
            </p>
          ))}
          {diff.relationsRemoved.map((relation, index) => (
            <p key={`remove-${index}`} className="mt-2 text-amber-700">
              移除关系：
              {selected?.knowledge.nodes.find(
                (node) => node.id === relation.from,
              )?.label ?? relation.from}{' '}
              →{' '}
              {selected?.knowledge.nodes.find((node) => node.id === relation.to)
                ?.label ?? relation.to}
              （{relation.label}）
            </p>
          ))}
          {diff.changed.length ? (
            <details className="mt-3">
              <summary>名称、层级与来源变更明细</summary>
              {diff.changed.map((node) => {
                const previous = selected?.knowledge.nodes.find(
                  (item) => item.id === node.id,
                );
                return (
                  <div
                    key={node.id}
                    className="my-2 rounded border p-3 text-xs"
                  >
                    <p>
                      原：{previous?.label} · 上级{' '}
                      {previous?.parentId ?? '顶层'} ·{' '}
                      {previous?.sources.map(formatSource).join('；') ||
                        '无独立来源'}
                    </p>
                    <p className="mt-2">
                      新：{node.label} · 上级 {node.parentId ?? '顶层'} ·{' '}
                      {node.sources.map(formatSource).join('；') ||
                        '无独立来源'}
                    </p>
                  </div>
                );
              })}
            </details>
          ) : null}
          {diff.conflictsChanged ? (
            <p className="mt-2 text-xs">
              资料冲突记录已变化（{selected?.knowledge.conflicts.length} →{' '}
              {compared?.conflicts.length} 项）。
            </p>
          ) : null}
          {diff.evidenceChanged ? (
            <p className="mt-2 text-xs">
              关键元素记录已变化，可查看起始版本的总结预览。
            </p>
          ) : null}
        </div>
      ) : null}
      {selected ? (
        <article className="border-t pt-4">
          <h3 className="font-semibold">
            起始版本预览 · v{selected.knowledge.version}
          </h3>
          {selected.source === 'knowledge' ? (
            <p className="text-xs text-slate-500">
              旧版保留的知识成果；原课程资料清单不可用。
            </p>
          ) : null}
          <KnowledgeMarkdown>
            {selected.summary ||
              selected.knowledge.nodes
                .map((node) => `## ${node.label}\n\n${node.description}`)
                .join('\n\n')}
          </KnowledgeMarkdown>
        </article>
      ) : null}
    </section>
  );
}
