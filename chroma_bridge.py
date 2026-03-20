
import sys, json, os
try:
    import chromadb
    from chromadb.utils import embedding_functions
except ImportError:
    print(json.dumps({"error": "chromadb not installed. Run: pip install chromadb sentence-transformers"}))
    sys.exit(1)

KB_DIR    = os.path.expanduser("~/.attar-code/knowledge")
INDEX_DIR = os.path.join(KB_DIR, ".index")
os.makedirs(INDEX_DIR, exist_ok=True)

try:
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")
except Exception:
    ef = embedding_functions.DefaultEmbeddingFunction()

client = chromadb.PersistentClient(path=INDEX_DIR)
try:
    col = client.get_or_create_collection("knowledge", embedding_function=ef)
except ValueError:
    client.delete_collection("knowledge")
    col = client.get_or_create_collection("knowledge", embedding_function=ef)
cmd    = sys.argv[1] if len(sys.argv) > 1 else ""

if cmd == "add":
    doc_id  = sys.argv[2]
    content = sys.stdin.read()
    meta    = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    words   = content.split()
    size    = 256
    overlap = 50
    step    = size - overlap
    chunks  = [" ".join(words[i:i+size]) for i in range(0, len(words), step) if " ".join(words[i:i+size]).strip()]
    if not chunks:
        print(json.dumps({"added": 0}))
        sys.exit(0)
    ids   = [f"{doc_id}_chunk_{i}" for i in range(len(chunks))]
    metas = [{**meta, "chunk": i, "doc_id": doc_id} for i in range(len(chunks))]
    col.upsert(documents=chunks, ids=ids, metadatas=metas)
    print(json.dumps({"added": len(chunks), "doc_id": doc_id}))

elif cmd == "search":
    query   = sys.argv[2]
    n       = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    cnt     = col.count()
    if cnt == 0:
        print(json.dumps({"results": [], "note": "knowledge base is empty"}))
        sys.exit(0)
    results = col.query(query_texts=[query], n_results=min(n, cnt))
    docs    = results.get("documents", [[]])[0]
    metas   = results.get("metadatas", [[]])[0]
    dists   = results.get("distances",  [[]])[0]
    out     = [{"rank": i+1, "text": d, "source": m.get("source","?"), "filename": m.get("filename",""), "score": round(1-dist,3)} for i,(d,m,dist) in enumerate(zip(docs,metas,dists))]
    print(json.dumps({"results": out}))

elif cmd == "list":
    all_items = col.get()
    metas     = all_items.get("metadatas", [])
    seen, out = set(), []
    for m in metas:
        did = m.get("doc_id","")
        if did not in seen:
            seen.add(did)
            out.append({"doc_id": did, "filename": m.get("filename",""), "source": m.get("source",""), "type": m.get("type","")})
    print(json.dumps({"docs": out, "total_chunks": len(metas)}))

elif cmd == "delete":
    doc_id  = sys.argv[2]
    all_ids = col.get()["ids"]
    to_del  = [i for i in all_ids if i.startswith(doc_id + "_chunk_")]
    if to_del:
        col.delete(ids=to_del)
    print(json.dumps({"deleted": len(to_del)}))

elif cmd == "count":
    print(json.dumps({"count": col.count()}))

else:
    print(json.dumps({"error": "unknown command: " + cmd}))
