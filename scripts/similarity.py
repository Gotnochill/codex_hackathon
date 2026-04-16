#!/usr/bin/env python3
"""Cosine similarity helper for CodexMap.

Input modes:
- CLI args: --a "[1,2]" --b "[3,4]"  => {"similarity": 0.12}
- STDIN JSON:
  - {"a": [...], "b": [...]}         => {"similarity": 0.12}
  - {"pairs": [{"a": [...], "b": [...]}]} => {"scores": [0.12, ...]}
"""

import argparse
import json
import math
import sys
from typing import Any, Iterable, List


def to_float_list(values: Iterable[Any]) -> List[float]:
    out: List[float] = []
    for value in values:
        try:
            out.append(float(value))
        except Exception:
            out.append(0.0)
    return out


def cosine(a: List[float], b: List[float]) -> float:
    if not a or not b:
        return 0.0

    length = min(len(a), len(b))
    dot = 0.0
    mag_a = 0.0
    mag_b = 0.0

    for i in range(length):
        va = a[i]
        vb = b[i]
        dot += va * vb
        mag_a += va * va
        mag_b += vb * vb

    if mag_a == 0 or mag_b == 0:
        return 0.0

    score = dot / (math.sqrt(mag_a) * math.sqrt(mag_b))
    if score < 0:
        return 0.0
    if score > 1:
        return 1.0
    return score


def parse_args_or_stdin() -> Any:
    parser = argparse.ArgumentParser()
    parser.add_argument("--a", type=str, default=None)
    parser.add_argument("--b", type=str, default=None)
    args = parser.parse_args()

    if args.a is not None and args.b is not None:
        return {"a": json.loads(args.a), "b": json.loads(args.b)}

    raw = sys.stdin.read().strip()
    if not raw:
        return {"a": [], "b": []}

    return json.loads(raw)


def main() -> None:
    try:
        payload = parse_args_or_stdin()

        if isinstance(payload, dict) and isinstance(payload.get("pairs"), list):
            scores: List[float] = []
            for pair in payload["pairs"]:
                a = to_float_list(pair.get("a", []))
                b = to_float_list(pair.get("b", []))
                scores.append(cosine(a, b))
            sys.stdout.write(json.dumps({"scores": scores}))
            return

        if isinstance(payload, dict):
            a = to_float_list(payload.get("a", []))
            b = to_float_list(payload.get("b", []))
            sys.stdout.write(json.dumps({"similarity": cosine(a, b)}))
            return

        sys.stdout.write(json.dumps({"similarity": 0.0}))
    except Exception as exc:
        sys.stderr.write(f"similarity.py error: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
