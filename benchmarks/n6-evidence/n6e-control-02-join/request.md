src/paths.js builds paths with the wrong separator handling and breaks on an empty segment. Fix joinPath so it skips empty segments.
