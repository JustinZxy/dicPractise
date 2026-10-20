#!/usr/bin/env python3
"""Serve the spelling game and store the mistake book in SQLite.

Run from the project folder:

    python3 server.py

Then open http://127.0.0.1:8080/ . With “错词存入 SQLite” turned on,
wrong words go to data/mistakes.sqlite instead of the browser.
"""

import json
import re
import sqlite3
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "mistakes.sqlite"
LIST_ID = re.compile(r"^[a-z0-9_-]{1,32}$")
WORD = re.compile(r"^[a-z][a-z' -]{0,40}$")


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS mistakes (
            list_id TEXT NOT NULL,
            word TEXT NOT NULL,
            phonetic TEXT NOT NULL DEFAULT '',
            pos TEXT NOT NULL DEFAULT '',
            meaning TEXT NOT NULL DEFAULT '',
            gloss TEXT NOT NULL DEFAULT '',
            count INTEGER NOT NULL DEFAULT 1,
            seen_at INTEGER NOT NULL,
            PRIMARY KEY (list_id, word)
        )
        """
    )
    return conn


class GameHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.route_get(parsed)
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/mistakes":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_json(400, {"error": "invalid json"})
            return
        list_id = str(body.get("list") or "")
        word = str(body.get("word") or "").lower()
        if not LIST_ID.match(list_id) or not WORD.match(word):
            self.send_json(400, {"error": "bad list or word"})
            return
        seen_at = int(body.get("at") or 0) or time.time_ns() // 1_000_000
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO mistakes (list_id, word, phonetic, pos, meaning, gloss, count, seen_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(list_id, word) DO UPDATE SET
                    count = count + 1,
                    seen_at = excluded.seen_at,
                    phonetic = excluded.phonetic,
                    pos = excluded.pos,
                    meaning = excluded.meaning,
                    gloss = excluded.gloss
                """,
                (
                    list_id,
                    word,
                    str(body.get("phonetic") or ""),
                    str(body.get("pos") or ""),
                    str(body.get("meaning") or ""),
                    str(body.get("gloss") or ""),
                    seen_at,
                ),
            )
            row = conn.execute(
                "SELECT count FROM mistakes WHERE list_id = ? AND word = ?",
                (list_id, word),
            ).fetchone()
        self.send_json(200, {"ok": True, "count": row["count"]})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/mistakes":
            self.send_error(404)
            return
        query = parse_qs(parsed.query)
        list_id = (query.get("list") or [""])[0]
        word = (query.get("word") or [""])[0].lower()
        if not LIST_ID.match(list_id):
            self.send_json(400, {"error": "bad list"})
            return
        with connect() as conn:
            if word:
                if not WORD.match(word):
                    self.send_json(400, {"error": "bad word"})
                    return
                conn.execute("DELETE FROM mistakes WHERE list_id = ? AND word = ?", (list_id, word))
            else:
                conn.execute("DELETE FROM mistakes WHERE list_id = ?", (list_id,))
        self.send_json(200, {"ok": True})

    def route_get(self, parsed):
        if parsed.path == "/api/health":
            self.send_json(200, {"ok": True})
            return
        query = parse_qs(parsed.query)
        list_id = (query.get("list") or ["senior"])[0]
        if not LIST_ID.match(list_id):
            self.send_json(400, {"error": "bad list"})
            return
        if parsed.path == "/api/mistakes/keys":
            with connect() as conn:
                rows = conn.execute(
                    "SELECT word FROM mistakes WHERE list_id = ? ORDER BY word",
                    (list_id,),
                ).fetchall()
            self.send_json(200, {"words": [row["word"] for row in rows]})
            return
        if parsed.path != "/api/mistakes":
            self.send_error(404)
            return
        letter = (query.get("letter") or ["all"])[0].lower()
        try:
            page = max(1, int((query.get("page") or ["1"])[0] or 1))
        except ValueError:
            page = 1
        page_size = 10
        where = "list_id = ?"
        params = [list_id]
        if letter != "all" and re.fullmatch(r"[a-z]", letter):
            where += " AND word LIKE ?"
            params.append(letter + "%")
        with connect() as conn:
            total = conn.execute(f"SELECT COUNT(*) AS n FROM mistakes WHERE {where}", params).fetchone()["n"]
            pages = max(1, (total + page_size - 1) // page_size)
            page = min(page, pages)
            offset = (page - 1) * page_size
            rows = conn.execute(
                f"""
                SELECT word, phonetic, pos, meaning, gloss, count, seen_at
                FROM mistakes WHERE {where}
                ORDER BY seen_at DESC, word
                LIMIT ? OFFSET ?
                """,
                params + [page_size, offset],
            ).fetchall()
        items = [
            {
                "word": row["word"],
                "phonetic": row["phonetic"],
                "pos": row["pos"],
                "meaning": row["meaning"],
                "gloss": row["gloss"],
                "count": row["count"],
                "at": row["seen_at"],
            }
            for row in rows
        ]
        self.send_json(200, {"items": items, "total": total, "page": page, "pages": pages})

    def send_json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        if str(args[0]).startswith("GET /js/words.js"):
            return
        super().log_message(fmt, *args)


if __name__ == "__main__":
    connect().close()
    server = ThreadingHTTPServer(("127.0.0.1", 8080), GameHandler)
    print("大纲组词 http://127.0.0.1:8080/")
    print("错词数据库", DB_PATH)
    server.serve_forever()
