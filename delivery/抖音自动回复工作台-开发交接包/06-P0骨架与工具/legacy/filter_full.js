
const fs = require("fs");
const KEYWORDS = ["求带", "带带我", "求带带", "求带飞", "带带吧", "带带我呗", "带带我一起"];
const IGNORED_KEYWORD_CHARS = new Set(Array.from(" \t\r\n,，、;；|｜/\\。.!！?？:：\"'“”‘’()[]{}<>《》【】（）-_=+~`@#$%^&*"));

function extractKeywordChars(value) {
  return [...new Set(Array.from(String(value || "").toLowerCase()).filter((ch) => !IGNORED_KEYWORD_CHARS.has(ch)))];
}

function matchesAnyKeywordChar(text, keywordChars) {
  const source = String(text || "").toLowerCase();
  return keywordChars.some((ch) => source.includes(ch));
}

const KEYWORD_CHARS = extractKeywordChars(KEYWORDS.join(","));
const raw = JSON.parse(fs.readFileSync("D:\\deep seek\\crawl_full.json", "utf8"));
const existing = JSON.parse(fs.readFileSync("D:\\deep seek\\filtered_comments.json", "utf8"));
const existingIds = new Set(existing.map((c) => String(c.commentId)));
const existingTexts = new Set(existing.map((c) => (c.user || "") + "|" + (c.text || "")));

let added = 0;
const seen = new Set();
for (const r of raw) {
  for (const c of r.comments || []) {
    if (seen.has(c.cid)) continue;
    seen.add(c.cid);
    const t = c.text || "";
    if (!matchesAnyKeywordChar(t, KEYWORD_CHARS)) continue;
    if (existingIds.has(String(c.cid))) continue;
    const key = (c.user || "") + "|" + t;
    if (existingTexts.has(key)) continue;
    existingTexts.add(key);
    existingIds.add(String(c.cid));
    added++;
    existing.push({
      commentId: c.cid, awemeId: c.awemeId, replyId: "",
      user: c.user, text: t,
      likeCount: c.digg || 0, createTime: c.createTime,
      time: c.createTime ? new Date(c.createTime * 1000).toLocaleDateString("zh-CN") : "",
      videoTitle: (r.title || "").replace(/\s+/g, " ").slice(0, 40),
      region: c.ip_label || "",
      source: "full-crawl",
    });
  }
}
fs.writeFileSync("D:\\deep seek\\filtered_comments.json", JSON.stringify(existing, null, 2), "utf8");
console.log("FILTER_DONE added:", added, "| total now:", existing.length, "| any-char:", KEYWORD_CHARS.join("/"));
