# 公开版数据集底本方案（草稿，2026-11-16）

## 结论
- 52GB 解压版不能搬上 Vercel；155MB 的 zstd 压缩包可以，但要在服务端按需解压。
- 按月切 gzip 不可行：1990 年 12 个月 gzip 合计 190MB（zstd 全年才 2MB），gzip 窗口太小，抓不到跨记录的重复。
- 整年 zstd 一次性解压：@mongodb-js/zstd 实测 3.5 秒、峰值内存 812MB，Vercel Hobby（1GB、10 秒）太悬，需要 Pro 超时/内存，或单独的查解读服务。
- 去重也不救命：1990/2000/2010/2020 四年总览去重后仍有 17,716 条不同文本，且每年新增约 4,400 条，77 年约 34 万条不同总览。

## 定案（2026-11-16）：线上按需从 GitHub Release 拉当年 zstd 流式解压
- 不用 Vercel Pro，也不用单独搭服务：77 个 year-YYYY.jsonl.zst（每份约 2MB）
  本来就公开放在上游仓库的 v4.0-13d Release 里，SHA256 和本地下载的文件一致。
- 实现：lib/ziwei/dataset-remote.ts。按生日年份下载当年那一份，Node 内置
  zlib.createZstdDecompress 流式解压边解边扫，找到 `"k":"YYYY-MM-DD-<时辰>-<性别>"`
  那一行就停；命中后缓存记录（最近 20 条）和当年压缩包（最近 2 年）。
- 实测（本机 1.5 核共享 CPU，最坏情况）：年末 1990-12-31-11-female 约 4.0 秒、
  年中约 2.4 秒、年初 15 毫秒（压缩包已缓存）、缓存命中 0 毫秒，峰值内存约 300MB；
  Vercel 的 CPU 比这台机器快，线上只会更快。超时预算 8 秒，超时或失败都返回
  null 走纯 AI 解读，不报错。
- 前提：Node >= 22.15 才有 zlib zstd 流式解压，package.json 已加 engines node >=22.15。
- 本地版：lib/ziwei/dataset-lookup.ts，grep 查当年文件，最坏 1.4 秒，缓存后 0 毫秒。
  /api/interpret 先查本地，没有再走线上这条路。
