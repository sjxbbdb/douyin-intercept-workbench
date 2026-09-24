# 参考实现配置示例

pipeline_request.json（节选）：

    {
      videoKeyword:      怎么创业
      commentKeywords:   求带 求方法 怎么做
      commentMatchMode:  phrase        // char | segment | phrase（推荐）
      maxVideos:         12
      dateStart:         2026-07-25
      dateEnd:           2026-09-25
      skipNotes:         true          // 排除图文帖（评论区是浮层）
      autoReply:         true,  autoReplyText: 关注我
      autoDm:            true,  autoDmText:    你好
    }

环境变量（节选）：

    REPLY_GAP_MIN_MS=45000    REPLY_GAP_MAX_MS=80000    REPLY_MAX_PER_RUN=5
    DM_GAP_MS=35000           DM_MAX_PER_RUN=10
    DM_AUTO_SEND=0            # 退回「预填 + 人工点发送」
