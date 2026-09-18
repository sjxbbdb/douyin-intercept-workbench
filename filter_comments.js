
const fs = require("fs");
const state = JSON.parse(fs.readFileSync("D:\\deep seek\\crawl_state.json", "utf8"));
const KEYWORDS = ["求带", "带带我", "求带带", "求带飞", "带带吧"];
const IGNORED_KEYWORD_CHARS = new Set(Array.from(" \t\r\n,，、;；|｜/\\。.!！?？:：\"'“”‘’()[]{}<>《》【】（）-_=+~`@#$%^&*"));

function extractKeywordChars(value) {
  return [...new Set(Array.from(String(value || "").toLowerCase()).filter((ch) => !IGNORED_KEYWORD_CHARS.has(ch)))];
}

function matchesAnyKeywordChar(text, keywordChars) {
  const source = String(text || "").toLowerCase();
  return keywordChars.some((ch) => source.includes(ch));
}

const KEYWORD_CHARS = extractKeywordChars(KEYWORDS.join(","));

const matches = [];
for (const r of state.results || []) {
  for (const c of r.comments || []) {
    const t = c.text || "";
    if (matchesAnyKeywordChar(t, KEYWORD_CHARS)) {
      matches.push({
        commentId: c.cid, awemeId: c.awemeId, replyId: "",
        user: c.user, text: t,
        likeCount: c.digg || 0,
        createTime: c.createTime || 0,
        time: c.createTime ? new Date(c.createTime * 1000).toLocaleDateString("zh-CN") : "",
        videoTitle: (r.title || "").slice(0, 60),
      });
    }
  }
}
console.log("FILTERED_MATCHES:", matches.length);
console.log("MATCH_MODE: keyword any char ->", KEYWORD_CHARS.join("/"));
matches.slice(0, 20).forEach((m, i) => console.log((i + 1) + ". [" + m.videoTitle.slice(0, 25) + "] @" + m.user + ": " + m.text.slice(0, 60)));
fs.writeFileSync("D:\\deep seek\\filtered_comments.json", JSON.stringify(matches, null, 2), "utf8");
console.log("saved to filtered_comments.json");
