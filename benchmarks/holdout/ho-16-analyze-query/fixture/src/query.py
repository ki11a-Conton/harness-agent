def top_n(scores, n):
    return sorted(scores, key=lambda s: s['score'], reverse=True)[:n]
