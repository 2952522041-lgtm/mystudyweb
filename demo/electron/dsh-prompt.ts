import type { DshCompletionRequest } from './dsh-types.ts';

/** Stable text first, inline images last. Never pass a URL or a filesystem path. */
export function dshPrompt(request: DshCompletionRequest) {
  const images: Array<{
    type: 'image';
    data: string;
    mimeType: 'image/png' | 'image/jpeg';
  }> = [];
  const textContent = (
    content: DshCompletionRequest['messages'][number]['content'],
  ) =>
    typeof content === 'string'
      ? content
      : content.map((part) => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(
            part.image_url.url,
          )!;
          images.push({
            type: 'image',
            mimeType: match[1] as 'image/png' | 'image/jpeg',
            data: match[2],
          });
          return { type: 'image', attachment: images.length };
        });
  const system = request.messages
    .filter((m) => m.role === 'system')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'),
    )
    .join('\n');
  const messages = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: textContent(m.content) }));
  return {
    system,
    blocks: [
      { type: 'text' as const, text: JSON.stringify({ messages }) },
      ...images,
    ],
  };
}
