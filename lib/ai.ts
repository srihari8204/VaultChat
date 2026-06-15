// lib/ai.ts — client helpers for the real on-prem AI (Ollama via the backend).
// Replaces the canned/pattern-matched responses the AI screens used to fake.

import { api } from './api';

export interface AiChatTurn { role: 'user' | 'assistant'; content: string }

/** Free-form chat with the assistant (Aria). Throws on AI-unavailable (503). */
export async function aiChat(message: string, history: AiChatTurn[] = []): Promise<string> {
  const r = await api<{ reply: string }>('/ai/chat', {
    method: 'POST',
    json: { message, history: history.slice(-10) },
  });
  return (r?.reply || '').trim();
}

export type AiTask = 'summarize' | 'suggest' | 'translate' | 'tone' | 'grammar' | 'shorten';

/** Run an in-chat helper task over some text. Throws on AI-unavailable (503). */
export async function aiAssist(task: AiTask, text: string): Promise<string> {
  const r = await api<{ result: string }>('/ai/assist', {
    method: 'POST',
    json: { task, text },
  });
  return (r?.result || '').trim();
}
