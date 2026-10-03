'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Follow incoming content only while the reader remains near the latest answer. */
export function useChatScroll(conversationKey: string, content: unknown, partial?: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [latestState, setLatestState] = useState({ key: conversationKey, show: false });
  const jumpToLatest = useCallback(() => {
    followingRef.current = true;
    setLatestState({ key: conversationKey, show: false });
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [conversationKey]);
  useLayoutEffect(() => {
    followingRef.current = true;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [conversationKey]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (followingRef.current && element) element.scrollTop = element.scrollHeight;
  }, [content, partial]);
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 64;
    followingRef.current = nearBottom;
    setLatestState({ key: conversationKey, show: !nearBottom });
  }, [conversationKey]);
  return { scrollRef, showLatest: latestState.key === conversationKey && latestState.show, onScroll, jumpToLatest };
}
