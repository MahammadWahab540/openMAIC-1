import { createLogger } from '@/lib/logger';

const log = createLogger('Webhooks');

export type WebhookEvent = 
  | 'generation.started' 
  | 'generation.progress' 
  | 'generation.completed' 
  | 'generation.failed';

export async function sendWebhook(
  url: string | undefined,
  event: WebhookEvent,
  payload: any
) {
  if (!url) return;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenMAIC-Event': event,
      },
      body: JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        data: payload
      }),
    });

    if (!response.ok) {
      log.error(`Webhook delivery failed for ${event} to ${url}: ${response.statusText}`);
    } else {
      log.info(`Webhook ${event} delivered to ${url}`);
    }
  } catch (error) {
    log.error(`Webhook delivery error for ${event} to ${url}:`, error);
  }
}
