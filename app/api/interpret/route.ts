/**
 * POST /api/interpret — AI 解读接口（开源版原本缺失，由本机自行实现）
 *
 * 前端约定（components/InsightPanel.tsx, components/ChatPanel.tsx）：
 * - 请求体：{ chart: ZiweiChart, messages: [{ role: 'user'|'assistant', content: string }] }
 * - 成功时返回 SSE 流，每行：data: {"delta":{"text":"..."}} ，结束时：data: [DONE]
 * - 接口不存在时返回 404，前端会显示“开源版不含 AI 解读接口”；
 *   Key 未配置时同样返回 404，让前端给出同样的提示。
 *
 * 后端：DeepSeek（OpenAI 兼容协议）
 * - base URL: https://api.deepseek.com/v1 （可用 DEEPSEEK_BASE_URL 覆盖）
 * - model: DEEPSEEK_MODEL，未设置时默认 deepseek-chat
 * - key 来源（按顺序）：DEEPSEEK_API_KEY 环境变量；否则向本机 authd
 *   换取 custom.deepseek 连接的 surrogate（hsurr:...），由出口代理在发往
 *   api.deepseek.com 时换成真实 Key。真实 Key 从不写进文件、日志或代码。
 */

import net from 'node:net';
import { lookupDatasetReading, formatDatasetReference } from '@/lib/ziwei/dataset-lookup';
import { lookupDatasetReadingRemote } from '@/lib/ziwei/dataset-remote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 向 authd 换取 custom.deepseek 的 surrogate，失败返回 null。 */
async function getDeepSeekSurrogate(): Promise<string | null> {
  const socketPath = process.env.JARVIS_AUTHD_SOCK || '/run/hatch/auth/authd.sock';
  const body = JSON.stringify({ name: 'custom.deepseek' });
  const req =
    `POST /v1/credentials/surrogate HTTP/1.1\r\n` +
    `Host: authd.local\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    let out = '';
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, 5000);
    sock.on('data', (d) => {
      out += d.toString();
    });
    sock.on('end', () => {
      clearTimeout(timer);
      try {
        const json = out.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        const parsed = JSON.parse(json);
        const entry = parsed.credentials?.find((c: { name: string }) => c.name === 'access_token');
        resolve(typeof entry?.surrogate === 'string' ? entry.surrogate : null);
      } catch {
        resolve(null);
      }
    });
    sock.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    sock.write(req);
  });
}

const SYSTEM_PROMPT = `你是倪海厦《天纪》体系的紫微斗数命理师，负责根据用户提供的命盘解读问题。
- 用中文回答，语言通俗、可操作，避免宿命论式的绝对断言；涉及健康、婚姻、投资等重要决定时，提醒仅供参考。
- 严格依据提供的命盘数据（宫位、主星、亮度、四化、大限）作答，不要编造命盘里没有的星曜、宫位或四化。
- 如果提供了「参考底本」（数据集 v4.0-13d 中这张盘的现成解读），优先以底本为准：结论和定性要与底本一致，不要编造与底本矛盾的内容；底本没有覆盖的问题，再结合命盘推理，并说明这是推断。
- 命理专名保留拼音+英文，例如 Ziwei 紫微、Tianji 天机、Taiyang 太阳、Hua Lu 化禄、Hua Ji 化忌、Ming Gong 命宫、Shen Gong 身宫。
- 先给结论，再给依据（哪一宫、哪颗星、化什么），最后给 1-3 条具体建议。
- 回答不要过长，重点问题讲透即可。`;

function summarizeChart(chart: unknown): string {
  try {
    const s = JSON.stringify(chart);
    // 命盘 JSON 通常只有几 KB，直接原样传给模型最准确；超过 12000 字符时截断防超限
    return s.length > 12000 ? s.slice(0, 12000) + '\n...[chart truncated]' : s;
  } catch {
    return String(chart ?? '');
  }
}

export async function POST(req: Request) {
  const envKey = process.env.DEEPSEEK_API_KEY;
  const apiKey =
    envKey && envKey !== 'your-deepseek-api-key' ? envKey : await getDeepSeekSurrogate();
  if (!apiKey) {
    return Response.json(
      { error: 'api-missing', message: 'DEEPSEEK_API_KEY 未配置' },
      { status: 404 },
    );
  }

  let body: { chart?: unknown; messages?: { role: string; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid-json' }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return Response.json({ error: 'messages-required' }, { status: 400 });
  }

  // 参考底本：先查本地解压版数据集（本机有），没有再按需从 GitHub Release
  // 拉当年 zstd 流式解压查（线上 Vercel 用这条路）；查不到就走纯 AI 解读，不报错
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const chartObj = body.chart as { birthInfo?: unknown } | null;
  const birthInfo = chartObj?.birthInfo ?? null;
  const reading =
    (await lookupDatasetReading(birthInfo).catch(() => null)) ??
    (await lookupDatasetReadingRemote(birthInfo).catch(() => null));
  const reference = reading ? formatDatasetReference(reading, lastUser?.content ?? '') : null;

  const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.7,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'system',
          content: `命盘数据（JSON）：\n${summarizeChart(body.chart)}`,
        },
        ...(reference ? [{ role: 'system' as const, content: reference }] : []),
        ...messages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      ],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return Response.json(
      { error: 'upstream-failed', status: upstream.status, detail: text.slice(0, 500) },
      { status: 502 },
    );
  }

  // 把 DeepSeek 的 OpenAI 兼容 SSE 转成前端要的格式：data: {"delta":{"text":"..."}}
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              const text: string = json.choices?.[0]?.delta?.content ?? '';
              if (text) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ delta: { text } })}\n\n`),
                );
              }
            } catch {
              // 跳过无法解析的心跳/空行
            }
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
