/**
 * lib/ziwei/dataset-remote —— 线上版数据集底本：按需从 GitHub Release 拉取当年 zstd 查解读
 *
 * 背景：52GB 解压版搬不上 Vercel，但 77 个 year-YYYY.jsonl.zst 压缩包
 * （每份约 2MB）本来就公开放在上游仓库的 v4.0-13d Release 里。
 * 线上查底本时，按生日年份下载当年那一份，流式 zstd 解压边解边扫，
 * 找到 `"k":"YYYY-MM-DD-<时辰>-<性别>"` 那一行就停，不用整年解完。
 * 实测（本机 1.5 核共享 CPU）：年中约 2.4 秒、年末最坏约 5.2 秒，
 * 峰值内存约 265MB，Vercel Hobby（1GB、10 秒）够用；命中后缓存，
 * 同一实例同一年份不再重复下载。
 *
 * 任何一步失败（无网络、超时、Node 太旧没有 zlib zstd、年份超出范围）
 * 都返回 null，调用方直接走纯 AI 解读，不要因此报错。
 * 超时预算 8 秒：给后面的 DeepSeek 调用留时间。
 */

import zlib from 'node:zlib';
import { Readable, type Transform } from 'node:stream';
import type { DatasetReading, DatasetTopicKey } from './dataset-lookup';

// Node >= 22.15 才有 zlib.createZstdDecompress；项目里的 @types/node
// 版本较旧，这里不直接从 'node:zlib' 导入类型，运行时再判断有没有。
const createZstdDecompress = (
  zlib as unknown as { createZstdDecompress?: () => Transform }
).createZstdDecompress;

const RELEASE_BASE =
  process.env.DATASET_RELEASE_BASE_URL ||
  'https://github.com/Renhuai123/ziwei-doushu/releases/download/v4.0-13d';
const LOOKUP_TIMEOUT_MS = 8000;

const recordCache = new Map<string, DatasetReading>();
const yearBufferCache = new Map<number, Buffer>();

function parseBirthInfo(birthInfo: unknown): { year: number; key: string } | null {
  const b = birthInfo as {
    year?: unknown;
    month?: unknown;
    day?: unknown;
    hour?: unknown;
    gender?: unknown;
  } | null;
  if (!b) return null;
  const year = Number(b.year);
  const month = Number(b.month);
  const day = Number(b.day);
  const hour = Number(b.hour);
  const gender = b.gender === 'female' ? 'female' : b.gender === 'male' ? 'male' : null;
  if (!Number.isInteger(year) || year < 1950 || year > 2026) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 11) return null;
  if (!gender) return null;
  const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}-${hour}-${gender}`;
  return { year, key };
}

async function downloadYear(year: number, signal: AbortSignal): Promise<Buffer | null> {
  const cached = yearBufferCache.get(year);
  if (cached) return cached;
  const res = await fetch(`${RELEASE_BASE}/year-${year}.jsonl.zst`, { signal });
  if (!res.ok || !res.body) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) return null;
  yearBufferCache.set(year, buf);
  if (yearBufferCache.size > 2) {
    const first = yearBufferCache.keys().next().value;
    if (first !== undefined) yearBufferCache.delete(first);
  }
  return buf;
}

/** 在已解压的字节流里找 `"k":"<key>"` 所在行，找到返回该行 JSON 文本。
 * 只保留 64 字节跨块接缝，不做大块拼接：每行约 28KB、key 在行首，
 * 找到 key 后再把该行收完整就停。 */
async function scanStream(
  input: NodeJS.ReadableStream,
  key: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (typeof createZstdDecompress !== 'function') return null;
  const needle = Buffer.from(`"k":"${key}"`);
  const decompressed = (input as Readable).pipe(createZstdDecompress());
  let tail: Buffer = Buffer.alloc(0);
  let lineBuf: Buffer | null = null;
  try {
    for await (const chunk of decompressed as AsyncIterable<Buffer>) {
      if (signal.aborted) return null;
      const piece = chunk as Buffer;
      if (lineBuf) {
        const end = piece.indexOf(0x0a);
        if (end !== -1) {
          return Buffer.concat([lineBuf, piece.subarray(0, end)]).toString('utf8');
        }
        lineBuf = Buffer.concat([lineBuf, piece]);
        continue;
      }
      const hay = tail.length === 0 ? piece : Buffer.concat([tail, piece]);
      const idx = hay.indexOf(needle);
      if (idx !== -1) {
        // 行以 {"k": 开头，needle 前一位就是 {；若正好顶到块头则补一个 {
        const start = idx > 0 ? idx - 1 : 0;
        const head = idx > 0 ? hay.subarray(start) : Buffer.concat([Buffer.from('{'), hay]);
        const end = head.indexOf(0x0a);
        if (end !== -1) return head.subarray(0, end).toString('utf8');
        lineBuf = head;
        continue;
      }
      tail = hay.length > 64 ? hay.subarray(hay.length - 64) : hay;
    }
  } catch {
    return null;
  } finally {
    decompressed.destroy();
  }
  return null;
}

export async function lookupDatasetReadingRemote(
  birthInfo: unknown,
): Promise<DatasetReading | null> {
  const parsed = parseBirthInfo(birthInfo);
  if (!parsed) return null;
  const { year, key } = parsed;
  const hit = recordCache.get(key);
  if (hit) return hit;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const compressed = await downloadYear(year, controller.signal);
    if (!compressed) return null;
    const line = await scanStream(
      Readable.from(compressed),
      key,
      controller.signal,
    );
    if (!line) return null;
    const data = JSON.parse(line) as { ms?: string; c?: Record<string, string> };
    const reading: DatasetReading = {
      key,
      mainStar: typeof data.ms === 'string' ? data.ms : '',
      contents: (data.c ?? {}) as Partial<Record<DatasetTopicKey, string>>,
    };
    recordCache.set(key, reading);
    if (recordCache.size > 20) {
      const first = recordCache.keys().next().value;
      if (first) recordCache.delete(first);
    }
    return reading;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
