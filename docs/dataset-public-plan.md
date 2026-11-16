# 公开版数据集底本方案（草稿，2026-11-16）

## 结论
- 52GB 解压版不能搬上 Vercel；155MB 的 zstd 压缩包可以，但要在服务端按需解压。
- 按月切 gzip 不可行：1990 年 12 个月 gzip 合计 190MB（zstd 全年才 2MB），gzip 窗口太小，抓不到跨记录的重复。
- 整年 zstd 一次性解压：@mongodb-js/zstd 实测 3.5 秒、峰值内存 812MB，Vercel Hobby（1GB、10 秒）太悬，需要 Pro 超时/内存，或单独的查解读服务。
- 去重也不救命：1990/2000/2010/2020 四年总览去重后仍有 17,716 条不同文本，且每年新增约 4,400 条，77 年约 34 万条不同总览。

## 待定
- 等用户接好 Vercel 后，查 Vercel Blob / 函数超时与内存档位，再定：Vercel Pro 直解，还是单独搭一个 1GB 内存的小服务（Fly.io / Railway / VPS）做查解读接口，Vercel 的 /api/interpret 调它。
- 本地版已实现：lib/ziwei/dataset-lookup.ts，grep 查当年文件，最坏 1.4 秒，缓存后 0 毫秒。
