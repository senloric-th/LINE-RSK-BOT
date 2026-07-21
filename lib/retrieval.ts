import { getClient } from "@/lib/gemini";
import {
  getFaqRows,
  getFaqText,
  buildFaqText,
  truncateFaqText,
  type FaqRow,
} from "@/lib/sheet";
import { log } from "@/lib/log";

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;
// Defensive chunk size, kept under the Gemini API's batch-embed item cap.
const EMBED_ROW_BATCH_SIZE = 90;
const EMBED_ROWS_TIMEOUT_MS = 5_000;
const EMBED_QUESTION_TIMEOUT_MS = 5_000;
const MAX_QUESTION_CHARS = 2000;
// How many FAQ rows to hand to Gemini per question, regardless of how many
// rows exist in the sheet — keeps prompt size (and thus latency/cost) flat
// as the product catalog grows. Generous enough that a two-product
// comparison question ("Elevit กับ Menevit ต่างกันยังไง") still surfaces
// both products' rows together, since each product spans 2 rows.
const TOP_K = 12;

type ScoredRow = { row: FaqRow; vector: number[] };
type EmbeddingsCache = { fingerprint: string; entries: ScoredRow[] };

let embeddingsCache: EmbeddingsCache | null = null;
let inflightRowEmbeddings: Promise<ScoredRow[]> | null = null;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Mirrors the per-row line format in sheet.ts's buildFaqText, so what gets
// searched over matches exactly what Gemini eventually reads.
function rowToEmbeddingText(row: FaqRow): string {
  return `หมวดหมู่: ${row.category || "ทั่วไป"}\nคำถาม: ${row.question}\nคำตอบ: ${row.answer}`;
}

function buildFingerprint(rows: FaqRow[]): string {
  return rows.map((r) => `${r.category}|${r.question}|${r.answer}`).join("\n");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedBatch(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
  timeoutMs: number
): Promise<number[][]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await getClient().models.embedContent({
      model: EMBEDDING_MODEL,
      contents: texts,
      config: {
        taskType,
        outputDimensionality: EMBEDDING_DIMENSIONS,
        abortSignal: controller.signal,
      },
    });

    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== texts.length) {
      throw new Error(
        `embedContent returned ${embeddings.length} embeddings for ${texts.length} inputs`
      );
    }

    return embeddings.map((embedding) => {
      if (!embedding.values) {
        throw new Error("embedContent returned an embedding with no values");
      }
      return embedding.values;
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function computeRowEmbeddings(rows: FaqRow[]): Promise<ScoredRow[]> {
  const chunks = chunk(rows, EMBED_ROW_BATCH_SIZE);
  const chunkVectors = await Promise.all(
    chunks.map((chunkRows) =>
      embedBatch(
        chunkRows.map(rowToEmbeddingText),
        "RETRIEVAL_DOCUMENT",
        EMBED_ROWS_TIMEOUT_MS
      )
    )
  );

  const entries: ScoredRow[] = [];
  chunks.forEach((chunkRows, chunkIndex) => {
    const vectors = chunkVectors[chunkIndex];
    chunkRows.forEach((row, rowIndex) => {
      entries.push({ row, vector: vectors[rowIndex] });
    });
  });
  return entries;
}

// Dedupes concurrent row-embedding requests the same way sheet.ts dedupes
// concurrent sheet fetches, and caches the result keyed on row content so
// a 60s sheet-cache refresh that finds identical content skips re-embedding.
async function getRowEmbeddings(
  rows: FaqRow[],
  fingerprint: string
): Promise<ScoredRow[]> {
  if (inflightRowEmbeddings) {
    return inflightRowEmbeddings;
  }

  inflightRowEmbeddings = computeRowEmbeddings(rows)
    .then((entries) => {
      embeddingsCache = { fingerprint, entries };
      return entries;
    })
    .finally(() => {
      inflightRowEmbeddings = null;
    });

  return inflightRowEmbeddings;
}

export async function embedQuestion(question: string): Promise<number[]> {
  const trimmed = question.trim().slice(0, MAX_QUESTION_CHARS);
  const [vector] = await embedBatch(
    [trimmed],
    "RETRIEVAL_QUERY",
    EMBED_QUESTION_TIMEOUT_MS
  );
  return vector;
}

export function selectTopKRows(
  entries: ScoredRow[],
  questionVector: number[],
  k: number
): FaqRow[] {
  return entries
    .map((entry) => ({
      row: entry.row,
      score: cosineSimilarity(entry.vector, questionVector),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((entry) => entry.row);
}

/**
 * Returns FAQ text scoped to the rows most relevant to `question`, instead
 * of the entire sheet — keeps prompt size roughly constant as the product
 * catalog grows. Degrades gracefully on any embedding failure: stale
 * embeddings if available, otherwise the full (truncated) FAQ text exactly
 * as before this feature existed. Never worse than the pre-retrieval
 * behavior.
 */
export async function getRelevantFaqText(question: string): Promise<string> {
  const rows = await getFaqRows();
  const fingerprint = buildFingerprint(rows);
  const cachedEntries =
    embeddingsCache?.fingerprint === fingerprint ? embeddingsCache.entries : null;

  const [entriesResult, questionResult] = await Promise.allSettled([
    cachedEntries ? Promise.resolve(cachedEntries) : getRowEmbeddings(rows, fingerprint),
    embedQuestion(question),
  ]);

  let entries: ScoredRow[] | null = null;
  let mode: "topk" | "stale_embeddings" | "full_text_fallback" = "topk";

  if (entriesResult.status === "fulfilled") {
    entries = entriesResult.value;
  } else {
    log.warn("retrieval.embed_rows_failed", {
      message:
        entriesResult.reason instanceof Error
          ? entriesResult.reason.message
          : "Unknown error",
    });
    if (embeddingsCache) {
      entries = embeddingsCache.entries;
      mode = "stale_embeddings";
    }
  }

  if (questionResult.status === "rejected") {
    log.warn("retrieval.embed_question_failed", {
      message:
        questionResult.reason instanceof Error
          ? questionResult.reason.message
          : "Unknown error",
    });
  }

  if (!entries || questionResult.status === "rejected") {
    mode = "full_text_fallback";
    const text = await getFaqText();
    log.info("retrieval.completed", {
      mode,
      totalRows: rows.length,
      textLength: text.length,
    });
    return text;
  }

  const topRows = selectTopKRows(entries, questionResult.value, TOP_K);
  const text = truncateFaqText(buildFaqText(topRows));

  log.info("retrieval.completed", {
    mode,
    totalRows: rows.length,
    selectedRows: topRows.length,
    textLength: text.length,
  });

  return text;
}
