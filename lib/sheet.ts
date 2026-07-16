import { log } from "@/lib/log";

const CACHE_TTL_MS = 60_000;
// Not a Gemini limit — a self-imposed safety cap. Raised from the original
// 6,000 so a handful of full product spec sheets can fit without silent
// truncation; revisit with a relevance-filtering pass if this stops being enough.
const FAQ_MAX_CHARS = 20_000;
// Google's publish-to-web CSV can lag briefly right after an edit while it
// regenerates; 5s was too tight and caused spurious fetch aborts.
const SHEET_FETCH_TIMEOUT_MS = 8_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

type FaqRow = {
  category: string;
  question: string;
  answer: string;
};

type SheetCache = {
  text: string;
  fetchedAt: number;
};

let cache: SheetCache | null = null;
let inflight: Promise<string> | null = null;

/**
 * Minimal RFC4180-style CSV parser: handles quoted fields containing
 * commas, quotes ("" escape), and embedded newlines. Never uses split(",").
 */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      // ignore, \n handles the line break
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

function buildFaqText(rows: FaqRow[]): string {
  return rows
    .map(
      (row) =>
        `หมวดหมู่: ${row.category || "ทั่วไป"}\nคำถาม: ${row.question}\nคำตอบ: ${row.answer}`
    )
    .join("\n\n");
}

function truncateFaqText(text: string): string {
  if (text.length <= FAQ_MAX_CHARS) {
    return text;
  }
  log.warn("sheet.faq_truncated", {
    originalLength: text.length,
    maxLength: FAQ_MAX_CHARS,
  });
  return text.slice(0, FAQ_MAX_CHARS);
}

async function fetchAndBuildFaqText(): Promise<string> {
  const sheetCsvUrl = requiredEnv("SHEET_CSV_URL");
  const res = await fetch(sheetCsvUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(SHEET_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Sheet fetch failed with status ${res.status}`);
  }
  const csvText = await res.text();
  const table = parseCsv(csvText);
  if (table.length === 0) {
    throw new Error("Sheet CSV is empty");
  }

  const header = table[0].map((h) => h.trim().toLowerCase());
  const findColumn = (aliases: string[]): number => {
    for (const alias of aliases) {
      const idx = header.indexOf(alias);
      if (idx !== -1) {
        return idx;
      }
    }
    return -1;
  };

  const categoryIdx = findColumn(["category", "หมวด", "หมวดหมู่"]);
  const questionIdx = findColumn(["question", "คำถาม"]);
  const answerIdx = findColumn(["answer", "คำตอบ"]);
  const enabledIdx = findColumn(["enabled", "เปิดใช้งาน"]);

  if (questionIdx === -1 || answerIdx === -1) {
    throw new Error("Sheet CSV is missing required columns (question/answer)");
  }

  const rows: FaqRow[] = [];
  for (const line of table.slice(1)) {
    const question = (line[questionIdx] ?? "").trim();
    const answer = (line[answerIdx] ?? "").trim();
    if (!question || !answer) {
      continue;
    }
    if (enabledIdx !== -1) {
      const enabledValue = (line[enabledIdx] ?? "").trim().toUpperCase();
      if (enabledValue === "FALSE") {
        continue;
      }
    }
    const category = categoryIdx !== -1 ? (line[categoryIdx] ?? "").trim() : "";
    rows.push({ category, question, answer });
  }

  if (rows.length === 0) {
    throw new Error("Sheet CSV has no usable FAQ rows");
  }

  return truncateFaqText(buildFaqText(rows));
}

/**
 * Returns FAQ text formatted for the Gemini prompt, using an in-memory
 * cache (60s TTL). On fetch failure, falls back to stale cache if any
 * exists; otherwise the error is thrown to the caller (webhook must
 * reply with DEFAULT_REPLY in that case).
 */
export async function getFaqText(): Promise<string> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.text;
  }

  if (inflight) {
    return inflight;
  }

  inflight = fetchAndBuildFaqText()
    .then((text) => {
      cache = { text, fetchedAt: Date.now() };
      return text;
    })
    .catch((error: unknown) => {
      log.error("sheet.fetch_failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
      if (cache) {
        return cache.text;
      }
      throw error;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
