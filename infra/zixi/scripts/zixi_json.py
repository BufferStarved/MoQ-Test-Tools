#!/usr/bin/env bash
# Parse Zixi JSON/JSONP API responses.
import json
import sys


def parse_zixi_payload(text: str):
    text = text.strip()
    if not text:
        raise ValueError("empty response")
    if text[0] == "{" or text[0] == "[":
        return json.loads(text)
    open_paren = text.find("(")
    if open_paren == -1:
        raise ValueError("unrecognized response format")
    payload = text[open_paren + 1 :]
    if payload.endswith(");"):
        payload = payload[:-2]
    elif payload.endswith(")"):
        payload = payload[:-1]
    return json.loads(payload)


if __name__ == "__main__":
    data = parse_zixi_payload(sys.stdin.read())
    json.dump(data, sys.stdout)
