#!/usr/bin/env python3
"""Generate embeddings for one or more text inputs.

Input modes:
- CLI: --text "..."
- STDIN JSON: {"texts": ["...", "..."]}

Output:
{
  "embeddings": [[...], ...],
  "embedding": [...],
  "provider": "openai" | "local"
}
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys
from typing import List, Tuple

try:
    from openai import OpenAI  # type: ignore
except Exception:
    OpenAI = None  # type: ignore

DIM = 256
TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+")


def tokenize(text: str) -> List[str]:
    return [token.lower() for token in TOKEN_RE.findall(text or "")]


def local_embed(text: str) -> List[float]:
    vec = [0.0] * DIM
    for token in tokenize(text):
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        idx = int.from_bytes(digest[:4], "big") % DIM
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vec[idx] += sign

    mag = math.sqrt(sum(v * v for v in vec))
    if mag == 0:
        return vec
    return [v / mag for v in vec]


def local_embed_many(texts: List[str]) -> List[List[float]]:
    return [local_embed(text) for text in texts]


def openai_embed_many(texts: List[str]) -> List[List[float]]:
    if OpenAI is None:
        raise RuntimeError("openai package unavailable")

    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")

    model = os.getenv("CODEXMAP_EMBED_MODEL", "text-embedding-3-small")
    client = OpenAI(api_key=api_key)
    response = client.embeddings.create(model=model, input=texts)
    return [item.embedding for item in response.data]


def parse_input() -> List[str]:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", type=str, default=None)
    args = parser.parse_args()

    if args.text is not None:
        return [args.text]

    raw = sys.stdin.read().strip()
    if not raw:
        return []

    payload = json.loads(raw)
    if isinstance(payload, dict):
        if isinstance(payload.get("texts"), list):
            return [str(item) for item in payload["texts"]]
        if "text" in payload:
            return [str(payload["text"])]

    return []


def embed(texts: List[str]) -> Tuple[List[List[float]], str]:
    mode = os.getenv("CODEXMAP_EMBEDDING_MODE", "auto").strip().lower()

    if mode in ("openai", "auto"):
        try:
            return openai_embed_many(texts), "openai"
        except Exception:
            if mode == "openai":
                raise

    return local_embed_many(texts), "local"


def main() -> None:
    try:
        texts = parse_input()
        embeddings, provider = embed(texts)

        output = {
            "embeddings": embeddings,
            "provider": provider,
        }
        if len(embeddings) == 1:
            output["embedding"] = embeddings[0]

        sys.stdout.write(json.dumps(output))
    except Exception as exc:
        sys.stderr.write(f"embed.py error: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
