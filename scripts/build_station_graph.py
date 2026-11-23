"""Download the UK station-adjacency graph from Wikidata ONCE -> data/station_graph.json.

Wikidata links each station to the stations next to it on the line ("adjacent station", P197).
That's a graph: stations are nodes, adjacency links are edges. route_hint.py then finds a route
with a shortest-path search over it, offline, with no LLM and no API key.

    uv run scripts/build_station_graph.py
"""
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "station_graph.json"
QUERY = """
SELECT ?s ?sLabel ?a WHERE {
  ?s wdt:P17 wd:Q145; wdt:P197 ?a; rdfs:label ?sLabel.
  FILTER(LANG(?sLabel) = "en")
}"""   # rdfs:label + FILTER, not the label SERVICE: the SERVICE version times out on the server


def clean(label: str) -> str:
    """'Plockton railway station' -> 'Plockton'."""
    return re.sub(r"\s+(railway|train|rail)\s+station$", "", label, flags=re.I).strip()


def main():
    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": QUERY, "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": "station-graph-builder/0.1 (research script)"})
    body = urllib.request.urlopen(req, timeout=120).read().decode("utf-8")
    rows = json.loads(body, strict=False)["results"]["bindings"]   # strict=False: some labels hold raw tabs

    names, edges = {}, set()
    for r in rows:
        s, a = r["s"]["value"].rsplit("/", 1)[1], r["a"]["value"].rsplit("/", 1)[1]
        names[s] = clean(r["sLabel"]["value"])
        edges.add(tuple(sorted((s, a))))          # adjacency is two-way
    edges = [e for e in edges if e[0] in names and e[1] in names]   # keep UK-to-UK links only
    OUT.write_text(json.dumps({"source": "Wikidata P197 (adjacent station), UK", "names": names,
                               "edges": sorted(edges)}, ensure_ascii=False), encoding="utf-8")
    print(f"{len(names)} stations, {len(edges)} links -> {OUT}")


if __name__ == "__main__":
    main()
