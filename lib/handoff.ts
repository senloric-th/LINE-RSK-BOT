const HANDOFF_TRIGGERS = [
  "คุยกับคน",
  "ขอแอดมิน",
  "ขอเจ้าของ",
  "ฟ้อง",
  "ร้องเรียน",
  "ไม่พอใจ",
  "ขายส่ง",
  "wholesale",
  "อยากซื้อจำนวนมาก",
  "franchise",
  "ติดต่อสื่อ",
];

export const HANDOFF_REPLY = "ขอให้แอดมินติดต่อกลับไปนะคะ";

export function shouldHandoff(message: string): boolean {
  const lower = message.toLowerCase();
  return HANDOFF_TRIGGERS.some((trigger) => lower.includes(trigger.toLowerCase()));
}
