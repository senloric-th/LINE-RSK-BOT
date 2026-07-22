import { getClient } from "@/lib/conversation";
import { log } from "@/lib/log";

// LINE redelivers an event (same webhookEventId) if our server doesn't
// respond with 2xx in time. Redeliveries land within minutes, not hours —
// this only needs to outlive that window, not double as a long-term log.
const CLAIM_TTL_SECONDS = 300;

/**
 * Atomically claims a LINE webhookEventId so a redelivered event is only
 * processed (and replied to) once. Returns true the first time an event
 * ID is seen — caller should proceed. Returns false if already claimed —
 * caller should skip it silently.
 *
 * Fails open: if Redis is unreachable, returns true (process normally)
 * rather than risk silently dropping a customer's only message.
 */
export async function claimWebhookEvent(eventId: string): Promise<boolean> {
  const key = `webhook-event:${eventId}`;
  try {
    const claimed = await getClient().setnx(key, 1);
    if (claimed !== 1) {
      return false;
    }
    await getClient().expire(key, CLAIM_TTL_SECONDS);
    return true;
  } catch (error: unknown) {
    log.warn("webhook_dedup.claim_failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return true;
  }
}
