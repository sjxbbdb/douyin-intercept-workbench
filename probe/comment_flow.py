# -*- coding: utf-8 -*-
"""评论区的批次流程：关键词匹配评论 -> 逐条公开回复 -> 确认后私信。

架构依据：
  · images/11-comment-area-business 固定流程一/二（采集 -> 关键词、排除词与去重 ->
    目标批次 -> 公开回复 -> 私信）
  · images/12-live-room-business —— 直播间已经把「事件队列 -> 批次 ->
    冻结计划 -> 两阶段发送」跑通了，评论区此前只有【单条】发送路径，
    没有批次，于是「评论批次 → 逐条公开回复 → 确认后私信」这条流程接不起来。

为什么直接复用 live_flow.LiveQueue 的机制：
  · 事件去重、批次窗口、计划冻结、按公开状态派发私信候选 —— 两边语义完全一样；
  · 差别只有两点，都在下面显式处理：
      1) 库文件独立（评论事件不该和直播间事件混在一个库里，多账号下也不能串）；
      2) 话术形状 —— 直播间是【每个观众一套】话术，评论区是宿主给【一套】通用话术，
         由 build_scripts() 展开成 freeze_plan 需要的按事件索引的形状。
"""
import os
import time

import live_flow

# 评论批次的有效期：评论不像弹幕那样转瞬即逝，给足宿主逐条处理的时间。
WINDOW_DEFAULT = 3600
MAX_BATCH = live_flow.MAX_BATCH
DB_NAME = "comment_flow.sqlite3"


class CommentFlowError(live_flow.LiveFlowError):
    """评论批次流程的边界错误（沿用直播间那套错误码语义）。"""


class CommentQueue(live_flow.LiveQueue):
    """评论事件队列：语义与 LiveQueue 完全一致，只换一个独立的库文件。"""

    def __init__(self, state_dir, account_scope, capacity=live_flow.CAPACITY_DEFAULT, clock=None):
        # 不调用 super().__init__：它会先按 live_flow.sqlite3 建库。
        # 评论事件和直播间事件必须分库，否则多账号/多渠道的状态会互相污染。
        self.state_dir = os.path.abspath(os.fspath(state_dir))
        os.makedirs(self.state_dir, exist_ok=True)
        self.account_scope = str(account_scope)
        self.capacity = max(1, int(capacity))
        self.clock = clock or time.time
        self.path = os.path.join(self.state_dir, DB_NAME)
        self._init_db()


def build_scripts(events, public_text, private_text):
    """把宿主给的【一套】话术展开成 freeze_plan 需要的按事件索引的形状。

    校验不在这里做：长度上下限交给 freeze_plan 用同一份 policy 判定，
    避免两处规则各写一遍、日后漂移。
    """
    return {str(event.get("id")): {"publicText": public_text, "privateText": private_text}
            for event in events}


def batch_summary(batch):
    """批次对外摘要（与直播间 live_plan 返回的 batch 字段保持一致）。"""
    summary = {key: batch[key] for key in
               ("batchId", "createdAt", "expiresAt", "expiredCount", "frozen", "status")}
    summary["filter"] = batch.get("filter") or {}
    return summary


def script_error(value, label):
    """宿主话术的边界校验：必须是字符串且有内容。返回 '' 表示通过。"""
    if not isinstance(value, str) or not value.strip():
        return label + "_missing"
    return ""
