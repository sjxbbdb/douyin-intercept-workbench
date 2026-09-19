"""Visible DOM adapter for public live-room comments.

The selectors are deliberately isolated in ``douyin_selectors.py``.  This
adapter never reads cookies or private websocket payloads.  It is suitable for
offline fixture validation; live platform verification remains pending.
"""
import json

import douyin_selectors as S


def _js_array(values):
    return json.dumps(list(values), ensure_ascii=False)


COLLECT_JS = """(function(){
  function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}
  function all(sels){var out=[];for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);
    for(var j=0;j<ns.length;j++)out.push(ns[j]);}return out;}
  var items=all(ITEMS),contents=CONTENTS,authors=AUTHORS,out=[];
  function first(e,sels){for(var i=0;i<sels.length;i++){var n=e.querySelector(sels[i]);if(n)return n;}}
  for(var i=0;i<items.length;i++){var e=items[i];if(!vis(e))continue;
    var c=first(e,contents),a=first(e,authors),text=((c||e).innerText||'').trim();
    if(!text)continue;
    out.push({id:e.getAttribute('data-comment-id')||e.id||'',authorId:e.getAttribute('data-author-id')||
      (a&&a.getAttribute('data-author-id'))||'',authorName:((a||{}).innerText||'').trim(),text:text});}
  return out;
})()"""


def build_collect_expression():
    return (COLLECT_JS.replace("ITEMS", _js_array(S.LIVE_COMMENT_ITEMS))
            .replace("CONTENTS", _js_array(S.LIVE_COMMENT_CONTENT))
            .replace("AUTHORS", _js_array(S.LIVE_COMMENT_AUTHORS)))


def collect_events(cdp, max_items=100):
    rows = cdp.eval_json(build_collect_expression()) or []
    return [row for row in rows[:max_items] if isinstance(row, dict) and row.get("text")]


COMPOSER_JS = """(function(){
  function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}
  var sels=EDITORS,found=[];
  for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);
    for(var j=0;j<ns.length;j++){var e=ns[j];if(vis(e)&&found.indexOf(e)<0)found.push(e);}}
  if(found.length!==1)return {found:false,reason:found.length?'ambiguous_public_composer':'composer_not_found',count:found.length};
  var r=found[0].getBoundingClientRect();
  return {found:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
          text:(found[0].innerText||found[0].value||'')};
})()"""


def find_composer(cdp):
    return cdp.eval_json(COMPOSER_JS.replace("EDITORS", _js_array(S.LIVE_PUBLIC_EDITORS))) or {"found": False}


SEND_JS = """(function(){
  function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}
  var sels=BUTTONS,found=[];
  for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);
    for(var j=0;j<ns.length;j++){var e=ns[j];if(vis(e)&&found.indexOf(e)<0)found.push(e);}}
  if(found.length!==1)return {found:false,reason:found.length?'ambiguous_public_send_button':'send_button_not_found',count:found.length};
  var r=found[0].getBoundingClientRect();
  return {found:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
          disabled:!!(found[0].disabled||found[0].getAttribute('aria-disabled')==='true')};
})()"""


def find_send_button(cdp):
    return cdp.eval_json(SEND_JS.replace("BUTTONS", _js_array(S.LIVE_PUBLIC_SEND_BUTTONS))) or {"found": False}
