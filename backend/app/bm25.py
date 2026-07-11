import re
from typing import Optional

_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9_+#./-]{1,}")


def tokenize(text: str) -> list[str]:
    if not text:
        return []
    return _TOKEN_RE.findall(text.lower())


class BM25Index:
    """Pure-Python BM25 sparse-vector builder (no external models/services).

    Produces (term_id, weight) sparse vectors compatible with Qdrant sparse vectors.
    IDF/avgdl are recomputed from the live corpus as documents are added/removed,
    which is cheap for the hundreds-to-low-thousands of items this app handles.
    """

    def __init__(self, k1: float = 1.5, b: float = 0.75) -> None:
        self.k1 = k1
        self.b = b
        self._term_ids: dict[str, int] = {}
        self._next_id = 0
        self._df: dict[str, int] = {}
        self._doc_count = 0
        self._total_len = 0
        self._doc_terms: dict[str, list[str]] = {}

    def _term_id(self, term: str) -> int:
        tid = self._term_ids.get(term)
        if tid is None:
            tid = self._next_id
            self._next_id += 1
            self._term_ids[term] = tid
        return tid

    def add(self, doc_id: str, text: str) -> None:
        tokens = tokenize(text)
        if doc_id in self._doc_terms:
            self.remove(doc_id)
        if not tokens:
            self._doc_terms[doc_id] = []
            return
        for t in tokens:
            self._df[t] = self._df.get(t, 0) + 1
        self._doc_count += 1
        self._total_len += len(tokens)
        self._doc_terms[doc_id] = tokens

    def remove(self, doc_id: str) -> None:
        tokens = self._doc_terms.pop(doc_id, None)
        if not tokens:
            return
        for t in set(tokens):
            if self._df.get(t, 0) > 1:
                self._df[t] -= 1
            else:
                self._df.pop(t, None)
        self._doc_count -= 1
        self._total_len -= len(tokens)

    def _avgdl(self) -> float:
        return (self._total_len / self._doc_count) if self._doc_count else 0.0

    def _idf(self, term: str) -> float:
        df = self._df.get(term, 0)
        n = self._doc_count
        return max(0.0, (n - df + 0.5) / (df + 0.5) + 1.0)

    def sparse(self, text: str) -> tuple[list[int], list[float]]:
        tokens = tokenize(text)
        if not tokens:
            return [], []
        avgdl = self._avgdl()
        tf: dict[str, int] = {}
        for t in tokens:
            tf[t] = tf.get(t, 0) + 1
        indices: list[int] = []
        values: list[float] = []
        for term, freq in tf.items():
            idf = self._idf(term)
            if idf <= 0:
                continue
            denom = freq + self.k1 * (1 - self.b + self.b * (len(tokens) / avgdl if avgdl else 1))
            weight = idf * (freq * (self.k1 + 1)) / denom
            indices.append(self._term_id(term))
            values.append(round(weight, 4))
        return indices, values

    def reset(self) -> None:
        self._term_ids.clear()
        self._next_id = 0
        self._df.clear()
        self._doc_count = 0
        self._total_len = 0
        self._doc_terms.clear()
