'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { capturePageSelection, selectionToolbarPosition, type SelectionSnapshot } from '@/lib/selection';
import { createProviderForSettings, type ReaderSettings, usingRemoteProvider } from '@/lib/reader-cache';
import { translateSelection } from '@/lib/selection-translation';
import { describeTranslationError, TranslationError } from '@/lib/translation';

interface ToolbarProps {
  rootRef: RefObject<HTMLElement | null>;
  settings: ReaderSettings;
  targetLanguage: string;
  onExplain: (selection: SelectionSnapshot) => void;
}

export function SelectionToolbar(props: ToolbarProps) {
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const readSelection = () => {
      const current = window.getSelection();
      if (current?.rangeCount && hostRef.current?.contains(current.getRangeAt(0).commonAncestorContainer)) return;
      const root = props.rootRef.current;
      const layers = Array.from(root?.querySelectorAll<HTMLElement>('.pdf-text-layer[data-page-number]') ?? []);
      const snapshot = capturePageSelection(current, layers.map((layer) => ({
        pageNumber: Number(layer.dataset.pageNumber), container: layer, bounds: layer.getBoundingClientRect(),
      })));
      const bounds = root?.getBoundingClientRect();
      // Hidden/virtualized or scrolled-away selections must not leave a detached toolbar.
      if (!snapshot || !bounds || snapshot.box.y + snapshot.box.h < bounds.top ||
          snapshot.box.y > bounds.bottom || snapshot.box.x + snapshot.box.w < bounds.left ||
          snapshot.box.x > bounds.right) {
        setSelection(null);
      } else {
        setSelection(snapshot);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      }
    };
    const dismissOutside = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setSelection(null);
    };
    document.addEventListener('selectionchange', readSelection);
    document.addEventListener('pointerup', readSelection);
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape);
    window.addEventListener('scroll', readSelection, true);
    window.addEventListener('resize', readSelection);
    return () => {
      document.removeEventListener('selectionchange', readSelection);
      document.removeEventListener('pointerup', readSelection);
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape);
      window.removeEventListener('scroll', readSelection, true);
      window.removeEventListener('resize', readSelection);
    };
  }, [props.rootRef]);

  if (!selection) return null;
  return <SelectionActions key={`${selection.pageNumber}:${selection.text}:${props.targetLanguage}`}
    {...props} selection={selection} hostRef={hostRef} onClose={() => {
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    }} />;
}

function SelectionActions({ selection, settings, targetLanguage, onExplain, onClose, hostRef }: ToolbarProps & {
  selection: SelectionSnapshot;
  onClose: () => void;
  hostRef: RefObject<HTMLDivElement | null>;
}) {
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [size, setSize] = useState({ width: 360, height: 90 });
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setSize({ width: node.offsetWidth, height: node.offsetHeight }));
    observer.observe(node);
    return () => observer.disconnect();
  }, [hostRef]);

  const translate = async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError('');
    setResult('');
    try {
      const translated = await translateSelection(createProviderForSettings(settings), selection, targetLanguage, {
        signal: controller.signal,
        onPartial: (paragraphs) => {
          if (!controller.signal.aborted) setResult(paragraphs.join('\n\n'));
        },
      });
      if (!controller.signal.aborted) setResult(translated.paragraphs.join('\n\n'));
    } catch (failure) {
      if (!controller.signal.aborted) {
        setResult('');
        setError(failure instanceof TranslationError ? `[${failure.code}] ${failure.message}` : describeTranslationError('unknown'));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <div ref={hostRef} className="fixed z-50 w-[360px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-lg"
      style={selectionToolbarPosition(selection.box, { width: window.innerWidth, height: window.innerHeight }, size)}
      role="dialog" aria-label={`第 ${selection.pageNumber} 页选段操作`}
      onPointerDown={(event) => {
        if ((event.target as Element).closest('button')) event.preventDefault();
      }}>
      <p className="truncate px-1 text-xs text-slate-500" title={selection.text}>第 {selection.pageNumber} 页 · {selection.text}</p>
      <div className="mt-1 flex flex-wrap gap-1" role="toolbar" aria-label="选中文字操作">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void translate()}>{busy ? '翻译中…' : '翻译'}</Button>
        <Button size="sm" variant="ghost" onClick={() => { onExplain(selection); onClose(); }}>解释</Button>
        <Button size="sm" variant="ghost" onClick={async () => {
          try { await navigator.clipboard.writeText(selection.text); setCopied(true); }
          catch { setError('复制失败，请使用 Ctrl+C 或系统复制菜单。'); }
        }}>{copied ? '已复制' : '复制'}</Button>
        <Button size="sm" variant="ghost" aria-label="关闭选段操作" onClick={onClose}>关闭</Button>
      </div>
      {!usingRemoteProvider(settings) ? <p className="px-1 text-xs text-amber-700">演示模式 · 配置翻译服务后可获取真实译文</p> : null}
      {result ? <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-sm leading-6" aria-label="选段译文">{result}</p> : null}
      {error ? <p className="mt-2 text-xs text-rose-700" role="alert">{error}</p> : null}
    </div>
  );
}
