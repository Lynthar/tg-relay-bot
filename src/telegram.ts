import type { TgMessage, TgResponse } from './types';

const API_BASE = 'https://api.telegram.org/bot';

function url(token: string, method: string): string {
  return `${API_BASE}${token}/${method}`;
}

export class TelegramError extends Error {
  constructor(
    public method: string,
    public detail: string,
  ) {
    super(`telegram ${method}: ${detail}`);
    this.name = 'TelegramError';
  }
}

async function call<T>(token: string, method: string, body: unknown): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url(token, method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new TelegramError(method, 'network');
  }
  let data: TgResponse<T>;
  try {
    data = (await resp.json()) as TgResponse<T>;
  } catch {
    throw new TelegramError(method, `non_json_status_${resp.status}`);
  }
  if (!data.ok || data.result === undefined) {
    throw new TelegramError(method, data.description ?? `code_${data.error_code ?? 'unknown'}`);
  }
  return data.result;
}

export interface TgMe {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

export function getMe(token: string): Promise<TgMe> {
  return call<TgMe>(token, 'getMe', {});
}

export function sendMessage(
  token: string,
  params: {
    chat_id: string | number;
    text: string;
    parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
    disable_web_page_preview?: boolean;
  },
): Promise<TgMessage> {
  return call<TgMessage>(token, 'sendMessage', params);
}

export function copyMessage(
  token: string,
  params: { chat_id: string | number; from_chat_id: string | number; message_id: number },
): Promise<{ message_id: number }> {
  return call<{ message_id: number }>(token, 'copyMessage', params);
}

export function forwardMessage(
  token: string,
  params: { chat_id: string | number; from_chat_id: string | number; message_id: number },
): Promise<TgMessage> {
  return call<TgMessage>(token, 'forwardMessage', params);
}

export function setWebhook(
  token: string,
  params: { url: string; secret_token?: string },
): Promise<true> {
  return call<true>(token, 'setWebhook', params);
}

export function deleteWebhook(token: string): Promise<true> {
  return call<true>(token, 'deleteWebhook', {});
}
