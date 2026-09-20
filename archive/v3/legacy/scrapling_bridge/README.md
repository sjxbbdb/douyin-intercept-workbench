# Scrapling 评论清洗桥接

这个目录只处理采集器已经写入本地的评论 JSON，不负责登录、绕过验证、抓取页面或发送消息。

`pipeline.js` 在保存 `pipeline_raw.json` 后自动调用清洗器；`scan_comments.js` 在实时扫描批次合并前调用同一清洗器。原始文件不会被覆盖，便于定位采集问题。

输出文件：

- `pipeline_cleaned.json`：标准化后的完整评论记录。
- `pipeline_cleaning_report.json`：输入、去重、剔除、低价值标记和原因统计。

只有明确的质量信号才会设置 `low_value: true`，例如空正文、缺失必要 ID、异常昵称、纯表情正文、超长正文、异常时间，以及接口明确返回的无头像、无作品或私密账号。

如果接口没有返回头像、作品数或 `sec_uid`，只记录 `qualityFlags`，不会伪造字段，也不会仅因字段未采集就丢弃评论。

首次配置：

```powershell
py -m pip install -r .\requirements-scrapling.txt
```
