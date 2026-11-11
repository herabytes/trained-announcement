import json,csv
A=json.load(open("data/raw/_fs_ann_meta.json"))
H="id,title,url,source,licence,duration,human_or_automated,accent_region,noise_level,funny_unusual,downloaded".split(",")
LIC={"publicdomain/zero/1.0":"CC0","licenses/by/3.0":"CC-BY 3.0","licenses/by/4.0":"CC-BY 4.0","licenses/by-nc/4.0":"CC-BY-NC 4.0"}
# per-id judgement: (human/automated, accent, noise, funny)
J={
"fs65806":("unverified (onboard ScotRail; likely guard/driver)","Scottish, Fife-Edinburgh (from description)","med","no"),
"fs65803":("unverified (onboard ScotRail)","Scottish, Fife (description)","med","no"),
"fs65805":("unverified (onboard ScotRail; long clip)","Scottish (description)","med","no"),
"fs106210":("mixed: automated PA + human guard (per description)","South England, Portsmouth line","med","no"),
"fs208039":("unverified (station, London Overground; probably automated)","London","low-med","no"),
"fs277754":("unverified (onboard, doors+announcement)","Home Counties, Letchworth (description)","med","no"),
"fs40156":("unverified (onboard 2002; probably human guard)","Highlands Scottish (description)","med-high","no"),
"fs267700":("human (driver, held at red signal)","London Tube driver","med-high","no"),
"fs96502":("human (male, delays, station)","London Liverpool St","med","no"),
"fs95874":("human (female, signal failure, station)","London Liverpool St","med","no"),
"fs55857":("probably human (station)","Yorkshire, Doncaster (description)","low-med","no"),
"fs62314":("probably human (station, 3 s)","Yorkshire, Doncaster","low","no"),
"fs646162":("unverified; smartphone recording (Oppo Reno 2, 2022)","Scottish (title/desc)","unknown","no"),
"fs44974":("unverified (station, probably Victoria)","South England","med","no"),
"fs408177":("unverified (onboard tannoy)","South England, Portsmouth-Southampton","med-high","no"),
"fs43945":("human (station announcer 'Phil')","Devon, Exeter St Davids (description)","low-med","no"),
"fs43948":("human (station announcer, Euston)","London Euston","low-med","no"),
"fs44007":("human (station announcer 'Celia')","Plymouth (description)","low-med","no"),
"fs44008":("human (station announcer; 'received pronunciation' per description)","London Paddington","low-med","no"),
"fs83789":("human (station announcer, iPhone 3G recording; signaller interrupts)","Yorkshire, Doncaster","med","mildly (interruption)"),
"fs317554":("unverified (station, Northern service)","Yorkshire, Doncaster","low-med","no"),
"fs506795":("unverified (ScotRail station announcer)","Scottish","low","no"),
"fs638928":("unverified (onboard ambience + announcement)","unknown","med","no"),
"fs533718":("guard + automated (per description), 5:40 long","South England (Southern, London Bridge)","low (little passenger noise)","no"),
}
rows=[]
for r in A:
    j=J[r["id"]]
    rows.append([r["id"],r["title"],r["url"],"Freesound",LIC[r["lic"]],r["dur"],j[0],j[1]+" [guessed from title/desc]",j[2],j[3],r["file"]])
def ex(i,t,u,d,h,a,f="no",lic="CC-BY-NC 4.0"):
    rows.append([i,t,u,"Freesound",lic,d,h,a+" [guessed from title]","unknown",f,"no"])
ex("fs131600","North Camp Railway Station PA Announcements","https://freesound.org/people/Liam125/sounds/131600/","1:05","automated (GWR station PA)","Hampshire",lic="CC0")
ex("fs141200","Safety Announcements at Ash Railway Station","https://freesound.org/people/Liam125/sounds/141200/","1:43","automated","Surrey",lic="CC0")
ex("fs327942","London Underground - Mind The Gap","https://freesound.org/people/kwahmah_02/sounds/327942/","short","automated","London",lic="CC-BY 3.0")
ex("fs267704","London Underground - service update","https://freesound.org/people/kwahmah_02/sounds/267704/","?","unverified","London",lic="CC-BY 3.0")
ex("fs105274","Eurostar final call (St Pancras)","https://freesound.org/people/SubUnit_FieldRec/sounds/105274/","?","unverified","London")
ex("fs96503","Liverpool station London customer service","https://freesound.org/people/SubUnit_FieldRec/sounds/96503/","?","unverified","London")
def yt(i,t,u,src,h,a,f,lic="all rights reserved (YouTube std licence unless stated)"):
    rows.append([i,t,u,src,lic,"?",h,a+" [guessed from title]","unknown (real passenger recording)",f,"no"])
yt("yt1","Hilarious train announcements on a northern train to Manchester (20:12 Leeds-Manchester)","https://www.youtube.com/watch?v=-m5K7PvkuZE","YouTube","human guard","Northern/Yorkshire","yes")
yt("yt2","(HD) Legend South West Trains Guard Funny Announcements","https://www.youtube.com/watch?v=_oSlU-l1vD0","YouTube","human guard","South West England","yes")
yt("yt3","Very Funny Conductor Announcement onboard a train","https://www.youtube.com/watch?v=oTcLY0aGrKk","YouTube","human guard","unknown UK","yes")
yt("yt4","Funny Guard announcement - Mersey Rail","https://www.youtube.com/watch?v=xHwRFIUQ1U0","YouTube","human guard","Merseyside (Scouse likely)","yes")
yt("nf1","Video captures UK train driver making funny announcements (Southern, Belmont-Epsom Downs)","https://www.newsflare.com/video/187653/travel/video-captures-uk-train-driver-making-funny-announcements","Newsflare","human driver","South London/Surrey","yes","licensed footage, commercial")
yt("rf1","Rail Forums 'Funny Guard Announcements' thread (many YouTube links, e.g. Hogwarts guard, GNER Dundee guard)","https://www.railforums.co.uk/threads/funny-guard-announcements.58992/","Forum (link index)","human","various","yes","forum text")
yt("rf2","Rail Forums 'Funny announcements on trains' thread (Southern 'WoOoOo' driver, Romiley International guard)","https://www.railforums.co.uk/threads/trivia-funny-announcements-on-trains.269338/","Forum (link index)","human","various","yes","forum text")
yt("rf3","Rail Forums 'Humorous Announcements' thread","https://www.railforums.co.uk/threads/humorous-anouncements.127164/","Forum (link index)","human","various","yes","forum text")
yt("bbc1","BBC Sound Effects archive (search 'train announcement', 'tube')","https://sound-effects.bbcrewind.co.uk/","BBC RemArc","unverified","UK","no","RemArc: personal/educational/research only")
with open("data/raw/candidates.csv","w",newline="",encoding="utf-8") as f:
    w=csv.writer(f);w.writerow(H);w.writerows(rows)
print(len(rows),"rows")
md=["| "+" | ".join(H)+" |","|"+"---|"*len(H)]
for r in rows: md.append("| "+" | ".join(str(x).replace("|","/") for x in r)+" |")
open("data/raw/_tableA.md","w",encoding="utf-8").write("\n".join(md))
