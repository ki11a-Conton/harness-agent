def find_duplicates(xs):
    out = []
    for i, a in enumerate(xs):
        for j, b in enumerate(xs):
            if i != j and a == b and a not in out:
                out.append(a)
    return out
