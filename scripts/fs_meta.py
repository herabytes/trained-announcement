import sys,re,json,html,urllib.request
out=[]
for p in open(sys.argv[1]).read().split():
    u="https://freesound.org"+p
    try:
        h=urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=30).read().decode()
    except Exception as e:
        continue
    t=re.search(r'og:audio:title" content="([^"]*)"',h)
    lic=re.search(r'creativecommons.org/(publicdomain/zero/1.0|licenses/[a-z-]+(?:/[0-9.]+)?)',h)
    pv=re.search(r'https://cdn.freesound.org/previews/[^"]*-hq\.mp3',h)
    d=re.search(r'"duration":\s*([0-9.]+)',h) or re.search(r'itemprop="duration"[^>]*>([^<]*)',h)
    desc=re.search(r'name="description" content="([^"]*)"',h)
    out.append(dict(path=p,url=u,title=html.unescape(t.group(1)) if t else "",lic=lic.group(1) if lic else "?",prev=pv.group(0) if pv else "",dur=d.group(1) if d else "",desc=html.unescape(desc.group(1))[:200] if desc else ""))
json.dump(out,open(sys.argv[2],"w"),indent=1)
for o in out: print(o["path"],"|",o["title"],"|",o["lic"],"|",o["dur"],"|",o["desc"][:110])
