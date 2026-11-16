/**
* lib/ziwei/dataset-lookup —— v4 数据集（datasets/v4.0-13d）按盘查解读
*
* 数据集是 674,976 张盘的现成解读库：每行一个命盘，key 为
* "YYYY-MM-DD-<时辰 0-11>-<male|female>"，c 里是 13 个维度的完整文字
* （overview / personality / love / career / wealth / health / family /
* children / move / friends / home / spirit / parents），合计约 28,000 字。
*
* 用法：AI 解读时先按 birthInfo 查到这张盘的底本，再把底本（或按问题
* 筛选后的相关维度）放进提示词，让模型有据可依，而不是凭空编造。
* 查不到（年份超出 1950-2026、文件缺失等）时返回 null，调用方直接
* 走纯 AI 解读，不要因此报错。
*
* 查找用 grep -m1 扫当年约 700MB 的.jsonl，最坏约 1.4 秒，命中后
* 内存里缓存最近 20 条，同一次对话追问不再重复扫盘。
*/
import { execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type DatasetTopicKey =
| 'overview' | 'personality' | 'love' | 'career' | 'wealth' | 'health'
| 'family' | 'children' | 'move' | 'friends' | 'home' | 'spirit' | 'parents';

export const DATASET_TOPICS: DatasetTopicKey[] = [
'overview', 'personality', 'love', 'career', 'wealth', 'health',
'family', 'children', 'move', 'friends', 'home', 'spirit', 'parents',
];

export interface DatasetReading {
key: string;
mainStar: string;
/** 13 个维度的完整文字 */
contents: Partial<Record<DatasetTopicKey, string>>;
}

const cache = new Map<string, DatasetReading>();

function datasetFile(year: number): string | null {
const file = path.join(
process.cwd(),
'datasets', 'v4.0-13d', 'extracted', `year-${year}.jsonl`,
);
return fs.existsSync(file)? file: null;
}

function grepOne(pattern: string, file: string): Promise<string | null> {
return new Promise((resolve) => {
execFile('grep', ['-m1', '-F', pattern, file], { timeout: 10000, maxBuffer: 1024 * 1024 * 4},
(err, stdout) => {
if (err) return resolve(null);
const line = stdout.trim();
resolve(line? line: null);
});
});
}

export async function lookupDatasetReading(birthInfo: unknown): Promise<DatasetReading | null> {
const b = birthInfo as { year?: unknown; month?: unknown; day?: unknown; hour?: unknown; gender?: unknown} | null;
if (!b) return null;
const year = Number(b.year);
const month = Number(b.month);
const day = Number(b.day);
const hour = Number(b.hour);
const gender = b.gender === 'female'? 'female': b.gender === 'male'? 'male': null;
if (!Number.isInteger(year) || year < 1950 || year > 2026) return null;
if (!Number.isInteger(month) || month < 1 || month > 12) return null;
if (!Number.isInteger(day) || day < 1 || day > 31) return null;
if (!Number.isInteger(hour) || hour < 0 || hour > 11) return null;
if (!gender) return null;

const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}-${hour}-${gender}`;
const hit = cache.get(key);
if (hit) return hit;

const file = datasetFile(year);
if (!file) return null;
const line = await grepOne(`"k":"${key}"`, file);
if (!line) return null;
try {
const parsed = JSON.parse(line) as { ms?: string; c?: Record<string, string>};
const reading: DatasetReading = {
key,
mainStar: typeof parsed.ms === 'string'? parsed.ms: '',
contents: (parsed.c?? {}) as Partial<Record<DatasetTopicKey, string>>,
};
cache.set(key, reading);
if (cache.size > 20) {
const first = cache.keys().next().value;
if (first) cache.delete(first);
}
return reading;
} catch {
return null;
}
}

/** 按用户问题选出最相关的维度；问得泛时默认只看总览和性格。 */
export function topicsForQuestion(question: string): DatasetTopicKey[] {
const q = question || '';
const found: DatasetTopicKey[] = [];
const add = (...ts: DatasetTopicKey[]) => {
for (const t of ts) if (!found.includes(t)) found.push(t);
};
if (/感情|婚姻|爱情|桃花|伴侣|夫妻/.test(q)) add('love');
if (/事业|职业|工作|升职|创业/.test(q)) add('career');
if (/财|钱|收入|投资|理财/.test(q)) add('wealth');
if (/健康|身体|疾病|养生/.test(q)) add('health');
if (/子女|孩子|生育/.test(q)) add('children');
if (/父母|长辈|家庭|兄弟|姐妹/.test(q)) add('parents', 'family');
if (/迁移|外出|搬家|出国|旅游/.test(q)) add('move');
if (/朋友|人际|贵人|交友/.test(q)) add('friends');
if (/房产|房子|田宅|不动产/.test(q)) add('home');
if (/精神|福德|信仰|心态|情绪/.test(q)) add('spirit');
if (/性格|个性|脾气/.test(q)) add('personality');
return found;
}

/**
* 把底本拼成提示词：总览+性格全文，问题相关的维度全文，
* 其余维度各取前 300 字摘要。全文约 28,000 字，拼完控制在 9,000 字内。
*/
export function formatDatasetReference(reading: DatasetReading, question: string): string {
const labels: Record<DatasetTopicKey, string> = {
overview: '命格总览', personality: '性格特质', love: '感情婚姻',
career: '事业职业', wealth: '财富运势', health: '健康状况',
family: '兄弟合伙', children: '子女缘分', move: '迁移外出',
friends: '人际贵人', home: '田宅不动产', spirit: '精神福德', parents: '父母长辈',
};
const full: DatasetTopicKey[] = ['overview', 'personality',...topicsForQuestion(question)];
const parts: string[] = [];
for (const topic of DATASET_TOPICS) {
const text = reading.contents[topic];
if (!text) continue;
const body = full.includes(topic)? text: text.slice(0, 300) + (text.length > 300? '……（摘要）': '');
parts.push('[' + labels[topic] + ']\n' + body);
}
return [
`参考底本：数据集 v4.0-13d 中命盘 ${reading.key} 的现成解读` +
(reading.mainStar? `（主星 ${reading.mainStar}）`: '') + '。',
...parts,
].join('\n\n');
}
