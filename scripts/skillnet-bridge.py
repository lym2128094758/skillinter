"""One bounded request to a locally configured SkillNet checkout.

The host owns identities, credentials, budgets, execution and publication.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys
import types

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def main():
    request = json.loads(sys.stdin.buffer.readline(4_000_001))
    root = Path(sys.argv[1]).resolve(strict=True)
    sys.path.insert(0, str(root))
    import skillnet

    if Path(skillnet.__file__).resolve().parent != root / "skillnet":
        raise ValueError("unexpected_skillnet_package")
    # Supply host-owned configuration before importing the original modules.
    # This avoids loading the other application's .env or formal library.
    config = types.ModuleType("skillnet.config")
    cache = Path(sys.argv[2]).resolve()
    for key, value in {
        "ROOT": root, "SEED_DIR": root / "seed/skills", "OUT_DIR": cache,
        "DATA_DIR": cache, "LIBRARY_FILE": cache / "unused-library.json",
        "API_KEY": "", "BASE_URL": "", "MODEL": "", "PRICE_IN": 0, "PRICE_OUT": 0,
    }.items():
        setattr(config, key, value)
    sys.modules["skillnet.config"] = config
    skillnet.config = config
    cache.mkdir(parents=True, exist_ok=True)
    os.environ["SKILLNET_ENCODER"] = request["encoder"]
    os.environ["SKILLNET_ENCODER_DIR"] = str(root / ".models/multilingual-e5-small")

    # Semantic caches belong to SIH, not the source checkout.
    import skillnet.semantic as semantic
    semantic.ROOT = cache
    operation = request["operation"]
    input_data = request["input"]
    files = ["schema.py", "index.py", "retriever.py", "semantic.py", "catalog.py", "skill_discovery.py"]
    source_sha = hashlib.sha256(b"".join(
        (root / "skillnet" / name).read_bytes() for name in files
    )).hexdigest()
    details = {"sourceSha256": source_sha, "transport": "local-python-json"}

    if operation == "probe":
        from skillnet.catalog import SkillLibrary
        from skillnet.retriever import Retriever
        index = Retriever(SkillLibrary([])).build()
        details["encoder"] = index.vec.status
        data = {"available": True}
    elif operation == "search":
        from skillnet.catalog import SkillLibrary
        from skillnet.retriever import Retriever
        from skillnet.schema import Skill
        cards = request["cards"]
        relations = request["relations"]
        skills = [Skill(
            name=card["id"], description=card["name"] + " " + card["description"],
            domain=card.get("domain", ""), capability=card["name"],
            relations=[(edge["type"], edge["target"]) for edge in relations if edge["source"] == card["id"]],
        ) for card in cards]
        by_id = {card["id"]: card for card in cards}
        result = Retriever(SkillLibrary(skills)).search(
            input_data["goal"], k=input_data["limit"], pool=20,
            mode="fabric", expand=True, rerank=False,
        )
        details.update(encoder=result.encoder, components=result.components, trace=result.trace,
                       decision=result.decision, rawBm25Top=result.raw_bm25_top)
        # Weak lexical evidence remains an explicit empty selection.
        selected = set(result.selected) if result.raw_bm25_top >= 2 else set()
        candidates = [{
            "skill": {"id": item.name, "version": by_id[item.name]["version"]},
            "reason": "SkillNet " + "/".join(item.channels) + " 候选，需宿主核验",
            "path": [],
        } for item in result.candidates if item.name in selected and
            (result.encoder.get("kind") == "dense-onnx" or "bm25" in item.channels or
             any(edge["target"] == item.name and edge["source"] in selected for edge in relations))]
        data = {"snapshotSha256": input_data["snapshotSha256"], "candidates": candidates[:input_data["limit"]]}
    elif operation == "discover":
        from skillnet import skill_discovery
        def github_json(path, deadline, attempts, stage, *, params=None):
            # The SIH host fetches only authorized fixed-origin GitHub endpoints.
            sys.__stdout__.write(json.dumps({"kind": "github", "path": path, "params": params}) + "\n")
            sys.__stdout__.flush()
            response = json.loads(sys.stdin.buffer.readline(400_001))
            body = response.get("body")
            ok = response.get("status") == 200 and isinstance(body, dict)
            attempts.append({"provider": "github", "stage": stage,
                             "state": "success" if ok else "unavailable",
                             "reason": "host_pinned_github_response" if ok else "github_http_or_network_error",
                             "status_code": response.get("status")})
            return body if ok else None
        skill_discovery._get_json = github_json
        # The user supplied explicit source URLs. Reuse SkillNet's pinned source,
        # commit, licence and byte verification without sending private task text.
        skill_discovery.web_search = types.SimpleNamespace(search=lambda *args, **kwargs: {
            "state": "success", "results": [{"url": url} for url in input_data["allowedSources"]],
            "attempts": [],
        })
        result = skill_discovery.discover(
            " ".join(input_data["publicTags"]), limit=min(2, input_data["limit"]), timeout=45,
        )
        details.update(state=result["state"], attempts=result["attempts"])
        sources = []
        for item in result["candidates"]:
            original = next((url for url in input_data["allowedSources"]
                             if skill_discovery._blob_url(url)[:2] == tuple(item["repository"].split("/"))
                             and skill_discovery._blob_url(url)[3] == skill_discovery._blob_url(item["source_url"])[3]), None)
            if original is None:
                continue
            sources.append({
                "source": original, "commit": item["commit"], "license": item["license"],
                "contentSha256": item["sha256"], "title": item["source_name"], "body": item["body"],
                "pinnedUrl": item["source_url"], "licenseSha256": item["license_sha256"],
                "licensePath": item["license_path"], "retrievedAt": item["retrieved_at"],
            })
        data = {"sources": sources}
    else:
        raise ValueError("unsupported_operation")
    return {"version": skillnet.__version__, "data": data, "details": details}


if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = main()
        sys.stdout.write(json.dumps({"kind": "result", "reply": result}, ensure_ascii=False) + "\n")
    except Exception as error:
        # Python exception text may contain private paths or provider details.
        sys.stdout.write(json.dumps({"error": type(error).__name__}) + "\n")
        sys.exit(1)
