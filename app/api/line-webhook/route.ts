import { NextRequest, NextResponse } from "next/server";
import { Client, validateSignature, type WebhookEvent } from "@line/bot-sdk";
import { getRelevantFaqText } from "@/lib/retrieval";
import { generateReply, DEFAULT_REPLY } from "@/lib/gemini";
import { shouldHandoff, HANDOFF_REPLY } from "@/lib/handoff";
import { getRecentTurns, appendTurn } from "@/lib/conversation";
import { log } from "@/lib/log";

// How many of the customer's own recent questions (plus the current one)
// feed the FAQ search step — separate from how much history Gemini sees
// (lib/conversation.ts's MAX_TURNS). A vague follow-up like "อันละเท่าไหร่คะ"
// carries no product name on its own, so retrieval needs this context too,
// not just the generation step.
const RETRIEVAL_CONTEXT_QUESTIONS = 3;

export const runtime = "nodejs";
export const maxDuration = 30;

const REPLY_RETRY_ATTEMPTS = 3;

const NON_TEXT_MESSAGE_REPLY =
  "ขออภัยค่ะ ตอนนี้รักสุขภาพบอทยังไม่สามารถอ่านรูปภาพหรือไฟล์ประเภทนี้ได้ รบกวนลูกค้าพิมพ์ข้อความบอกชื่อสินค้าหรือคำถามที่ต้องการสอบถามแทนนะคะ";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

let lineClient: Client | null = null;
let lineChannelSecret: string | null = null;

function getLineClient(): { client: Client; channelSecret: string } {
  if (!lineClient || !lineChannelSecret) {
    const channelAccessToken = requiredEnv("LINE_CHANNEL_ACCESS_TOKEN");
    lineChannelSecret = requiredEnv("LINE_CHANNEL_SECRET");
    lineClient = new Client({
      channelAccessToken,
      channelSecret: lineChannelSecret,
    });
  }
  return { client: lineClient, channelSecret: lineChannelSecret };
}

async function replyWithRetry(
  client: Client,
  replyToken: string,
  text: string,
  attempts: number
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await client.replyMessage(replyToken, { type: "text", text });
      return;
    } catch (error: unknown) {
      if (i === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
    }
  }
}

async function notifyAdmin(
  client: Client,
  userId: string | undefined,
  userMessage: string
): Promise<void> {
  const adminGroupId = process.env.ADMIN_GROUP_ID;
  if (!adminGroupId) {
    log.warn("handoff.admin_group_not_configured");
    return;
  }
  try {
    await client.pushMessage(adminGroupId, {
      type: "text",
      text: `ลูกค้าต้องการให้แอดมินช่วยดูค่ะ\nUserID: ${userId ?? "unknown"}\nข้อความ: ${userMessage}`,
    });
  } catch (error: unknown) {
    log.error("handoff.notify_failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleEvent(event: WebhookEvent, client: Client): Promise<void> {
  if (event.type === "join") {
    const source = event.source;
    log.info("webhook.bot_joined", {
      sourceType: source.type,
      groupId: source.type === "group" ? source.groupId : undefined,
      roomId: source.type === "room" ? source.roomId : undefined,
    });
    return;
  }

  if (event.type !== "message") {
    return;
  }

  if (event.message.type !== "text") {
    try {
      await replyWithRetry(
        client,
        event.replyToken,
        NON_TEXT_MESSAGE_REPLY,
        REPLY_RETRY_ATTEMPTS
      );
    } catch (error: unknown) {
      log.error("webhook.line_reply_failed", {
        eventType: event.type,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
    return;
  }

  const replyToken = event.replyToken;
  const question = event.message.text;
  const userId = event.source.userId;
  const startTime = Date.now();

  const history = userId ? await getRecentTurns(userId) : [];

  let reply: string;
  if (shouldHandoff(question)) {
    reply = HANDOFF_REPLY;
  } else {
    try {
      const retrievalQuery = [...history.map((t) => t.question), question]
        .slice(-RETRIEVAL_CONTEXT_QUESTIONS)
        .join("\n");
      const faqText = await getRelevantFaqText(retrievalQuery);
      reply = await generateReply({ question, faqText, history });
    } catch (error: unknown) {
      log.error("webhook.reply_build_failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
      reply = DEFAULT_REPLY;
    }
  }

  // Any path (keyword pre-check or the model's own reasoning) that lands on
  // the handoff reply should page a human, so the check happens post-hoc
  // on the final text rather than only on the pre-check branch above.
  if (reply === HANDOFF_REPLY) {
    await notifyAdmin(client, userId, question);
  }

  if (userId) {
    await appendTurn(userId, question, reply);
  }

  try {
    await replyWithRetry(client, replyToken, reply, REPLY_RETRY_ATTEMPTS);
    log.info("webhook.reply_sent", {
      userId,
      latencyMs: Date.now() - startTime,
      replyLength: reply.length,
      handoff: reply === HANDOFF_REPLY,
    });
  } catch (error: unknown) {
    log.error("webhook.line_reply_failed", {
      eventType: event.type,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const { client, channelSecret } = getLineClient();

  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");

  if (!signature || !validateSignature(rawBody, channelSecret, signature)) {
    log.warn("webhook.invalid_signature");
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let events: WebhookEvent[];
  try {
    const body = JSON.parse(rawBody) as { events?: WebhookEvent[] };
    events = body.events ?? [];
  } catch (error: unknown) {
    log.error("webhook.invalid_body", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return new NextResponse("Invalid request body", { status: 400 });
  }

  await Promise.allSettled(events.map((event) => handleEvent(event, client)));

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
