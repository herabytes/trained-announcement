import sys,re,json,html,os,urllib.request
lst,outdir,meta=sys.argv[1:4]
os.makedirs(outdir,exist_ok=False)
res=[]
for p in open(lst).read().split():
    u="https://freesound.org/people/"+p+"/"
    rq=lambda x:urllib.request.urlopen(urllib.request.Request(x,headers={"User-Agent":"Mozilla/5.0"}),timeout=60).read()
    h=rq(u).decode()
    t=re.search(r'og:audio:title" content="([^"]*)"',h)
    lic=re.search(r'creativecommons.org/(publicdomain/zero/1.0|licenses/[a-z-]+(?:/[0-9.]+)?)',h)
    pv=re.search(r'https://cdn.freesound.org/previews/[^"]*-hq\.mp3',h)
    d=re.findall(r'\d+:\d\d\.\d+',h)
    i=h.find('DescriptionSection')
    desc=html.unescape(re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',h[i:i+1500])))[19:300].split('Sound illegal')[0].strip()
    sid=p.rstrip('/').split('/')[-1]
    fn=os.path.join(outdir,"fs%s.mp3"%sid)
    open(fn,"wb").write(rq(pv.group(0)))
    res.append(dict(id="fs"+sid,url=u,title=html.unescape(t.group(1)),lic=lic.group(1),dur=d[0] if d else "",desc=desc,file=fn.replace("\\","/"),size=os.path.getsize(fn)))
json.dump(res,open(meta,"w"),indent=1)
print(sum(r["size"] for r in res)/1e6,"MB",len(res))
