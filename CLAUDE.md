# CLAUDE.md — LINE Bot ร้านรักสุขภาพ

## What we're building

LINE Official Account bot ให้ร้านรักสุขภาพ (สินค้าสุขภาพ/แม่และเด็ก) ตอบลูกค้า 24 ชม.
ด้วย Gemini อ่าน FAQ จาก Google Sheet (public CSV) แล้วตอบในนามแอดมินร้าน · คำถามที่เข้าข่าย
ต้องคุยกับคนจริง (ร้องเรียน, ขอแอดมิน, เปรียบเทียบสินค้าเชิงสุขภาพ) จะ handoff ไปแจ้งแอดมินแทน

## Stack — locked

- Next.js 14 App Router + TypeScript (strict)
- `@line/bot-sdk` (legacy `Client`/`WebhookEvent`/`validateSignature` API, ไม่ใช่ `messagingApi` namespace ใหม่)
- `@google/genai` (`GoogleGenAI`), model `gemini-3.5-flash`; embedding รุ่น `gemini-embedding-001`
  (ใช้คัดแถว FAQ ที่เกี่ยวข้องก่อนส่งเข้า Gemini แทนส่งทั้งชีต — ดู `lib/retrieval.ts`)
- Google Sheet เผยแพร่เป็น Public CSV — รองรับหัวตารางทั้งไทย (`หมวด/คำถาม/คำตอบ`) และอังกฤษ
- `@upstash/redis` (`Redis.fromEnv()`) — เก็บประวัติสนทนาสั้นๆ ต่อลูกค้า (ดู `lib/conversation.ts`)
  provision ผ่าน Vercel Marketplace (`vercel install upstash/upstash-kv`)
- Vercel Hobby (`maxDuration = 30`)

## Repo conventions

- `app/api/line-webhook/route.ts` — POST handler: verify signature (raw body ก่อน parse) →
  Smart Handoff check → sheet+gemini → reply (มี retry 3 ครั้ง)
- `lib/sheet.ts` — fetch + CSV parse (รองรับ quote/comma/newline ในเซลล์ ห้ามใช้ `split(",")`) +
  cache 60s + กันดึงซ้ำพร้อมกัน (in-flight dedupe) + fallback ใช้ cache เก่าเมื่อดึงไม่ได้
- `lib/gemini.ts` — system prompt (role/guardrails/reasoning_protocol/out_of_scope_triggers/
  output_format) + timeout 20s (Gemini ปฏิเสธ deadline ต่ำกว่า 10s) + `DEFAULT_REPLY`/`HANDOFF_REPLY`
- `lib/handoff.ts` — keyword-based Smart Handoff trigger detection (`shouldHandoff`) + `HANDOFF_REPLY`
  ที่ใช้ร่วมกับ system prompt ของ Gemini (สองชั้น: keyword ตรงๆ + Gemini เข้าใจเจตนา)
- `lib/retrieval.ts` — embed ทุกแถวใน FAQ (cache ตาม fingerprint ของเนื้อหา ไม่ embed ซ้ำถ้าชีต
  ไม่เปลี่ยน) + embed คำถามลูกค้า + cosine similarity เลือก top-12 แถวที่เกี่ยวข้องสุด ก่อนส่งเข้า
  Gemini — ถ้า embedding ล้มเหลว fallback ไปใช้ `getFaqText()` (ทั้งชีต) แบบเดิม ไม่มีทางพัง
- `lib/conversation.ts` — เก็บ/ดึงบทสนทนาล่าสุด (`getRecentTurns`/`appendTurn`) ต่อ LINE userId
  ใน Redis เก็บ 4 turn ล่าสุด หมดอายุ 30 นาทีนับจากข้อความล่าสุด (sliding TTL) — error ใดๆ จาก
  Redis จะ catch แล้วคืนค่าว่าง/เงียบ ไม่มีทาง throw ขึ้นไปทำให้ webhook พัง
- `lib/log.ts` — structured JSON logging helper (`log.info/warn/error`)

## Env vars (Vercel)

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `GEMINI_API_KEY`
- `SHEET_CSV_URL`
- `ADMIN_GROUP_ID` (Smart Handoff push target · optional — ไม่ตั้งก็ทำงานได้ปกติ แค่ไม่แจ้งแอดมิน)
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Upstash Redis ผ่าน Vercel Marketplace — `Redis.fromEnv()`
  หาเจอเองอัตโนมัติ ไม่ต้องตั้งชื่อ env var เองในโค้ด)

## Don'ts

- ❌ Hardcode token/key ใดๆ — ใช้ env vars เท่านั้น
- ❌ ข้ามการตรวจ signature — ต้องตรวจกับ raw body ก่อน `JSON.parse` เสมอ
- ❌ ลด `temperature` ต่ำกว่า 1.0 หรือ `maxOutputTokens` ต่ำกว่า 1024 (Gemini 3.x นับ thinking
  tokens รวมกับ output — ต่ำกว่านี้เสี่ยงโดนตัดกลางประโยค)
- ❌ ตั้ง Gemini timeout ต่ำกว่า ~10s — Google เองปฏิเสธ deadline ที่สั้นกว่านั้น
- ❌ Cache FAQ นานกว่า 60s — เจ้าของร้านแก้ Sheet แล้วต้องเห็นผลไว
- ❌ ให้บอทเปรียบเทียบสินค้าหรือชี้ว่าตัวไหนดีกว่ากัน — เป็นความเสี่ยงด้านการโฆษณาผลิตภัณฑ์
  สุขภาพ (อย.) ต้อง handoff ไปแอดมินเสมอ
- ❌ Log ข้อความเต็มของลูกค้า, prompt เต็ม, หรือค่า env/token ใดๆ — log เฉพาะ metadata
  (การ push แจ้งแอดมินผ่าน LINE group ไม่ใช่ log จึงใส่ข้อความลูกค้าได้ตามปกติ)
- ❌ ให้ `lib/conversation.ts` throw error ขึ้นไปหา caller — ทุก error จาก Redis ต้อง catch
  แล้ว fallback เป็นค่าว่าง/เงียบ (บอทต้องตอบได้แม้ Redis ล่ม เหมือนตอนที่ยังไม่มีฟีเจอร์นี้)
