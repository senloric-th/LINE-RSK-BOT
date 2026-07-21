import { Redis } from "@upstash/redis";
import { log } from "@/lib/log";

// Sliding window: resets every time a customer sends a new message, so an
// active conversation never expires mid-chat, but stale threads don't
// linger and bleed context into an unrelated later visit.
const TTL_SECONDS = 1800;
// Kept short — this only needs to carry enough context for follow-up
// questions like "อันละเท่าไหร่คะ" to resolve, not a full transcript.
const MAX_TURNS = 4;

export type Turn = {
  question: string;
  reply: string;
};

let client: Redis | null = null;
function getClient(): Redis {
  if (!client) {
    client = Redis.fromEnv();
  }
  return client;
}

function key(userId: string): string {
  return `conv:${userId}`;
}

/**
 * Returns the customer's recent conversation turns, oldest first.
 * Never throws — on any Redis error, returns an empty history so the
 * caller degrades to today's stateless behavior instead of failing.
 */
export async function getRecentTurns(userId: string): Promise<Turn[]> {
  try {
    const turns = await getClient().get<Turn[]>(key(userId));
    return turns ?? [];
  } catch (error: unknown) {
    log.warn("conversation.read_failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return [];
  }
}

/**
 * Appends a turn and trims to the last MAX_TURNS, resetting the TTL.
 * Never throws — a failed write just means the next message won't have
 * this turn's context; it doesn't affect the reply already sent.
 */
export async function appendTurn(
  userId: string,
  question: string,
  reply: string
): Promise<void> {
  try {
    const existing = await getRecentTurns(userId);
    const updated = [...existing, { question, reply }].slice(-MAX_TURNS);
    await getClient().set(key(userId), updated, { ex: TTL_SECONDS });
  } catch (error: unknown) {
    log.warn("conversation.write_failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
