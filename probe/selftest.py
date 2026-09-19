import os, sys, time
for s in ("stdout", "stderr"):
    st = getattr(sys, s, None)
    if st is not None and hasattr(st, "reconfigure"):
        st.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp as cdpmod

port = int(sys.argv[1])
tabs = cdpmod.list_tabs(port)
print("tabs:", len(tabs))
ver = cdpmod._http_json("http://127.0.0.1:%d/json/version" % port)
print("browser:", ver.get("Browser"))
tab = cdpmod.find_page_tab(port)
if not tab:
    print("NO PAGE TAB"); sys.exit(2)
print("page tab:", tab.get("url"))

c = cdpmod.CDP(tab["webSocketDebuggerUrl"], port=port, timeout=20)
for dom in ("Page.enable", "Runtime.enable", "Network.enable"):
    c.call(dom, {}, timeout=10)
print("evaluate 1+1        ->", c.evaluate("1+1"))
print("eval_json object    ->", c.eval_json("({a:1,b:[2,3]})"))
print("eval_json missing   ->", c.eval_json("undefinedThing.foo"))
big = c.evaluate("'x'.repeat(200000)")
print("large payload len   ->", len(big) if big else None, "(64-bit frame len + multi-recv)")
print("navigate            ->", c.call("Page.navigate", {"url": "about:blank"}, timeout=15) is not None)
time.sleep(1)
rec = cdpmod.NetworkRecorder(c, lambda u: "example" in (u or ""))
print("network recorder    -> constructed OK")
c.close()
print("SELFTEST OK")
