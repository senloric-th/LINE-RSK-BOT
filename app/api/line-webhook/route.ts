import { NextRequest, NextResponse } from "next/server";
import {
  Client,
  validateSignature,
  type WebhookEvent,
  type TextEventMessage,
} from "@line/bot-sdk";
import { getFaqText } from "@/lib/sheet";
import { generateReply, DEFAULT_REPLY } from "@/lib/gemini";

export const runtime = "nodejs";

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

function isTextMessageEvent(
  event: WebhookEvent
): event is WebhookEvent & { type: "message"; message: TextEventMessage } {
  return event.type === "message" && event.message.type === "text";
}

async function handleEvent(
  event: WebhookEvent,
  lineClient: Client
): Promise<void> {
  if (!isTextMessageEvent(event)) {
    return;
  }

  const replyToken = event.replyToken;
  const question = event.message.text;

  let reply: string;
  try {
    const faqText = await getFaqText();
    reply = await generateReply({ question, faqText });
  } catch (error: unknown) {
    console.error("Failed to build reply for message event", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    reply = DEFAULT_REPLY;
  }

  try {
    await lineClient.replyMessage(replyToken, {
      type: "text",
      text: reply,
    });
  } catch (error: unknown) {
    console.error("Failed to send LINE reply", {
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
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let events: WebhookEvent[];
  try {
    const body = JSON.parse(rawBody) as { events?: WebhookEvent[] };
    events = body.events ?? [];
  } catch (error: unknown) {
    console.error("Invalid webhook request body", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return new NextResponse("Invalid request body", { status: 400 });
  }

  await Promise.allSettled(events.map((event) => handleEvent(event, client)));

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
