// Harness Agent presentation derivative; original retained under plugins/.
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-commands",
	factory: (require) => {
		const harnessTextSearch = (function createBrowserTextSearch() {
const fuzzysort = (() => {
function single(search, target) {
  if(!search || !target) return null
  let query = getQuery(search)
  if(!isPrepared(target)) target = getPrepared(target)
  if((query.bitflags & target._bitflags) !== query.bitflags) return null
  let result = !query.hasSpace && query.lowerCodes.length === 2 ? algorithm2(query, target) : algorithm(query, target)
  return result && materialize(result)
}

function go(search, targets, options) {
  if(targets instanceof SnapshotTargets) return goSnapshot(search, targets, options)
  let key = options?.key
  let keys = !key && options?.keys
  let firstTarget = targets[0]
  if(!key && !keys && typeof firstTarget === 'object' && firstTarget !== null && !isPrepared(firstTarget)) {
    throw new Error('fuzzysort: key or keys is required when searching object targets')
  }
  if(!search) return all(targets, options)

  let query = getQuery(search)
  if(keys) return goKeys(query, targets, options)

  let searchBitflags = query.bitflags
  let twoChar = !query.hasSpace && query.lowerCodes.length === 2
  let threshold = denormalizeScore(options?.threshold ?? .5)
  let limit = getLimit(options)
  let scoreFn = options?.scoreFn
  let resultCount = 0
  let limited = 0
  let getter = key && makeGetter(key)

  for(let i = 0; i < targets.length; i++) {
    let obj = targets[i]
    let target = key ? getter === null ? obj[key] : getter(obj) : obj
    if(!target) continue
    if(!isPrepared(target)) target = getPrepared(target)
    if((searchBitflags & target._bitflags) !== searchBitflags) continue
    let result = twoChar ? algorithm2(query, target) : algorithm(query, target)
    if(result === null) continue
    let resultScore = result._score
    if(scoreFn) {
      result = materialize(result, key ? obj : undefined)
      resultScore = scoreFn(result)
      if(!resultScore) continue
      result._score = resultScore = denormalizeScore(resultScore)
    }
    if(resultScore < threshold) continue

    let room = resultCount < limit
    if(room) resultCount++
    else {
      limited++
      if(resultScore <= heap.peek()._score) continue
    }
    if(!scoreFn) result = materialize(result, key ? obj : undefined)
    room ? heap.add(result) : heap.replaceTop(result)
  }
  return finishResults(resultCount, limited)
}

function highlight(result, open = '<b>', close = '</b>', threshold = .5) {
  let callback = typeof open === 'function' ? open : null
  let target = result.target
  if(result._bestKeyScore !== undefined && normalizeScore(result._score) < normalizeScore(result._bestKeyScore) * threshold) return callback ? [target] : target
  let raw = result._indexes
  let indexes = raw === undefined
    ? result.indexes
    : raw.slice(0, raw.len ?? raw.length).sort((a, b) => a - b)
  if(!indexes.length) return callback ? [target] : target

  let output = callback ? [] : ''
  let lastIndex = 0
  let matchI = 0

  for(let i = 0; i < indexes.length;) {
    let start = indexes[i++]
    let end = start + 1
    while(indexes[i] === end) {
      i++
      end++
    }
    let before = target.slice(lastIndex, start)
    let match = target.slice(start, end)
    if(callback) output.push(before, callback(match, matchI++))
    else output += before + open + match + close
    lastIndex = end
  }
  if(callback) output.push(target.slice(lastIndex))
  else output += target.slice(lastIndex)
  return output
}

function score(result) {
  let value = result.score
  return value === undefined ? normalizeScore(result._score) : value
}

function remap(mappings) {
  for(let char in mappings) {
    remappings[char] = mappings[char]
    if(char.charCodeAt(0) < 128) customAsciiRemappings = true
  }
  cleanup()
}

function prepare(target) { return prepTarget(target) }

function snapshot(targets, options) { return new SnapshotTargets(targets, options) }

function cleanup() {
  targetCache.clear(); searchCache.clear(); heap.clear()
  simpleMatch = []; strictMatch = []
  seen = []; seenAt = []
  changes = []; partials = []; spaceScores = []
  partIndexes = []; winnerIndexes = []; winnerScores = []; winnerKeys = []
  keyTargets = []; keyResults = []; candidateBitOffsets = []
  seenGeneration = 0
}


function goSnapshotValues(search, snapshot, options, singleChar) {
  let targets = snapshot._targets
  let objects = snapshot._objects
  let threshold = denormalizeScore(options?.threshold ?? .5)
  let limit = getLimit(options)
  let scoreFn = options?.scoreFn
  let searchLen = search.lowerCodes.length
  let shortSearch = !search.hasSpace && searchLen <= 3
  let twoChar = !search.hasSpace && searchLen === 2
  let rows = snapshot._candidateRows
  let rowsLength = snapshot._candidateLength
  let matchedRows = snapshot._rows
  let matchedCount = 0
  let resultCount = 0
  let limited = 0

  for(let n = 0; n < rowsLength; n++) {
    let i = rows === null ? n : rows[n]
    let target = targets[i]
    if(target === noTarget || (search.bitflags & target._bitflags) !== search.bitflags) continue
    let targetShort = shortSearch && target.target.length < 65535
    let cutoff = !scoreFn && threshold === -INF && resultCount >= limit ? heap.peek()._score : -INF
    let result
    if(singleChar && targetShort) result = algorithm1(search, target, snapshot._first, i)
    else if(twoChar && targetShort) {
      let start = snapshot._offsets[i]
      let end = snapshot._offsets[i + 1]
      result = algorithm2(search, target, snapshot._beginnings, start, end, cutoff)
    } else if(twoChar) result = algorithm2(search, target, null, 0, 0, cutoff)
    else if(targetShort) {
      let start = snapshot._offsets[i]
      let end = snapshot._offsets[i + 1]
      result = algorithm(search, target, false, false, false, true, snapshot._beginnings, start, end, cutoff)
    } else result = algorithm(search, target, false, false, false, true, null, 0, 0, cutoff)
    if(result === null) continue
    matchedRows[matchedCount++] = i
    if(result === prunedMatch) {
      limited++
      continue
    }
    let resultScore = result._score
    if(scoreFn) {
      result = materialize(result, objects?.[i])
      resultScore = scoreFn(result)
      if(!resultScore) continue
      result._score = resultScore = denormalizeScore(resultScore)
    }
    if(resultScore < threshold) continue

    let room = resultCount < limit
    if(room) resultCount++
    else {
      limited++
      if(resultScore <= heap.peek()._score) continue
    }
    if(objects && !scoreFn) result = materialize(result, objects[i])
    room ? heap.add(result) : heap.replaceTop(result)
  }
  snapshot._matchedRowsLen = matchedCount
  return finishResults(resultCount, limited, !objects && !scoreFn && materialize)
}

function goSnapshot(search, snapshot, options) {
  if(options?.key || options?.keys) throw new Error('fuzzysort: key/keys must be provided to snapshot(), not go()')
  snapshot._finish()

  if(!search) return allSnapshot(snapshot, options)

  let query = getQuery(search)
  let backtrack = snapshot._backtrack(query, options)
  if(backtrack) return backtrack

  snapshot._beginSearch(query)
  try {
    let results
    if(snapshot._mode < 2) {
      let searchLen = query.lowerCodes.length
      let code = query.lowerCodes[0]
      let singleChar = searchLen === 1 && code >= 97 && code <= 122
      results = goSnapshotValues(query, snapshot, options, singleChar)
    } else results = goKeys(query, snapshot._objects, options, snapshot)
    snapshot._endSearch(query)
    snapshot._remember(query, results, options)
    return results
  } catch(error) {
    snapshot._resetSearch()
    throw error
  }
}

function goKeys(query, objects, options, snapshot) {
  let indexed = snapshot !== undefined
  let keys = indexed ? null : options.keys
  let getters = indexed ? null : keys.map(makeGetter)
  let targets = indexed ? snapshot._targets : null
  let keysLength = indexed ? snapshot._keysLength : keys.length
  let searchBitflags = query.bitflags
  let hasSpace = query.hasSpace
  let spaceCount = query.parts.length
  let threshold = denormalizeScore(options?.threshold ?? .5)
  let limit = getLimit(options)
  let searchLen = query.lowerCodes.length
  let short = indexed && !hasSpace && searchLen <= 3
  let twoChar = !hasSpace && searchLen === 2
  let code = query.lowerCodes[0]
  let singleChar = short && searchLen === 1 && code >= 97 && code <= 122
  let scoreFn = options?.scoreFn
  let deferMaterialization = indexed && !scoreFn && (limit !== INF || threshold > -INF)
  let rows = indexed ? snapshot._candidateRows : null
  let rowsLength = indexed ? snapshot._candidateLength : objects.length
  let matchedRows = indexed ? snapshot._rows : null
  let matchedCount = 0
  let resultCount = 0
  let limited = 0

  outer: for(let n = 0; n < rowsLength; n++) {
    let i = rows === null ? n : rows[n]
    let row = i * keysLength
    if(indexed) {
      if((searchBitflags & snapshot._bitflags[i]) !== searchBitflags) continue
    } else {
      let obj = objects[i]
      let keysBitflags = 0
      for(let k = 0; k < keysLength; k++) {
        let target = getters[k] === null ? obj[keys[k]] : getters[k](obj)
        if(!target) target = noTarget
        else if(!isPrepared(target)) target = getPrepared(target)
        keyTargets[k] = target
        keysBitflags |= target._bitflags
      }
      if((searchBitflags & keysBitflags) !== searchBitflags) continue
    }
    if(hasSpace) for(let s = 0; s < spaceCount; s++) {
      spaceScores[s] = winnerScores[s] = -INF
      winnerKeys[s] = -1
    }

    for(let k = 0; k < keysLength; k++) {
      let target = indexed ? targets[row + k] : keyTargets[k]
      if(target === noTarget) {
        keyResults[k] = noTarget
        continue
      }

      if(hasSpace && indexed) {
        let possible = false
        for(let s = 0; s < spaceCount; s++) {
          let partBitflags = query.parts[s].bitflags
          if((partBitflags & target._bitflags) === partBitflags) {
            possible = true
            break
          }
        }
        if(!possible) {
          keyResults[k] = noTarget
          continue
        }
      } else if(!hasSpace && (searchBitflags & target._bitflags) !== searchBitflags) {
        keyResults[k] = noTarget
        continue
      }

      let match
      if(indexed) {
        let valueRow = row + k
        let targetShort = short && target.target.length < 65535
        if(singleChar && targetShort) match = algorithm1(query, target, snapshot._first, valueRow)
        else if(twoChar && targetShort) {
          let start = snapshot._offsets[valueRow]
          let end = snapshot._offsets[valueRow + 1]
          match = algorithm2(query, target, snapshot._beginnings, start, end)
        } else if(twoChar) match = algorithm2(query, target)
        else if(targetShort) {
          let start = snapshot._offsets[valueRow]
          let end = snapshot._offsets[valueRow + 1]
          match = algorithm(query, target, false, false, false, true, snapshot._beginnings, start, end)
        } else match = algorithm(query, target, false, hasSpace)
      } else match = twoChar ? algorithm2(query, target) : algorithm(query, target, false, hasSpace)

      if(match === null) {
        keyResults[k] = noTarget
        continue
      }
      keyResults[k] = deferMaterialization ? match : materialize(match)
      if(hasSpace) {
        mergePartScores(spaceCount)
        for(let s = 0; s < spaceCount; s++) {
          let partScore = partials[s]
          if(partScore <= winnerScores[s]) continue
          winnerScores[s] = partScore
          winnerKeys[s] = k
          let source = partIndexes[s]
          let winner = winnerIndexes[s] ||= []
          winner.length = source.length
          for(let j = 0; j < source.length; j++) winner[j] = source[j]
        }
      }
    }

    if(hasSpace) for(let s = 0; s < spaceCount; s++) if(winnerKeys[s] !== -1) {
      appendIndexes(keyResults[winnerKeys[s]]._indexes, winnerIndexes[s])
    }

    let resultScore
    if(hasSpace) {
      resultScore = 0
      for(let s = 0; s < spaceCount; s++) {
        let partScore = spaceScores[s]
        if(partScore === -INF) continue outer
        resultScore += partScore
      }
    } else {
      resultScore = mergeScores(keyResults, keysLength)
      if(resultScore === -INF) continue
    }
    if(indexed) matchedRows[matchedCount++] = i

    let result = deferMaterialization ? null : captureKeysResult(keyResults, keysLength, objects[i], resultScore, hasSpace)
    if(scoreFn) {
      resultScore = scoreFn(result)
      if(!resultScore) continue
      result._score = resultScore = denormalizeScore(resultScore)
    }
    if(resultScore < threshold) continue

    let room = resultCount < limit
    if(room) resultCount++
    else {
      limited++
      if(resultScore <= heap.peek()._score) continue
    }
    if(result === null) result = captureKeysResult(keyResults, keysLength, objects[i], resultScore, hasSpace)
    room ? heap.add(result) : heap.replaceTop(result)
  }
  if(indexed) snapshot._matchedRowsLen = matchedCount
  return finishResults(resultCount, limited, deferMaterialization && materializeKeys)
}

function allSnapshot(snapshot, options) {
  let results = []
  let targets = snapshot._targets
  let objects = snapshot._objects
  let keysLength = snapshot._keysLength
  let total = keysLength === undefined ? targets.length : objects.length
  results.total = total

  let limit = getLimit(options)
  for(let i = 0, length = Math.min(total, limit); i < length; i++) {
    if(keysLength === undefined) {
      results.push(newResult(targets[i].target, -INF, objects?.[i]))
      continue
    }
    let row = i * keysLength
    for(let k = 0; k < keysLength; k++) {
      let target = targets[row + k]
      keyResults[k] = target === noTarget ? noTarget : newResult(target.target, -INF)
    }
    results.push(captureKeysResult(keyResults, keysLength, objects[i], -INF))
  }
  return results
}

function all(targets, options) {
  let results = []
  results.total = targets.length
  let limit = getLimit(options)
  let key = options?.key
  let keys = !key && options?.keys

  if(keys) {
    let getters = keys.map(makeGetter)
    for(let obj of targets) {
      for(let k = keys.length - 1; k >= 0; k--) {
        let target = getters[k] === null ? obj[keys[k]] : getters[k](obj)
        if(!target) keyResults[k] = noTarget
        else {
          if(!isPrepared(target)) target = getPrepared(target)
          target._score = -INF
          target._indexes.len = 0
          keyResults[k] = target
        }
      }
      results.push(captureKeysResult(keyResults, keys.length, obj, -INF))
      if(results.length >= limit) break
    }
    return results
  }

  let getter = key && makeGetter(key)
  for(let obj of targets) {
    let target = key ? getter === null ? obj[key] : getter(obj) : obj
    if(target == null) continue
    if(!isPrepared(target)) target = getPrepared(target)
    if(key) target = newResult(target.target, -INF, obj)
    else {
      target._score = -INF
      target._indexes.len = 0
    }
    results.push(target)
    if(results.length >= limit) break
  }
  return results
}

function finishResults(length, limited, transform) {
  if(!length) return noResults
  let results = new Array(length)
  for(let i = length - 1; i >= 0; i--) {
    let result = heap.poll()
    if(transform) result = transform(result)
    if(result instanceof KeysResult && !result._partWinners) markBestKeyScore(result)
    results[i] = result
  }
  results.total = length + limited
  return results
}

function materializeKeys(result) {
  for(let k = 0; k < result.length; k++) if(result[k] !== noTarget) result[k] = materialize(result[k])
  return result
}


function algorithm1(search, target, firstTable, row) {
  let matchI = target._targetLower.indexOf(search._lower)
  if(matchI === -1) return null
  let beginning = firstTable[row * 26 + search.lowerCodes[0] - 97]
  let strict = beginning !== 0
  if(strict) matchI = beginning - 1
  let score = matchI === 0 ? 0 : -matchI * matchI * .2
  if(!strict) score *= 1000
  else if(target._beginningsLen > 24) score *= (target._beginningsLen - 24) * 10
  target._score = score - target._targetLowerCodes.length + 1
  target._indexes[0] = matchI
  target._indexes.len = 1
  return target
}

function algorithm2(search, target, beginnings = null, start = 0, end = 0, cutoff = -INF) {
  let targetCodes = target._targetLowerCodes
  let targetLen = targetCodes.length
  let firstCode = search.lowerCodes[0]
  let secondCode = search.lowerCodes[1]

  let first = 0
  while(targetCodes[first] !== firstCode) if(++first >= targetLen) return null
  let second = first + 1
  while(targetCodes[second] !== secondCode) if(++second >= targetLen) return null

  if(cutoff !== -INF && scoreCeiling(2, targetLen) <= cutoff) return prunedMatch

  if(beginnings === null) {
    beginnings = target._beginnings
    if(beginnings === null) target._beginnings = beginnings = makeBeginnings(target)
    end = beginnings.length
  }

  let substringI = target._targetLower.indexOf(search._lower, first)
  let substring = substringI !== -1
  let low = lowerBound(beginnings, start, end, substringI)
  let substringStart = substring && low < end && beginnings[low] === substringI
  let strict = substringStart && substringI === first

  if(!strict) {
    let firstBeginning = start
    while(firstBeginning < end && beginnings[firstBeginning] < first) firstBeginning++

    for(let backtracks = 0; firstBeginning < end;) {
      let strictFirst = beginnings[firstBeginning]
      if(targetCodes[strictFirst] !== firstCode) {
        firstBeginning++
        continue
      }

      let consecutive = strictFirst + 1
      if(targetCodes[consecutive] === secondCode) {
        first = strictFirst
        second = consecutive
        strict = true
        break
      }

      let secondBeginning = firstBeginning + 1
      while(secondBeginning < end && beginnings[secondBeginning] <= consecutive) secondBeginning++
      while(secondBeginning < end && targetCodes[beginnings[secondBeginning]] !== secondCode) secondBeginning++
      if(secondBeginning < end) {
        first = strictFirst
        second = beginnings[secondBeginning]
        strict = true
        break
      }

      if(++backtracks > 200) break
      firstBeginning++
    }
  }

  if(substring && !substringStart) {
    while(low < end && beginnings[low] <= substringI) low++
    for(; low < end; low++) {
      let index = beginnings[low]
      if(targetCodes[index] === firstCode && targetCodes[index + 1] === secondCode) {
        substringI = index
        substringStart = true
        break
      }
    }
  }

  if(substring && (!strict || substringStart)) {
    first = substringI
    second = substringI + 1
  }

  let resultScore = second - first === 1 ? 0 : first - second * 2 - 11
  if(first) resultScore -= first * first * .2
  if(!strict) resultScore *= 1000
  else if(end - start > 24) resultScore *= (end - start - 24) * 10

  let lengthPenalty = (targetLen - 2) / 2
  resultScore -= lengthPenalty
  if(substring) resultScore /= 5
  if(substringStart) resultScore /= 5
  resultScore -= lengthPenalty
  let substringEnd = substring && second === first + 1 && (second + 1 === targetLen || isBeginning(beginnings, start, end, second + 1))
  target._score = substringEnd ? resultScore + Math.min(4, -resultScore / 2) : resultScore
  target._indexes[0] = first
  target._indexes[1] = second
  target._indexes.len = 2
  return target
}

function algorithm(search, target, spaces = false, partial = false, changed = false, singleMatch = true, beginnings = null, start = 0, end = 0, cutoff = -INF) {
  if(!spaces && search.hasSpace) return algorithmSpaces(search, target, partial)

  let searchCodes = search.lowerCodes
  let targetCodes = target._targetLowerCodes
  let searchLen = searchCodes.length
  let targetLen = targetCodes.length
  let searchCode = searchCodes[0]
  let searchI = 0
  let targetI = 0
  for(;;) {
    if(searchCode === targetCodes[targetI]) {
      simpleMatch[searchI] = targetI
      if(++searchI === searchLen) break
      searchCode = searchCodes[searchI]
    }
    if(++targetI >= targetLen) return null
  }

  if(cutoff !== -INF && searchLen > 1 && scoreCeiling(searchLen, targetLen) <= cutoff) return prunedMatch

  if(searchLen === 1 && !changed && singleMatch) {
    let matchI
    let strict
    if(target._singleMatchCode === searchCode) {
      matchI = target._singleMatchIndex
      strict = target._singleMatchStrict
    } else if(target._nextBeginningIndexes !== null) {
      let next = target._nextBeginningIndexes
      targetI = simpleMatch[0] === 0 ? 0 : next[simpleMatch[0] - 1]
      while(targetI < targetLen && searchCode !== targetCodes[targetI]) targetI = next[targetI]
      strict = targetI < targetLen
      matchI = strict ? targetI : simpleMatch[0]
    } else {
      prepareSingleMatch(target, searchCode, simpleMatch[0])
      matchI = target._singleMatchIndex
      strict = target._singleMatchStrict
    }

    let resultScore = matchI === 0 ? 0 : -matchI * matchI * .2
    if(!strict) resultScore *= 1000
    else if(target._beginningsLen > 24) resultScore *= (target._beginningsLen - 24) * 10
    target._score = resultScore - (targetLen - 1)
    target._indexes[0] = matchI
    target._indexes.len = 1
    return target
  }

  searchI = 0
  let strict = false
  let strictLen = 0
  let next = target._nextBeginningIndexes
  if(beginnings === null && next === null) next = target._nextBeginningIndexes = makeNextBeginnings(target)
  let beginningLen = beginnings === null ? (changed ? 0 : target._beginningsLen) : end - start
  if(!beginningLen) {
    beginningLen = 1
    for(let i = next[0]; i < targetLen; i = next[i]) beginningLen++
    if(!changed) target._beginningsLen = beginningLen
  }

  let substringI = searchLen <= 1 ? -1 : target._targetLower.indexOf(search._lower, simpleMatch[0])
  let isSubstring = substringI !== -1
  let substringStart = isSubstring && (substringI === 0 || (beginnings
    ? isBeginning(beginnings, start, end, substringI)
    : next[substringI - 1] === substringI))

  if(substringStart && substringI === simpleMatch[0]) strict = true
  else {
    targetI = simpleMatch[0] === 0 ? 0 : beginnings
      ? nextBeginning(beginnings, start, end, simpleMatch[0] - 1, targetLen)
      : next[simpleMatch[0] - 1]
    let backtracks = 0
    if(targetI !== targetLen) for(;;) {
      if(targetI >= targetLen) {
        if(searchI <= 0 || ++backtracks > 200) break
        searchI--
        let previous = strictMatch[--strictLen]
        targetI = beginnings
          ? nextBeginning(beginnings, start, end, previous, targetLen)
          : next[previous]
      } else if(searchCodes[searchI] === targetCodes[targetI]) {
        strictMatch[strictLen++] = targetI
        if(++searchI === searchLen) {
          strict = true
          break
        }
        targetI++
      } else targetI = beginnings
        ? nextBeginning(beginnings, start, end, targetI, targetLen)
        : next[targetI]
    }
  }

  if(isSubstring && !substringStart) {
    if(beginnings) {
      for(let b = start; b < end; b++) {
        let i = beginnings[b]
        if(i <= substringI) continue
        let s = 0
        for(; s < searchLen && searchCodes[s] === targetCodes[i + s]; s++);
        if(s === searchLen) {
          substringI = i
          substringStart = true
          break
        }
      }
    } else for(let i = 0; i < next.length; i = next[i]) {
      if(i <= substringI) continue
      let s = 0
      for(; s < searchLen && searchCodes[s] === targetCodes[i + s]; s++);
      if(s === searchLen) {
        substringI = i
        substringStart = true
        break
      }
    }
  }

  let matches
  if(!strict) {
    if(isSubstring) for(let i = 0; i < searchLen; i++) simpleMatch[i] = substringI + i
    matches = simpleMatch
  } else if(substringStart) {
    for(let i = 0; i < searchLen; i++) simpleMatch[i] = substringI + i
    matches = simpleMatch
  } else matches = strictMatch

  let matchEnd = matches[searchLen - 1] + 1
  let substringEnd = isSubstring && matchEnd - matches[0] === searchLen && (matchEnd === targetLen || (beginnings
    ? isBeginning(beginnings, start, end, matchEnd)
    : next[matchEnd - 1] === matchEnd))
  target._score = calculateScore(matches, searchLen, targetLen, strict, beginningLen, isSubstring, substringStart, substringEnd)
  for(let i = 0; i < searchLen; i++) target._indexes[i] = matches[i]
  target._indexes.len = searchLen
  return target
}

function mergePartScores(length) {
  for(let i = 0; i < length; i++) {
    let partial = partials[i]
    let best = spaceScores[i]
    if(partial > -1000 && best > -INF) best = Math.max(best, (best + partial) / 4)
    spaceScores[i] = Math.max(best, partial)
  }
}

function appendIndexes(indexes, additions) {
  let length = indexes.len
  outer: for(let i = 0; i < additions.length; i++) {
    let index = additions[i]
    for(let j = 0; j < length; j++) if(indexes[j] === index) continue outer
    indexes[length++] = index
  }
  indexes.len = length
}

function mergeScores(results, length) {
  let total = -INF
  for(let i = 0; i < length; i++) {
    let score = results[i]._score
    if(score > -1000 && total > -INF) total = Math.max(total, (total + score) / 4)
    if(score > total) total = score
  }
  return total
}

function calculateScore(matches, searchLen, targetLen, strict, beginningLen, substring, substringStart, substringEnd) {
  let score = 0
  let groups = 0
  for(let i = 1; i < searchLen; i++) if(matches[i] - matches[i - 1] !== 1) {
    score -= matches[i]
    groups++
  }
  let unmatchedDistance = matches[searchLen - 1] - matches[0] - (searchLen - 1)
  score -= (12 + unmatchedDistance) * groups
  if(matches[0] !== 0) score -= matches[0] * matches[0] * .2
  if(!strict) score *= 1000
  else if(beginningLen > 24) score *= (beginningLen - 24) * 10

  let lengthPenalty = (targetLen - searchLen) / 2
  score -= lengthPenalty
  let substringBonus = 1 + searchLen * searchLen
  if(substring) score /= substringBonus
  if(substringStart) score /= substringBonus
  score -= lengthPenalty
  return substringEnd ? score + Math.min(4, -score / 2) : score
}

function algorithmSpaces(search, target, partial) {
  let seenLen = 0
  let generation = ++seenGeneration
  let score = 0
  let result = null
  let previousFirst = 0
  let searches = search.parts
  let changesLen = 0
  let matched = false

  for(let i = 0; i < searches.length; i++) {
    partials[i] = -INF
    if(partial) (partIndexes[i] ||= []).length = 0
    result = algorithm(searches[i], target, false, false, changesLen !== 0, false)
    if(result === null) {
      if(partial) continue
      resetBeginnings(target, changesLen)
      return null
    }
    matched = true

    if(i < searches.length - 1) {
      let indexes = result._indexes
      let consecutive = true
      for(let j = 0; j < indexes.len - 1; j++) if(indexes[j + 1] - indexes[j] !== 1) {
        consecutive = false
        break
      }
      if(consecutive) {
        let beginning = indexes[indexes.len - 1] + 1
        let previous = target._nextBeginningIndexes[beginning - 1]
        for(let j = beginning - 1; j >= 0 && target._nextBeginningIndexes[j] === previous; j--) {
          target._nextBeginningIndexes[j] = beginning
          changes[changesLen * 2] = j
          changes[changesLen * 2 + 1] = previous
          changesLen++
        }
      }
    }

    if(partial) {
      let indexes = partIndexes[i]
      indexes.length = result._indexes.len
      for(let j = 0; j < indexes.length; j++) indexes[j] = result._indexes[j]
    }
    let partScore = result._score / searches.length
    score += partScore
    partials[i] = partScore
    if(result._indexes[0] < previousFirst) score -= (previousFirst - result._indexes[0]) * 2
    previousFirst = result._indexes[0]

    if(!partial) for(let j = 0; j < result._indexes.len; j++) {
      let index = result._indexes[j]
      if(seenAt[index] === generation) continue
      seenAt[index] = generation
      seen[seenLen++] = index
    }
  }

  if(partial && !matched) return null
  resetBeginnings(target, changesLen)

  if(target._bitflags & SPACE_BIT) {
    let spacedResult = algorithm(search, target, true)
    if(spacedResult !== null && spacedResult._score > score) {
      if(partial) {
        let searchFrom = 0
        for(let i = 0; i < searches.length; i++) {
          partials[i] = spacedResult._score / searches.length
          let part = searches[i]._lower
          let searchI = search._lower.indexOf(part, searchFrom)
          let indexes = partIndexes[i]
          indexes.length = part.length
          for(let j = 0; j < part.length; j++) indexes[j] = spacedResult._indexes[searchI + j]
          searchFrom = searchI + part.length
        }
        if(spacedResult._score < GOOD_PART_SCORE) spacedResult._indexes.len = 0
      }
      return spacedResult
    }
  }

  if(partial) {
    result = target
    let targetLower = target._targetLower
    for(let i = 1; i < searches.length; i++) {
      let previous = partIndexes[i - 1]
      if(!previous.length || !partIndexes[i].length) continue
      let previousEnd = previous[previous.length - 1] + 1
      let at = previousEnd
      let code
      while((code = targetLower.charCodeAt(at)) === 32 || code >= 9 && code <= 13) at++
      let part = searches[i]._lower
      if(!targetLower.startsWith(part, at)) continue
      for(let j = previousEnd; j < at; j++) previous.push(j)
      let indexes = partIndexes[i]
      indexes.length = part.length
      for(let j = 0; j < part.length; j++) indexes[j] = at + j
    }
    result._indexes.len = 0
    for(let i = 0; i < searches.length; i++) if(partials[i] * searches.length >= GOOD_PART_SCORE) {
      appendIndexes(result._indexes, partIndexes[i])
    }
  } else {
    for(let i = 0; i < seenLen; i++) result._indexes[i] = seen[i]
    result._indexes.len = seenLen
  }
  result._score = score
  return result
}

function resetBeginnings(target, changesLen) {
  for(let i = changesLen - 1; i >= 0; i--) {
    target._nextBeginningIndexes[changes[i * 2]] = changes[i * 2 + 1]
  }
}


class SnapshotTargets {
  constructor(targets, options) {
    this._mode = options?.keys ? 2 : options?.key ? 1 : 0
    this._keys = this._mode === 2 ? options.keys.slice() : [options?.key]
    this._input = targets.slice()
    this._index = 0
    this._done = false
    this._error = null
    this._scheduled = null

    if(targets.length === 0) this._finish()
    else this._schedule()
  }

  _schedule() {
    if(this._scheduled !== null) return
    this._scheduled = scheduleTask(deadline => {
      this._scheduled = null
      this._run(deadline)
    })
  }

  _cancel() {
    if(this._scheduled !== null) this._scheduled()
    this._scheduled = null
  }

  _initialize() {
    if(this._targets) return
    let keysLength = this._mode === 2 ? this._keys.length : 1
    let valueCount = this._input.length * keysLength
    let rowCount = this._input.length
    this._targets = new Array(valueCount)
    this._first = new Uint16Array(valueCount * 26)
    this._offsets = new Uint32Array(valueCount + 1)
    this._buildingBeginnings = []
    this._rowCount = rowCount
    this._rowWords = rowCount + 31 >> 5
    this._rowBits = new Uint32Array(this._rowWords * 32)
    this._rows = new Uint32Array(rowCount)
    this._lastRowsLen = 0
    this._matchedRowsLen = 0
    this._lastQuery = null
    this._candidateRows = null
    this._candidateLength = rowCount
    this._history = []
    if(this._mode) {
      this._objects = this._input
      this._getters = this._keys.map(makeGetter)
    }
    if(this._mode === 2) {
      this._keysLength = keysLength
      this._bitflags = new Int32Array(rowCount)
    }
  }

  _run(deadline) {
    if(this._done || this._error) return
    let end = Date.now() + 4
    let hasTime = () => deadline && !deadline.didTimeout ? deadline.timeRemaining() > 1 : Date.now() < end
    try {
      this._initialize()
      do this._prepareOne()
      while(this._index < this._input.length && hasTime())
      if(this._index === this._input.length) this._complete()
      else this._schedule()
    } catch(error) {
      this._error = error
      this._done = true
    }
  }

  _indexRow(row, bitflags) {
    let flags = bitflags >>> 0
    let word = row >> 5
    let mask = 1 << (row & 31)
    let words = this._rowWords
    let bits = this._rowBits
    while(flags) {
      let lowest = flags & -flags
      let bit = 31 - Math.clz32(lowest)
      bits[bit * words + word] |= mask
      flags = (flags & flags - 1) >>> 0
    }
  }

  _prepareOne() {
    let i = this._index++
    let mode = this._mode
    let obj = this._input[i]
    let keysLength = mode === 2 ? this._keysLength : 1
    let bitflags = 0

    for(let k = 0; k < keysLength; k++) {
      let value = mode === 0 ? obj
        : this._getters[k] === null ? obj[this._keys[k]] : this._getters[k](obj)
      let row = mode === 2 ? i * keysLength + k : i
      let prepared = this._targets[row] = value ? prepTarget(value) : noTarget
      if(prepared !== noTarget) indexBeginnings(prepared, this._first, row, this._buildingBeginnings)
      this._offsets[row + 1] = this._buildingBeginnings.length
      bitflags |= prepared._bitflags
    }

    if(mode === 2) this._bitflags[i] = bitflags
    this._indexRow(i, bitflags)
  }

  _complete() {
    this._beginnings = Uint16Array.from(this._buildingBeginnings)
    this._buildingBeginnings = this._input = this._getters = this._keys = null
    this._done = true
  }

  _bitOffsets(bitflags) {
    let offsetsLen = 0
    let words = this._rowWords
    for(let bit = 0; bit < 32; bit++) if(bitflags & 1 << bit) candidateBitOffsets[offsetsLen++] = bit * words
    return offsetsLen
  }

  _matchRows(bitflags, fill = false, stop = INF) {
    let offsetsLen = this._bitOffsets(bitflags)
    if(!offsetsLen) {
      if(fill) {
        this._candidateRows = null
        this._candidateLength = this._rowCount
      }
      return this._rowCount
    }

    let bits = this._rowBits
    let words = this._rowWords
    let rowsLen = 0
    for(let word = 0; word < words; word++) {
      let matches = bits[candidateBitOffsets[0] + word]
      for(let i = 1; i < offsetsLen && matches; i++) matches &= bits[candidateBitOffsets[i] + word]
      if(!fill) {
        rowsLen += bitCount(matches)
        if(rowsLen >= stop) return rowsLen
        continue
      }
      while(matches) {
        let lowest = matches & -matches
        this._rows[rowsLen++] = (word << 5) + 31 - Math.clz32(lowest)
        matches = (matches & matches - 1) >>> 0
      }
    }
    if(fill) {
      this._candidateRows = this._rows
      this._candidateLength = rowsLen
    }
    return rowsLen
  }

  _beginSearch(query) {
    this._matchedRowsLen = 0
    let previousQuery = this._lastQuery
    let previousLength = this._lastRowsLen
    this._lastQuery = null
    let bitflags = query.bitflags >>> 0

    if(previousQuery !== null && query._lower.startsWith(previousQuery)) {
      let staticCount = this._matchRows(bitflags, false, previousLength)
      if(previousLength <= staticCount) {
        this._candidateRows = this._rows
        this._candidateLength = previousLength
        return
      }
    }
    this._matchRows(bitflags, true)
  }

  _endSearch(query) {
    this._lastRowsLen = this._matchedRowsLen
    this._matchedRowsLen = 0
    this._lastQuery = query._lower || null
    this._candidateRows = null
    this._candidateLength = 0
  }

  _backtrack(query, options) {
    let history = this._history
    if(history.length < 2 || options?.scoreFn || options?.threshold !== undefined) return null
    let limit = getLimit(options)
    if(limit === INF) return null

    let current = history[history.length - 1]
    let value = query._lower
    if(current.query === value && current.limit === limit && current.results) return copyResults(current.results)
    if(value.length >= current.query.length || !current.query.startsWith(value)) return null

    let i = history.length - 2
    while(i >= 0 && history[i].query.length > value.length) i--
    let entry = history[i]
    if(!entry || entry.query !== value || entry.limit !== limit) return null

    history.length = i + 1
    if(!entry.results) return null
    this._resetSearch()
    return copyResults(entry.results)
  }

  _remember(query, results, options) {
    let history = this._history
    let limit = getLimit(options)
    if(options?.scoreFn || options?.threshold !== undefined || limit === INF || results.length > 256) {
      history.length = 0
      return
    }

    let value = query._lower
    let last = history[history.length - 1]
    if(last && !value.startsWith(last.query)) history.length = 0
    else if(last?.query === value && last.limit === limit) history.pop()
    history.push({query:value, limit, results:value.length <= 32 ? copyResults(results) : null})
  }

  _resetSearch() {
    this._lastQuery = null
    this._lastRowsLen = this._matchedRowsLen = this._candidateLength = 0
    this._candidateRows = null
  }

  _finish() {
    if(this._error) throw this._error
    if(this._done) return
    this._cancel()
    try {
      this._initialize()
      while(this._index < this._input.length) this._prepareOne()
      this._complete()
    } catch(error) {
      this._error = error
      this._done = true
      throw error
    }
  }
}

function copyResult(result) {
  if(result === noTarget) return noTarget
  if(result instanceof KeysResult) {
    let copy = result.map(copyResult)
    copy.obj = result.obj
    copy._score = result._score
    if(result._partWinners) copy._partWinners = true
    return copy
  }
  let copy = materialize(result, result.obj)
  if(result._bestKeyScore !== undefined) copy._bestKeyScore = result._bestKeyScore
  let indexes = result._indexes
  copy._indexes = indexes.slice(0, indexes.len ?? indexes.length)
  copy._indexes.len = copy._indexes.length
  return copy
}

function copyResults(results) {
  let copies = results.map(copyResult)
  copies.total = results.total
  return copies
}

function prepTarget(target) {
  if(isPrepared(target)) target = target.target
  else if(typeof target === 'number') target = '' + target
  else if(typeof target !== 'string') target = ''
  let info = lowerInfo(target)
  return newResult(target, -INF, null, info._lower, info.lowerCodes, info.bitflags)
}

function prepQuery(search) {
  if(typeof search === 'number') search = '' + search
  else if(typeof search !== 'string') search = ''
  search = remapChars(search).trim()
  let info = lowerInfoRemapped(search)
  info.bitflags &= ~SPACE_BIT
  info.parts = info.hasSpace ? [...new Set(info._lower.split(/\s+/))].map(prepQuery) : []
  return info
}

function getPrepared(target) {
  if(target.length > 999) return prepTarget(target)
  let prepared = targetCache.get(target)
  if(prepared === undefined) targetCache.set(target, prepared = prepTarget(target))
  return prepared
}

function getQuery(search) {
  if(search.length > 999) return prepQuery(search)
  let prepared = searchCache.get(search)
  if(prepared === undefined) {
    if(searchCache.size >= 512) searchCache.clear()
    searchCache.set(search, prepared = prepQuery(search))
  }
  return prepared
}

function scanBeginnings(prepared, visit) {
  let target = remapChars(prepared.target)
  let wasUpper = false
  let wasAlnum = false
  let count = 0

  for(let i = 0; i < target.length; i++) {
    let code = target.charCodeAt(i)
    let upper = code >= 65 && code <= 90
    let alnum = upper || code >= 97 && code <= 122 || code >= 48 && code <= 57
    let beginning = upper && !wasUpper || !wasAlnum || !alnum
    wasUpper = upper
    wasAlnum = alnum
    if(beginning) {
      count++
      visit(i)
    }
  }
  prepared._beginningsLen = count
}

function indexBeginnings(prepared, firstTable, row, packed) {
  if(prepared.target.length >= 65535) return
  let target = remapChars(prepared.target)
  let lowerCodes = prepared._targetLowerCodes
  let offset = row * 26
  let wasUpper = false
  let wasAlnum = false
  let count = 0

  for(let i = 0; i < target.length; i++) {
    let code = target.charCodeAt(i)
    let upper = code >= 65 && code <= 90
    let alnum = upper || code >= 97 && code <= 122 || code >= 48 && code <= 57
    let beginning = upper && !wasUpper || !wasAlnum || !alnum
    wasUpper = upper
    wasAlnum = alnum
    if(!beginning) continue

    count++
    packed.push(i)
    code = lowerCodes[i]
    if(code >= 97 && code <= 122) {
      let slot = offset + code - 97
      if(firstTable[slot] === 0) firstTable[slot] = i + 1
    }
  }
  prepared._beginningsLen = count
}

function prepareSingleMatch(prepared, searchCode, fallbackIndex) {
  let matchI = fallbackIndex
  let strict = false
  scanBeginnings(prepared, i => {
    if(!strict && searchCode === prepared._targetLowerCodes[i]) {
      matchI = i
      strict = true
    }
  })
  prepared._singleMatchCode = searchCode
  prepared._singleMatchIndex = matchI
  prepared._singleMatchStrict = strict
}

function makeBeginnings(prepared) {
  let beginnings = []
  scanBeginnings(prepared, i => beginnings.push(i))
  return beginnings
}

function makeNextBeginnings(prepared) {
  let next = []
  let fill = 0
  scanBeginnings(prepared, i => {
    for(; fill < i; fill++) next[fill] = i
  })
  for(; fill < prepared.target.length; fill++) next[fill] = prepared.target.length
  return next
}

function remapCharacter(char) {
  let remapped = remappings[char]
  if(remapped !== undefined) return remapped
  if(char.charCodeAt(0) < 128) return char
  remapped = char.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  return remapped.length === 1 ? remapped : char
}

function remapChars(value) {
  if(customAsciiRemappings) return value.replace(/[\s\S]/g, remapCharacter)
  return /[^\x00-\x7F]|[\\"`]/.test(value) ? value.replace(/[^\x00-\x7F]|[\\"`]/g, remapCharacter) : value
}

function lowerInfo(value) {
  return lowerInfoRemapped(remapChars(value))
}

function lowerInfoRemapped(value) {
  let lower = value.toLowerCase()
  let lowerCodes = []
  let bitflags = 0
  let hasSpace = false

  for(let i = 0; i < lower.length; i++) {
    let code = lowerCodes[i] = lower.charCodeAt(i)
    if(code === 32) {
      hasSpace = true
      bitflags |= SPACE_BIT
      continue
    }
    let bit = code >= 97 && code <= 122 ? code - 97
      : code >= 48 && code <= 57 ? 26
      : code <= 127 ? 30 : 31
    bitflags |= 1 << bit
  }
  return {lowerCodes, bitflags, hasSpace, _lower: lower}
}


class Result {
  get ['indexes']() { return this._indexes.slice(0, this._indexes.len).sort((a, b) => a - b) }
  set ['indexes'](value) { this._indexes = value }
  ['highlight'](open, close, threshold) { return highlight(this, open, close, threshold) }
  get ['score']() { return normalizeScore(this._score) }
}

class KeysResult extends Array {
  get ['score']() { return normalizeScore(this._score) }
}

function newResult(target, score = -INF, obj = null, lower = '', lowerCodes = null, bitflags = 0) {
  let result = new Result()
  result.target = target
  result.obj = obj
  result._score = score
  result._indexes = []
  result._targetLower = lower
  result._targetLowerCodes = lowerCodes
  result._nextBeginningIndexes = null
  result._beginnings = null
  result._beginningsLen = 0
  result._singleMatchCode = result._singleMatchIndex = -1
  result._singleMatchStrict = false
  result._bitflags = bitflags
  return result
}

function materialize(prepared, obj = null) {
  let result = new Result()
  result.target = prepared.target
  result.obj = obj
  result._score = prepared._score
  result._indexes = prepared._indexes
  return result
}

function markBestKeyScore(result) {
  let best = -INF
  for(let i = 0; i < result.length; i++) if(result[i] !== noTarget && result[i]._score > best) best = result[i]._score
  for(let i = 0; i < result.length; i++) if(result[i] !== noTarget) result[i]._bestKeyScore = best
  return result
}

function captureKeysResult(matches, keysLength, obj, score, partWinners = false) {
  let result = new KeysResult(keysLength)
  for(let k = 0; k < keysLength; k++) result[k] = matches[k]
  result.obj = obj
  result._score = score
  if(partWinners) result._partWinners = true
  return result
}

let normalizeScore = value => value === -INF ? 0 : value > 1 ? value : Math.E ** (((-value + 1) ** .04307 - 1) * -2)
let denormalizeScore = value => value === 0 ? -INF : value > 1 ? value : 1 - Math.pow(Math.log(value) / -2 + 1, 1 / .04307)
let GOOD_PART_SCORE = denormalizeScore(.5)
let isPrepared = value => typeof value === 'object' && typeof value?._bitflags === 'number'

function makeGetter(key) {
  if(typeof key === 'function') return key
  let path = Array.isArray(key) ? key
    : typeof key === 'string' && key.includes('.') ? key.split('.') : null
  if(path === null) return null
  return obj => {
    if(path !== key) {
      let direct = obj[key]
      if(direct !== undefined) return direct
    }
    for(let i = 0; obj && i < path.length; i++) obj = obj[path[i]]
    return obj
  }
}

function scoreCeiling(searchLen, targetLen) {
  let lengthPenalty = (targetLen - searchLen) / 2
  let bonus = 1 + searchLen * searchLen
  let score = -lengthPenalty - lengthPenalty / (bonus * bonus)
  return score + Math.min(4, -score / 2)
}

function bitCount(value) {
  value -= value >>> 1 & 0x55555555
  value = (value & 0x33333333) + (value >>> 2 & 0x33333333)
  return ((value + (value >>> 4) & 0x0F0F0F0F) * 0x01010101 >>> 24)
}

function lowerBound(values, start, end, value) {
  while(start < end) {
    let middle = start + end >> 1
    if(values[middle] < value) start = middle + 1
    else end = middle
  }
  return start
}

function nextBeginning(indexes, start, end, index, targetLen) {
  let next = lowerBound(indexes, start, end, index + 1)
  return next < end ? indexes[next] : targetLen
}

function isBeginning(indexes, start, end, index) {
  let found = lowerBound(indexes, start, end, index)
  return found < end && indexes[found] === index
}

function getLimit(options) {
  return (options?.limit ?? 10) || INF
}

function scheduleTask(run) {
  let id
  if(typeof requestIdleCallback === 'function') {
    id = requestIdleCallback(run, {timeout: 100})
    return () => typeof cancelIdleCallback === 'function' && cancelIdleCallback(id)
  }
  if(typeof setImmediate === 'function') {
    id = setImmediate(run)
    return () => typeof clearImmediate === 'function' && clearImmediate(id)
  }
  id = setTimeout(run)
  return () => clearTimeout(id)
}

function createHeap() {
  let items = []
  let length = 0

  function down() {
    let index = 0
    let item = items[0]
    for(let child = 1; child < length; child = 1 + index * 2) {
      let right = child + 1
      index = right < length && items[right]._score < items[child]._score ? right : child
      items[(index - 1) >> 1] = items[index]
    }
    for(let parent = (index - 1) >> 1; index > 0 && item._score < items[parent]._score; parent = (index = parent) - 1 >> 1) {
      items[index] = items[parent]
    }
    items[index] = item
  }

  return {
    add(item) {
      let index = length++
      for(let parent = (index - 1) >> 1; index > 0 && item._score < items[parent]._score; parent = (index = parent) - 1 >> 1) {
        items[index] = items[parent]
      }
      items[index] = item
    },
    poll() {
      if(!length) return
      let root = items[0]
      let last = items[--length]
      items[length] = undefined
      if(length) {
        items[0] = last
        down()
      }
      return root
    },
    peek() { return length ? items[0] : undefined },
    replaceTop(item) {
      items[0] = item
      down()
    },
    clear() { items.length = length = 0 },
  }
}


let INF = Infinity
let SPACE_BIT = 1 << 27
let noResults = []
noResults.total = 0

let targetCache = new Map(), searchCache = new Map()

let simpleMatch = [], strictMatch = []
let seen = [], seenAt = []
let changes = [], partials = [], spaceScores = []
let partIndexes = [], winnerIndexes = [], winnerScores = [], winnerKeys = []
let keyTargets = [], keyResults = []
let candidateBitOffsets = []
let seenGeneration = 0

let remappings = {}
let remapFrom = '\\"`‘’‚‛“”„‟«»‹›‐–—−⁄∕…øØłŁđĐðÐıħĦŧŦ'
let remapTo   =  "/''''''''''''''----//.oOlLdDdDihHtT"
for(let i = 0; i < remapFrom.length; i++) remappings[remapFrom[i]] = remapTo[i]
let customAsciiRemappings = false

let heap = createHeap()

let noTarget = prepTarget('')
let prunedMatch = {}

return {single, go, highlight, score, remap, prepare, snapshot, cleanup}

})();
/**
 * Multilingual fuzzy search over an in-memory list.
 *
 * A {@link TextSearchIndex} prepares every key of a list once, then answers
 * any number of queries over that list. `fuzzy` keys (names, titles, labels,
 * readable ids) match as substrings or as fuzzysort subsequences that start at
 * a word start, so `cpt` finds `compact` while `fab` does not match inside
 * `Refactor build`. `substring` keys (descriptions, prompts, paths, opaque
 * ids) match only as a contiguous substring of each query term: a subsequence
 * scattered across a long sentence is noise. Every key may carry several
 * values, such as every language of a localized title. Both key kinds ignore
 * case, width (NFKC), U+0300–U+036F diacritics, and the stroke of letters such
 * as `ł` and `ø`. Matching requires every whitespace-separated query term to
 * match some key of the item.
 *
 * Each term scores by its best tier: a fuzzy-key prefix, then a fuzzy-key
 * substring, then a fuzzy subsequence ordered by fuzzysort score, then a
 * substring-key hit. Equal scores keep the build order, so a term that
 * prefixes every name leaves the list in product order.
 *
 * @module @deepseek-ai/dsh-util-text-search
 */
/** Tier bases; a fuzzy subsequence hit adds its fuzzysort score in [0, 1) to its base. */
const FUZZY_PREFIX = 4;
const FUZZY_SUBSTRING = 3;
const FUZZY_SUBSEQUENCE = 2;
const SUBSTRING = 1;
/**
 * Every language of a localized value.
 * @param text - plain or localized text.
 * @returns the plain string, or every locale's value; none when absent.
 */
function localizedValues(text) {
    if (text === undefined)
        return [];
    return typeof text === 'string' ? [text] : Object.values(text);
}
const WORD_CHAR = /[\p{L}\p{N}]/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
/** Scripts written without spaces between words; each of their characters starts a word. */
const UNSPACED = /[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}\p{scx=Hang}]/u;
/** The code point starting at UTF-16 offset `index`, which callers keep inside `text`. */
function codePointAt(text, index) {
    return String.fromCodePoint(text.codePointAt(index));
}
/** The code point ending just before UTF-16 offset `index`. */
function codePointBefore(text, index) {
    const low = text.charCodeAt(index - 1);
    const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
    return codePointAt(text, start);
}
/**
 * Whether the code point at UTF-16 offset `index` of `text` starts a word: after a separator,
 * at a camel-case hump, or in an unspaced script.
 */
function wordStart(text, index) {
    if (index === 0)
        return true;
    const char = codePointAt(text, index);
    const previous = codePointBefore(text, index);
    return !WORD_CHAR.test(previous) || UNSPACED.test(char) || (UPPER.test(char) && LOWER.test(previous));
}
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
/** Combining diacritical marks; other scripts' combining marks, such as kana voicing or Indic vowel signs, change the letter and stay. */
const DIACRITIC = /[\u0300-\u036f]/gu;
/** Letters with a built-in stroke that decomposition leaves intact, mapped to their base letter. */
const STROKED = {
    'ø': 'o', 'Ø': 'O', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'ı': 'i', 'ħ': 'h', 'Ħ': 'H', 'ŧ': 't', 'Ŧ': 'T',
};
const STROKED_CHAR = /[øØłŁđĐðÐıħĦŧŦ]/gu;
/** Width- and diacritic-insensitive form that keeps case, so camel-case humps survive for word starts. */
function strip(value) {
    // Printable ASCII has no width forms or combining marks, and most keys are ASCII.
    if (PRINTABLE_ASCII.test(value))
        return value;
    return value.normalize('NFKD').replace(DIACRITIC, '').normalize('NFKC').replace(STROKED_CHAR, char => STROKED[char]);
}
/** Case-, width-, and diacritic-insensitive form used for substring tests. */
function fold(value) {
    return strip(value).toLowerCase();
}
/**
 * Prepare one item's keys, reusing an earlier index's preparation of the same string.
 * @param keys - the item's search text.
 * @param reuse - preparations of the index being updated, if any.
 * @param into - preparations of the index being built; receives every string this item uses.
 */
function prepareKeys(keys, reuse, into) {
    const fuzzy = (keys.fuzzy ?? []).flatMap((value) => {
        if (value === undefined || value === '')
            return [];
        let name = into.fuzzy.get(value) ?? reuse?.fuzzy.get(value);
        if (name === undefined) {
            const stripped = strip(value);
            name = { stripped, folded: stripped.toLowerCase(), starts: undefined, tails: new Map() };
        }
        into.fuzzy.set(value, name);
        return [name];
    });
    const substring = (keys.substring ?? []).flatMap((value) => {
        if (value === undefined || value === '')
            return [];
        const folded = into.substring.get(value) ?? reuse?.substring.get(value) ?? fold(value);
        into.substring.set(value, folded);
        return [folded];
    });
    return { fuzzy, substring };
}
/** Prepare every item's keys. */
function build(items, keys, reuse) {
    const preparations = { fuzzy: new Map(), substring: new Map() };
    return { keys: items.map(item => prepareKeys(keys(item), reuse, preparations)), preparations };
}
/** Whether every character of `term` occurs in `text` in order; a cheap filter before fuzzysort. */
function inOrder(term, text) {
    let at = 0;
    for (const char of term) {
        at = text.indexOf(char, at);
        if (at === -1)
            return false;
        at += char.length;
    }
    return true;
}
/**
 * The best fuzzysort score of a term over the subsequences of `name` that start at a word start.
 * fuzzysort reports one alignment per target, so each word start whose character equals the term's
 * first character is tried as its own target.
 */
function fuzzyNameScore(term, name) {
    if (!inOrder(term.folded, name.folded))
        return undefined;
    if (name.starts === undefined) {
        const starts = [];
        let index = 0;
        for (const char of name.stripped) {
            if (wordStart(name.stripped, index))
                starts.push(index);
            index += char.length;
        }
        name.starts = starts;
    }
    const first = codePointAt(term.stripped, 0).toLowerCase();
    let best;
    for (const start of name.starts) {
        if (codePointAt(name.stripped, start).toLowerCase() !== first)
            continue;
        let tail = name.tails.get(start);
        if (tail === undefined) {
            // An uncached target: fuzzysort's own target cache would grow with every distinct name for the process lifetime.
            tail = fuzzysort.prepare(name.stripped.slice(start));
            name.tails.set(start, tail);
        }
        const result = fuzzysort.single(term.stripped, tail);
        if (result !== null && wordStart(name.stripped, start + result.indexes[0])) {
            best = best === undefined ? result.score : Math.max(best, result.score);
        }
    }
    return best;
}
/** The best score of one term over one item's keys, or undefined when no key matches. */
function termScore(term, keys) {
    let best;
    const take = (score) => { best = best === undefined ? score : Math.max(best, score); };
    for (const name of keys.fuzzy) {
        const at = name.folded.indexOf(term.folded);
        if (at === 0)
            take(FUZZY_PREFIX);
        else if (at > 0)
            take(FUZZY_SUBSTRING);
        else {
            const score = fuzzyNameScore(term, name);
            // A fuzzysort score of 1 is reserved for exact matches, which the prefix tier already took.
            if (score !== undefined)
                take(FUZZY_SUBSEQUENCE + Math.min(score, 0.99));
        }
    }
    for (const text of keys.substring) {
        if (text.includes(term.folded))
            take(SUBSTRING);
    }
    return best;
}
/**
 * Search index over one list. The constructor prepares every key of every
 * item; {@link TextSearchIndex.search} then answers queries without
 * re-reading the items or their keys. An index holds its list by reference and
 * never changes: callers must not mutate the list or its items, and call
 * {@link TextSearchIndex.update} with a new list when the list or any item's
 * keys change.
 */
class TextSearchIndex {
    #items;
    #keys;
    #preparations;
    /**
     * Prepare every key of every item.
     * @param items - candidates in their display order, which ties keep.
     * @param keys - the search text of one item, called once per item here.
     */
    constructor(items, keys) {
        const built = build(items, keys, undefined);
        this.#items = items;
        this.#keys = built.keys;
        this.#preparations = built.preparations;
    }
    /**
     * Build the index of a changed list. Items added, removed, reordered, or
     * changed are all expressed by the complete new list; a key string that this
     * index already prepared is reused instead of prepared again, and strings no
     * item uses any more are not carried over. This index stays valid.
     * @param items - the complete new list in display order.
     * @param keys - the search text of one item, called once per item here.
     * @returns a new index over `items`.
     */
    update(items, keys) {
        const next = new TextSearchIndex([], keys);
        const built = build(items, keys, this.#preparations);
        next.#items = items;
        next.#keys = built.keys;
        next.#preparations = built.preparations;
        return next;
    }
    /**
     * Filter and rank the indexed items by a query.
     * @param query - the user's search text.
     * @returns the build list itself when the query is blank or holds only
     * combining marks; otherwise the items matching every query term, best total
     * score first and build order on ties.
     */
    search(query) {
        // A term made only of combining marks folds to nothing and constrains nothing.
        const terms = query.trim().split(/\s+/u)
            .map((term) => ({ stripped: strip(term), folded: fold(term) }))
            .filter(term => term.folded !== '');
        if (terms.length === 0)
            return this.#items;
        const ranked = [];
        this.#keys.forEach((itemKeys, index) => {
            let score = 0;
            for (const term of terms) {
                const hit = termScore(term, itemKeys);
                if (hit === undefined)
                    return;
                score += hit;
            }
            ranked.push({ index, score });
        });
        ranked.sort((left, right) => right.score - left.score || left.index - right.index);
        return ranked.map(entry => this.#items[entry.index]);
    }
}

return { TextSearchIndex, localizedValues };
})();
		// End Harness multilingual search.
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region ../../util/values/src/partial-json.ts
		/**
		* Lazily scanned view of one JSON object's top-level fields, built from text
		* that may still be streaming or from an already parsed object. Nothing is
		* scanned until a reader asks; the view remembers every question it answered
		* and reports changed answers when the owner refreshes for publication.
		* Used for model tool-call arguments: a row reads the fields it
		* cares about at whatever granularity it displays, at every stage of the call.
		* @module @deepseek-ai/dsh-util-values/src/partial-json
		*/
		const SIMPLE_ESCAPES = {
			"\"": "\"",
			"\\": "\\",
			"/": "/",
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "	"
		};
		const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
		function isWhitespace(c) {
			return c === " " || c === "\n" || c === "\r" || c === "	";
		}
		function isHex(c) {
			return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
		}
		(class PartialArguments {
			/** The view of a call with no arguments available. */
			static EMPTY = PartialArguments.fromObject({});
			/**
			* View finished argument text without scanning it until a reader asks.
			* @param text - the complete argument JSON text.
			* @returns a sealed view.
			*/
			static fromText(text) {
				const view = new PartialArguments();
				view.append(text);
				view.sealed = true;
				return view;
			}
			/**
			* View an already parsed argument payload, such as a PTC dispatch object.
			* @param value - the parsed argument value.
			* @returns a sealed view; a non-object payload has no fields.
			*/
			static fromObject(value) {
				const view = new PartialArguments();
				view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
				view.sealed = true;
				return view;
			}
			/**
			* The source: text so far or a parsed object, plus whether it can still grow.
			* These are the only enumerable fields, so two views over the same source
			* compare equal structurally however far each has been read.
			*/
			chunks = [];
			object;
			sealed = false;
			#ends = [];
			#size = 0;
			#consumed = 0;
			#mode = "root";
			#escape = false;
			#keyStart = 0;
			#keyEscaped = false;
			#key = "";
			#current = null;
			#nestedEnds = [];
			#nestedInString = false;
			#invalidAt;
			#invalidValue = false;
			#entries = /* @__PURE__ */ new Map();
			#order = [];
			#reads = /* @__PURE__ */ new Map();
			/** Whether this view rejects further appends; does not scan text or register reads. */
			get isSealed() {
				return this.sealed;
			}
			/** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
			get invalid() {
				this.scan();
				return this.#mode === "invalid" || this.#invalidValue;
			}
			/**
			* Retain streamed argument text without scanning or comparing observed answers.
			* @param fragment - the text following every fragment appended before.
			*/
			append(fragment) {
				if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
				if (fragment.length === 0) return;
				this.chunks.push(fragment);
				this.#size += fragment.length;
				this.#ends.push(this.#size);
			}
			/**
			* Reconcile a streamed prefix with authoritative complete text without joining the fragments.
			* @param text - the final argument text, which replaces missing or conflicting deltas.
			* @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
			*/
			settle(text) {
				if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
				let offset = 0;
				for (const chunk of this.chunks) {
					if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
					offset += chunk.length;
				}
				this.chunks = text.length === 0 ? [] : [text];
				this.#ends = text.length === 0 ? [] : [text.length];
				this.sealed = true;
				return this;
			}
			/**
			* Compare observed answers and advance their publication baseline. Unread views remain unscanned.
			* @returns whether any observed answer changed since its first read or the preceding refresh.
			*/
			refresh() {
				if (this.#reads.size === 0) return false;
				this.scan();
				let changed = false;
				let completions = false;
				for (const read of this.#reads.values()) {
					if (read.completion) {
						completions = true;
						continue;
					}
					changed = this.refreshRead(read) || changed;
				}
				if (completions) {
					for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
				}
				if (this.sealed) this.#reads.clear();
				return changed;
			}
			refreshRead(read) {
				const now = read.answer();
				if (Object.is(now, read.last)) return false;
				read.last = now;
				return true;
			}
			/**
			* Check whether no further fields can arrive.
			* @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
			*/
			closed() {
				return this.remember("closed", "", () => this.closedNow());
			}
			/**
			* List discovered fields in first-appearance order.
			* @returns top-level keys seen so far, in first-appearance order.
			*/
			keys() {
				return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
			}
			/**
			* Check whether a top-level field has appeared.
			* @param key - argument name.
			* @returns whether the field has appeared (a string opened or another value began).
			*/
			has(key) {
				return this.remember("has", key, () => this.hasNow(key));
			}
			/**
			* Check whether a field's closing delimiter has arrived, without validating its contents.
			* @param key - argument name.
			* @returns whether its delimiter arrived and no content reader has reported an error for this value.
			*/
			complete(key) {
				return this.remember("complete", key, () => this.completeNow(key));
			}
			/**
			* Read string length without materializing its text.
			* @param key - argument name.
			* @param options - change granularity for a streaming string.
			* @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
			*/
			stringLength(key, options) {
				const step = Math.max(1, Math.floor(options?.step ?? 1));
				const offset = options?.offset ?? 0;
				return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
			}
			/**
			* Check a string against a decoded UTF-16 length limit without materializing it.
			* @param key - argument name.
			* @param maxLength - decoded UTF-16 limit, floored to at least zero.
			* @returns whether the string is longer than the limit; false when absent or not a string.
			*/
			stringExceeds(key, maxLength) {
				const limit = Math.max(0, Math.floor(maxLength));
				return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
			}
			/**
			* Read a decoded string, including a streaming prefix.
			* @param key - argument name.
			* @returns the string field's decoded text so far; undefined when absent or not a string.
			*/
			text(key) {
				return this.remember("text", key, () => this.textNow(key));
			}
			/**
			* Read at most the first decoded UTF-16 units of a string.
			* @param key - argument name.
			* @param maxLength - maximum decoded UTF-16 length, floored to at least one.
			* @returns the bounded string prefix; undefined when absent or not a string.
			*/
			textPrefix(key, maxLength) {
				const limit = Math.max(1, Math.floor(maxLength));
				return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
			}
			/**
			* Read a completed non-string argument.
			* @param key - argument name.
			* @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
			*/
			value(key) {
				return this.remember("value", key, () => this.valueNow(key));
			}
			/** Answer a question and, on a streaming view, remember it for change detection. */
			remember(kind, key, read, comparison) {
				this.scan();
				const result = read();
				if (!this.sealed) {
					const id = `${kind}/${key}`;
					if (!this.#reads.has(id)) this.#reads.set(id, {
						completion: kind === "complete",
						answer: comparison === void 0 ? read : () => comparison(read()),
						last: comparison === void 0 ? result : comparison(result)
					});
				}
				return result;
			}
			closedNow() {
				return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
			}
			keysNow() {
				return this.object === void 0 ? this.#order : Object.keys(this.object);
			}
			hasNow(key) {
				return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
			}
			completeNow(key) {
				if (this.object !== void 0) return Object.hasOwn(this.object, key);
				const entry = this.#entries.get(key);
				return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
			}
			lengthNow(key, limit = Number.POSITIVE_INFINITY) {
				if (this.object !== void 0) {
					const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
					return typeof field === "string" ? field.length : void 0;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "string") return void 0;
				if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
				const read = entry.length ??= {
					at: entry.start,
					length: 0,
					text: ""
				};
				this.readString(entry, read, limit, false);
				return read.length;
			}
			textNow(key) {
				if (this.object !== void 0) {
					const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
					return typeof field === "string" ? field : void 0;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "string") return void 0;
				if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
					let text;
					try {
						text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
					} catch (_error) {}
					if (text !== void 0) entry.text = {
						at: entry.end,
						length: text.length,
						text
					};
				}
				const read = entry.text ??= {
					at: entry.start,
					length: 0,
					text: ""
				};
				this.readString(entry, read, Number.POSITIVE_INFINITY, true);
				return read.text;
			}
			textPrefixNow(key, maxLength) {
				if (this.object !== void 0) {
					const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
					return typeof field === "string" ? field.slice(0, maxLength) : void 0;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "string") return void 0;
				const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
				let read = prefixes.get(maxLength);
				if (read === void 0) {
					read = {
						at: entry.start,
						length: 0,
						text: ""
					};
					prefixes.set(maxLength, read);
				}
				this.readString(entry, read, maxLength, true);
				return read.text;
			}
			valueNow(key) {
				if (this.object !== void 0) {
					if (!Object.hasOwn(this.object, key)) return void 0;
					const field = this.object[key];
					return typeof field === "string" ? void 0 : field;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
				if (entry.parsed === void 0) try {
					entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
				} catch (_error) {
					entry.invalid = true;
					this.#invalidValue = true;
				}
				return entry.parsed;
			}
			chunkAt(at) {
				let low = 0;
				let high = this.#ends.length;
				while (low < high) {
					const mid = low + high >>> 1;
					if (this.#ends[mid] <= at) low = mid + 1;
					else high = mid;
				}
				return low;
			}
			/** Materialize only a requested range, never the cumulative source. */
			slice(start, end) {
				if (start >= end) return "";
				const first = this.chunkAt(start);
				const last = this.chunkAt(end - 1);
				const base = first === 0 ? 0 : this.#ends[first - 1];
				if (first === last) return this.chunks[first].slice(start - base, end - base);
				const parts = [this.chunks[first].slice(start - base)];
				for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
				parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
				return parts.join("");
			}
			readString(entry, read, limit, materialize) {
				const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
				if (!entry.needsDecoding) {
					const length = Math.min(end - read.at, limit - read.length);
					if (length <= 0) return;
					if (materialize) read.text += this.slice(read.at, read.at + length);
					read.at += length;
					read.length += length;
					return;
				}
				let chunkIndex = this.chunkAt(read.at);
				while (read.at < end && read.length < limit) {
					const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
					const chunk = this.chunks[chunkIndex];
					const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
					const boundary = remaining.search(CONTENT_ESCAPE);
					const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
					if (length > 0) {
						if (materialize) read.text += remaining.slice(0, length);
						read.at += length;
						read.length += length;
						if (read.at === base + chunk.length) chunkIndex++;
						continue;
					}
					const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
					let decoded;
					let width = 2;
					if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
					if (remaining[0] === "\\" && type === "u") {
						const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
						let valid = true;
						for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
						if (valid) {
							if (hex.length < 4 && entry.end < 0) return;
							if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
						}
						width = 6;
					} else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
					if (decoded === void 0) {
						entry.invalidAt = read.at;
						this.#invalidValue = true;
						return;
					}
					if (materialize) read.text += decoded;
					read.length++;
					read.at += width;
					while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
				}
			}
			/** Locate new field ranges without decoding or parsing their contents. */
			scan() {
				if (this.object !== void 0 || this.#consumed === this.#size) return;
				for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
					const pending = this.chunks[i];
					const base = i === 0 ? 0 : this.#ends[i - 1];
					for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
						if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
							const end = this.stringBoundary(pending, index);
							this.#consumed += end - index;
							index = end;
							if (index === pending.length) break;
						}
						this.step(pending[index], this.#consumed);
						this.#consumed++;
					}
				}
			}
			/** Only raw quotes and their preceding backslash runs can terminate a string. */
			stringBoundary(fragment, start) {
				let at = start;
				while (true) {
					const quote = fragment.indexOf("\"", at);
					const end = quote < 0 ? fragment.length : quote;
					if (this.#mode === "string") {
						const entry = this.#current;
						if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
					}
					let slashStart = end;
					while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
					const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
					this.#escape = quote < 0 && escaped;
					if (quote < 0 || !escaped) return end;
					at = quote + 1;
				}
			}
			step(c, at) {
				switch (this.#mode) {
					case "root":
						if (isWhitespace(c)) return;
						if (c === "{") {
							this.#mode = "key-or-end";
							return;
						}
						this.fail();
						return;
					case "key-or-end":
						if (isWhitespace(c)) return;
						if (c === "}") {
							this.#mode = "closed";
							return;
						}
						if (c === "\"") {
							this.beginKey(at);
							return;
						}
						this.fail();
						return;
					case "key-only":
						if (isWhitespace(c)) return;
						if (c === "\"") {
							this.beginKey(at);
							return;
						}
						this.fail();
						return;
					case "key":
						this.stepKey(c, at);
						return;
					case "colon":
						if (isWhitespace(c)) return;
						if (c === ":") {
							this.#mode = "value";
							return;
						}
						this.fail();
						return;
					case "value":
						this.beginValue(c, at);
						return;
					case "string": {
						const entry = this.#current;
						entry.end = at;
						this.#current = null;
						this.#mode = "comma-or-end";
						return;
					}
					case "scalar":
						this.stepScalar(c, at);
						return;
					case "nested":
						this.stepNested(c, at);
						return;
					case "comma-or-end":
						if (isWhitespace(c)) return;
						if (c === ",") {
							this.#mode = "key-only";
							return;
						}
						if (c === "}") {
							this.#mode = "closed";
							return;
						}
						this.fail();
						return;
					case "closed":
						if (isWhitespace(c)) return;
						this.fail();
						return;
					/* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
					case "invalid": return;
					/* v8 ignore next 2 -- Every scanner mode has a handler above. */
					default: assertNever(this.#mode);
				}
			}
			fail() {
				this.#invalidAt = this.#consumed;
				this.#mode = "invalid";
				this.#current = null;
			}
			beginKey(at) {
				this.#mode = "key";
				this.#keyStart = at + 1;
				this.#keyEscaped = false;
				this.#escape = false;
			}
			stepKey(c, at) {
				if (c < " ") {
					this.fail();
					return;
				}
				if (this.#escape) {
					this.#escape = false;
					return;
				}
				if (c === "\\") {
					this.#escape = true;
					this.#keyEscaped = true;
					return;
				}
				if (c !== "\"") return;
				const raw = this.slice(this.#keyStart, at);
				if (this.#keyEscaped) try {
					this.#key = JSON.parse(`"${raw}"`);
				} catch (_error) {
					this.fail();
					return;
				}
				else this.#key = raw;
				this.#mode = "colon";
			}
			open(entry) {
				if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
				this.#entries.set(this.#key, entry);
				this.#current = entry;
			}
			beginValue(c, at) {
				if (isWhitespace(c)) return;
				if (c === "\"") {
					this.open({
						kind: "string",
						start: at + 1,
						end: -1,
						needsDecoding: false,
						invalidAt: void 0,
						length: void 0,
						text: void 0,
						prefixes: void 0
					});
					this.#escape = false;
					this.#mode = "string";
					return;
				}
				if (c === "}" || c === "," || c === ":" || c === "]") {
					this.fail();
					return;
				}
				this.open({
					kind: "value",
					start: at,
					end: -1,
					parsed: void 0,
					invalid: false
				});
				if (c === "{" || c === "[") {
					this.#mode = "nested";
					this.#nestedEnds = [c === "{" ? "}" : "]"];
					this.#nestedInString = false;
					this.#escape = false;
					return;
				}
				this.#mode = "scalar";
			}
			stepScalar(c, at) {
				if (c !== "," && c !== "}" && !isWhitespace(c)) return;
				this.closeValue(at);
				this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
			}
			stepNested(c, at) {
				if (this.#nestedInString) {
					this.#nestedInString = false;
					return;
				}
				if (c === "\"") {
					this.#nestedInString = true;
					return;
				}
				if (c === "{" || c === "[") {
					this.#nestedEnds.push(c === "{" ? "}" : "]");
					return;
				}
				if (c === "}" || c === "]") {
					if (this.#nestedEnds.pop() !== c) {
						this.fail();
						return;
					}
					if (this.#nestedEnds.length === 0) {
						this.closeValue(at + 1);
						this.#mode = "comma-or-end";
					}
				}
			}
			closeValue(end) {
				const entry = this.#current;
				entry.end = end;
				this.#current = null;
			}
		});
		//#endregion
		//#region ../../util/values/src/index.ts
		/**
		* Mark an unreachable closed-union branch.
		* @param value - impossible value; an unhandled typed variant fails at the call site.
		* @param context - optional switch-site label included in the failure message.
		* @returns never; a runtime value that escaped its type always throws.
		*/
		function assertNever(value, context) {
			const rendered = JSON.stringify(value) ?? String(value);
			throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
		}
		/**
		* Weak-key lookup with a strongly retained iterable set of associated values.
		*
		* Each value must belong to only one key. The container performs no automatic
		* cleanup; owners delete associations or clear the container at lifecycle end.
		*/
		var WeakMapWithValues = class {
			keys = /* @__PURE__ */ new WeakMap();
			valueSet = /* @__PURE__ */ new Set();
			/** Live strongly retained values in insertion order. */
			values = this.valueSet;
			/**
			* Read the value associated with a key.
			* @param key - weakly held lookup key.
			* @returns the associated value, or absence.
			*/
			get(key) {
				return this.keys.get(key);
			}
			/**
			* Test whether a key has an association.
			* @param key - weakly held lookup key.
			* @returns whether the key is present.
			*/
			has(key) {
				return this.keys.has(key);
			}
			/**
			* Associate one key with one caller-unique value.
			* @param key - weakly held lookup key.
			* @param value - strongly retained value that belongs to no other key.
			* @returns this container.
			*/
			set(key, value) {
				if (this.keys.has(key)) {
					const previous = this.keys.get(key);
					if (previous === value) return this;
					this.valueSet.delete(previous);
				}
				this.keys.set(key, value);
				this.valueSet.add(value);
				return this;
			}
			/**
			* Remove one association and its strongly retained value.
			* @param key - weakly held lookup key.
			* @returns whether an association was removed.
			*/
			delete(key) {
				if (!this.keys.has(key)) return false;
				const value = this.keys.get(key);
				const deleted = this.keys.delete(key);
				this.valueSet.delete(value);
				return deleted;
			}
			/** Remove every association and strongly retained value. */
			clear() {
				this.keys = /* @__PURE__ */ new WeakMap();
				this.valueSet.clear();
			}
		};
		//#endregion
		//#region lib/types/client/locales.js
		/**
		* `command` namespace dictionaries: the composer menu's section headings,
		* the client face (title, description, claim token) of the built-in Host
		* commands whose catalog descriptors carry English text only, and the
		* popupSelect shell's copy.
		*/
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"section.add": "添加",
			"section.commands": "指令",
			"label.goal": "目标",
			"label.plan": "计划",
			"label.feedback": "反馈",
			"label.compact": "压缩",
			"label.permission": "权限",
			"label.export": "下载日志",
			"description.goal": "设置或查看长期任务目标",
			"description.plan": "进入或退出计划模式",
			"description.feedback": "发送关于当前会话的反馈",
			"description.compact": "压缩以上对话内容",
			"description.permission": "切换权限预设（沙箱模式与审批策略）",
			"description.export": "将当前会话内容导出为 ZIP",
			"token.goal": "目标",
			"token.plan": "计划",
			"token.feedback": "反馈",
			"token.compact": "压缩",
			"token.permission": "权限",
			"token.export": "导出",
			"search.placeholder": "搜索…",
			"search.aria": "筛选选项",
			"status.loading": "正在加载选项…",
			"status.applying": "正在应用…",
			"status.empty": "无选项",
			"overlay.aria": "/{command} 选项",
			"listbox.aria": "/{command} 匹配项",
			"notice.attachmentsUnsupported": "/{command} 不接受附件，请先移除附件"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"section.add": "Add",
			"section.commands": "Commands",
			"label.goal": "Goal",
			"label.plan": "Plan",
			"label.feedback": "Feedback",
			"label.compact": "Compact",
			"label.permission": "Permission",
			"label.export": "Export",
			"description.goal": "Set or view the goal for a long-running task",
			"description.plan": "Enter or leave plan mode",
			"description.feedback": "Record feedback about this session",
			"description.compact": "Compact older conversation history",
			"description.permission": "Switch the permission preset (sandbox mode + approval policy)",
			"description.export": "Download this Session log as a ZIP archive",
			"token.goal": "goal",
			"token.plan": "plan",
			"token.feedback": "feedback",
			"token.compact": "compact",
			"token.permission": "permission",
			"token.export": "export",
			"search.placeholder": "Search…",
			"search.aria": "Filter options",
			"status.loading": "Loading options…",
			"status.applying": "Applying…",
			"status.empty": "No options",
			"overlay.aria": "/{command} options",
			"listbox.aria": "/{command} matches",
			"notice.attachmentsUnsupported": "/{command} does not accept attachments; remove them first"
		};
		//#endregion
		//#region lib/types/client/resolution.js
		const BUILTINS = {
			goal: "@deepseek-ai/dsh-command-goal",
			plan: "@deepseek-ai/dsh-plan-mode",
			feedback: "@deepseek-ai/dsh-command-feedback",
			compact: "@deepseek-ai/dsh-command-compact",
			permission: "@deepseek-ai/dsh-permission-presets",
			export: "@deepseek-ai/dsh-session-log-export"
		};
		/**
		* Identify a first-party definition without interpreting its display copy.
		* @param descriptor - effective Host descriptor after scoped shadowing.
		* @returns its first-party name, or undefined for another definition.
		*/
		function builtinCommandName(descriptor) {
			return Object.keys(BUILTINS).find((name) => descriptor.definitionId === BUILTINS[name]);
		}
		/**
		* Select the input spelling for a menu-picked command.
		* @param descriptor - effective Host descriptor.
		* @param t - command-namespace translator.
		* @returns localized spelling for a known definition, otherwise its registered name.
		*/
		function claimToken(descriptor, t) {
			const name = builtinCommandName(descriptor);
			return name === void 0 ? descriptor.name : t(`token.${name}`);
		}
		const TOKEN_ALIASES = new Map(Object.keys(BUILTINS).flatMap((name) => [zh[`token.${name}`], en[`token.${name}`]].map((token) => [token, name])));
		/**
		* Resolve typed spelling against the current Session's effective definitions.
		* @param token - typed name without its leading slash.
		* @param descriptors - effective descriptors in the Session's ready catalog.
		* @returns the matching descriptor; aliases never select an unrelated scoped override.
		*/
		function resolveCommand(token, descriptors) {
			const exact = descriptors.find((descriptor) => descriptor.name === token);
			if (exact !== void 0) return exact;
			const name = TOKEN_ALIASES.get(token);
			if (name === void 0) return void 0;
			return descriptors.find((descriptor) => descriptor.definitionId === BUILTINS[name]);
		}
		//#endregion
		//#region lib/types/client/directory.js
		/** One session key's cache cell. */
		var Entry = class {
			state = "cold";
			commands = [];
			/** Bumped at each pull start; only the latest pull may publish its outcome. */
			epoch = 0;
			lastError;
			waiters = [];
		};
		/** The session-keyed directory cache. Plain class — the owning service wires events and RPC. */
		var CommandDirectory = class {
			fetchCommands;
			entries = /* @__PURE__ */ new Map();
			constructor(fetchCommands) {
				this.fetchCommands = fetchCommands;
			}
			/**
			* Current cache status for one session.
			* @param sessionId - session key.
			* @returns the entry status (cold when never touched).
			*/
			status(sessionId) {
				return this.entries.get(sessionId)?.state ?? "cold";
			}
			/**
			* Synchronous command lookup over one Session's ready catalog; exact names precede localized aliases.
			* @param sessionId - session key.
			* @param name - typed command spelling without the leading slash.
			* @returns the descriptor, or undefined when absent or the entry is not ready.
			*/
			resolve(sessionId, name) {
				const entry = this.entries.get(sessionId);
				if (entry === void 0 || entry.state !== "ready") return void 0;
				return resolveCommand(name, entry.commands);
			}
			/** Soft invalidation (commands-changed): background repull on every touched key; ready snapshots keep serving. */
			invalidateAll() {
				for (const key of this.entries.keys()) this.refresh(key);
			}
			/**
			* Drop one Session's obsolete composition-specific snapshot and prewarm its replacement.
			* @param sessionId - Session whose effective command composition changed.
			*/
			resetSession(sessionId) {
				const entry = this.entry(sessionId);
				entry.state = "cold";
				entry.commands = [];
				entry.lastError = void 0;
				this.refresh(sessionId);
			}
			/**
			* Hard reset on reconnect: every entry drops its snapshot (the agent world
			* may have changed shape across the generation) and prewarms.
			*/
			resetConnected() {
				for (const [key, entry] of this.entries) {
					entry.state = "cold";
					entry.commands = [];
					this.refresh(key);
				}
			}
			/**
			* Fire-and-forget prewarm of one session (the command source's scope-birth
			* warm hook lands here).
			* @param sessionId - session key.
			*/
			warm(sessionId) {
				const entry = this.entry(sessionId);
				if (entry.state === "cold" || entry.state === "failed") this.refresh(sessionId);
			}
			/**
			* Start one pull for one session. Publishes ready/failed only while it is
			* still the key's latest pull (epoch guard); a ready snapshot is not
			* demoted while the pull flies.
			* @param sessionId - session key.
			* @returns settled when this pull's outcome is published or discarded.
			*/
			async refresh(sessionId) {
				const entry = this.entry(sessionId);
				const epoch = ++entry.epoch;
				if (entry.state !== "ready") entry.state = "pending";
				try {
					const commands = await this.fetchCommands(sessionId);
					if (epoch !== entry.epoch) return;
					entry.commands = commands;
					entry.state = "ready";
					entry.lastError = void 0;
				} catch (error) {
					if (epoch !== entry.epoch) return;
					entry.commands = [];
					entry.state = "failed";
					entry.lastError = error;
				} finally {
					if (epoch === entry.epoch) notifyWaiters(entry);
				}
			}
			/**
			* Strong-wait until one session's catalog is servable (the enter-
			* adjudication "directory must be reached" rule): ready returns at once;
			* cold/failed launch a fresh pull; pending joins the flying one. Rejects
			* when the awaited pull fails or the signal aborts.
			* @param sessionId - session key.
			* @param signal - attempt-scoped abort (the SubmitAttempt signal).
			* @returns the hot command snapshot.
			*/
			async ensureReady(sessionId, signal) {
				const entry = this.entry(sessionId);
				while (true) {
					if (entry.state === "ready") return entry.commands;
					if (entry.state !== "pending") this.refresh(sessionId);
					await settled(entry, signal);
					if (entry.state === "failed") throw new Error(`command directory warmup failed: ${entry.lastError instanceof Error ? entry.lastError.message : String(entry.lastError)}`);
				}
			}
			entry(sessionId) {
				let entry = this.entries.get(sessionId);
				if (entry === void 0) {
					entry = new Entry();
					this.entries.set(sessionId, entry);
				}
				return entry;
			}
		};
		/** One settlement tick for one entry: resolves at the next winning publish, rejects on abort. */
		function settled(entry, signal) {
			if (signal.aborted) return Promise.reject(abortReason(signal));
			return new Promise((resolve, reject) => {
				const waiter = () => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				};
				const onAbort = () => {
					entry.waiters = entry.waiters.filter((w) => w !== waiter);
					reject(abortReason(signal));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				entry.waiters.push(waiter);
			});
		}
		function notifyWaiters(entry) {
			const woken = entry.waiters;
			entry.waiters = [];
			for (const wake of woken) wake();
		}
		/** Normalize an abort into an Error rejection. */
		function abortReason(signal) {
			return signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("command directory wait aborted");
		}
		//#endregion
		//#region lib/types/client/option-groups.js
		/**
		* Group rows by their caller-owned group name, without sorting groups or rows.
		* Ungrouped rows occupy one block at their first occurrence.
		* @param options - Options in display order.
		* @returns groups in first-occurrence order, with original option objects.
		*/
		function groupOptions(options) {
			const groups = /* @__PURE__ */ new Map();
			for (const option of options) {
				const name = option.group?.name;
				const existing = groups.get(name);
				if (existing !== void 0) existing.rows.push(option);
				else groups.set(name, {
					group: option.group,
					rows: [option]
				});
			}
			return [...groups.values()];
		}
		//#endregion
		//#region lib/types/client/popup.js
		/**
		* Headless popupSelect shell state: one controller per client
		* session, owned by CommandUiRuntime's per-session map and torn down by the
		* session scope disposer. The shell is a transient layer (never in the input
		* state machine): it loads options once, filters them locally against the
		* shell's own search text, and settles a selection through the context
		* captured at open time. Draft consumption and composer focus are injected
		* callbacks — the session wiring dispatches the consume-token event (the
		* Input side owns the span/bare-token CAS guard) and focuses the composer;
		* the controller never touches the input machine.
		*/
		const CLOSED = {
			open: false,
			command: null,
			status: "pending",
			options: [],
			search: "",
			searchLabels: null,
			searchMode: "substring",
			active: 0,
			submitting: false,
			confirming: null,
			acknowledged: false,
			error: null
		};
		/**
		* Filter rows using substring matching, or rank labels fuzzily within each group.
		* Blank search keeps every row; fuzzy matching preserves group order.
		* @param options - the loaded rows.
		* @param search - the shell's search text.
		* @param mode - the command's policy; defaults to substring over label and detail.
		* @returns the original option objects in the order shown and used for selection.
		*/
		function filterOptions(options, search, mode = "substring") {
			const query = search.trim();
			const groups = groupOptions(options);
			const ordered = groups.some((group) => group.group !== void 0) ? groups.flatMap((group) => group.rows) : options;
			if (query === "") return ordered;
			if (mode === "fuzzy-label") return groups.flatMap(group => new harnessTextSearch.TextSearchIndex(group.rows, option => ({ fuzzy: [option.label], substring: [option.detail] })).search(query));
			return new harnessTextSearch.TextSearchIndex(ordered, option => ({ substring: [option.label, option.detail] })).search(query);
		}
		/**
		* Highlight index for a freshly loaded row list: the row marked as the current
		* value when the live search still shows it, else the top row. Opening parks
		* the highlight on the value the session already uses, so an accept gesture
		* made without looking confirms that value instead of the topmost row.
		* @param options - the loaded rows.
		* @param search - the shell's live filter text (non-empty after a retry).
		* @param mode - the command's search policy.
		* @returns index into the filtered rows.
		*/
		function currentIndex(options, search, mode) {
			const at = filterOptions(options, search, mode).findIndex((option) => option.active === true);
			return at === -1 ? 0 : at;
		}
		/** The shell's error-strip line for a settlement failure. */
		function errorText(error) {
			return error instanceof Error ? error.message : String(error);
		}
		/**
		* Headless controller of one session's popupSelect shell. Late settlements
		* lose their write rights through binding identity: dismiss/dispose/reopen
		* swap the binding, so a settling options fetch or onSelect that no longer
		* matches writes nothing and consumes nothing.
		*/
		var PopupSelectController = class {
			deps;
			/** Shell state store (the overlay component subscribes here). */
			state = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(CLOSED);
			binding = null;
			/**
			* @param deps - session-wiring callbacks (token consumption + composer focus).
			*/
			constructor(deps) {
				this.deps = deps;
			}
			/**
			* Open the shell for one command: publish pending state and fetch options
			* once through the business spec. A reopen supersedes the previous shell
			* (its options fetch is aborted, its late settlements are dropped).
			* @param command - command name the shell serves.
			* @param spec - the registered popupSelect spec.
			* @param context - open-time context snapshot, handed verbatim to options/onSelect.
			* @param segment - open-time token segment snapshot for post-select consumption.
			*/
			open(command, spec, context, segment) {
				const searchLabels = spec.searchLabels?.() ?? null;
				this.binding?.abort.abort();
				const binding = {
					command,
					spec,
					context,
					segment,
					abort: new AbortController()
				};
				this.binding = binding;
				this.state.set({
					...CLOSED,
					open: true,
					command,
					searchLabels,
					searchMode: spec.searchMode ?? "substring"
				});
				this.load(binding);
			}
			/** Run the one options fetch of a binding; settlement rights die with the binding. */
			load(binding) {
				binding.spec.options(binding.context, binding.abort.signal).then((options) => {
					if (this.binding !== binding) return;
					const current = this.state.getSnapshot();
					this.state.set({
						...current,
						status: "ready",
						options,
						active: currentIndex(options, current.search, current.searchMode),
						error: null
					});
				}, (error) => {
					if (this.binding !== binding) return;
					console.error(`[ui-commands] popupSelect options failed for /${binding.command}:`, error);
					this.state.set({
						...this.state.getSnapshot(),
						status: "failed",
						options: [],
						active: 0,
						error: errorText(error)
					});
				});
			}
			/** Re-run a failed options fetch (search survives; no-op unless status is 'failed'). */
			retry() {
				const binding = this.binding;
				const s = this.state.getSnapshot();
				if (binding === null || !s.open || s.status !== "failed") return;
				this.state.set({
					...s,
					status: "pending",
					error: null
				});
				this.load(binding);
			}
			/**
			* Replace the local search text (pure local filter — the provider is never
			* re-queried) and rebase the highlight to the top of the new filtered list:
			* typing searches for something other than the current value.
			* @param search - the shell search input's text.
			*/
			setSearch(search) {
				const s = this.state.getSnapshot();
				if (!s.open || s.submitting || s.confirming !== null || search === s.search) return;
				this.state.set({
					...s,
					search,
					active: 0
				});
			}
			/**
			* Move the highlight across the filtered rows (wraps around; no-op unless
			* options are ready and no selection is in flight).
			* @param dir - +1 down, -1 up.
			*/
			move(dir) {
				const s = this.state.getSnapshot();
				if (!s.open || s.status !== "ready" || s.submitting || s.confirming !== null) return;
				const rows = filterOptions(s.options, s.search, s.searchMode);
				if (rows.length === 0) return;
				const active = (s.active + dir + rows.length) % rows.length;
				this.state.set({
					...s,
					active
				});
			}
			/**
			* Set the highlight directly (pointer hover; no-op unless ready, idle, and
			* in filtered range).
			* @param index - filtered-row index.
			*/
			highlight(index) {
				const s = this.state.getSnapshot();
				if (!s.open || s.status !== "ready" || s.submitting || s.confirming !== null) return;
				if (index < 0 || index >= filterOptions(s.options, s.search, s.searchMode).length || index === s.active) return;
				this.state.set({
					...s,
					active: index
				});
			}
			/**
			* Select one filtered row: single-flight — the first call enters
			* `submitting` and later calls no-op until it settles. Success consumes the
			* open-time token segment (a false CAS answer is benign), closes, and
			* returns focus to the composer. Failure keeps the shell open with search,
			* highlight, and token intact, surfaces the error, and re-arms select as
			* the retry.
			* @param index - filtered-row index (callers pass the highlight or the clicked row).
			* @returns settled when the attempt has closed the shell or surfaced its failure.
			*/
			async select(index) {
				const binding = this.binding;
				const s = this.state.getSnapshot();
				if (binding === null || !s.open || s.status !== "ready" || s.submitting || s.confirming !== null) return;
				const option = filterOptions(s.options, s.search, s.searchMode)[index];
				if (option === void 0) return;
				if (option.confirmation !== void 0) {
					this.state.set({
						...s,
						confirming: option,
						acknowledged: false,
						error: null
					});
					return;
				}
				await this.settle(binding, option);
			}
			/**
			* Update the explicit checkbox for the currently pending risk gate.
			* @param acknowledged - whether the user has acknowledged the displayed risk.
			*/
			acknowledge(acknowledged) {
				const s = this.state.getSnapshot();
				if (!s.open || s.submitting || s.confirming === null || s.acknowledged === acknowledged) return;
				this.state.set({
					...s,
					acknowledged
				});
			}
			/** Cancel only the risk gate and return to the still-open option picker. */
			cancelConfirmation() {
				const s = this.state.getSnapshot();
				if (!s.open || s.submitting || s.confirming === null) return;
				this.state.set({
					...s,
					confirming: null,
					acknowledged: false
				});
			}
			/** Settle the gated option only after the checkbox is acknowledged. */
			async confirm() {
				const binding = this.binding;
				const s = this.state.getSnapshot();
				if (binding === null || !s.open || s.submitting || s.confirming === null || !s.acknowledged) return;
				await this.settle(binding, s.confirming);
			}
			/** Run the business settlement for an already admitted option. */
			async settle(binding, option) {
				const s = this.state.getSnapshot();
				if (this.binding !== binding || !s.open || s.submitting) return;
				this.state.set({
					...s,
					submitting: true,
					confirming: null,
					acknowledged: false,
					error: null
				});
				try {
					await binding.spec.onSelect(option, binding.context);
				} catch (error) {
					console.error(`[ui-commands] popupSelect onSelect failed for /${binding.command}:`, error);
					if (this.binding !== binding) return;
					this.state.set({
						...this.state.getSnapshot(),
						submitting: false,
						error: errorText(error)
					});
					return;
				}
				if (this.binding !== binding) return;
				this.deps.consume(binding.segment);
				this.binding = null;
				this.state.set(CLOSED);
				this.deps.focusComposer();
			}
			/**
			* Close the shell; aborts a flying options fetch and revokes settlement
			* rights. An outside pointer interaction dismisses plainly (the click's own
			* target takes focus); Escape passes focusComposer to return focus explicitly.
			* @param opts - focusComposer: also restore composer focus (Escape path).
			*/
			dismiss(opts) {
				if (this.binding === null) return;
				this.binding.abort.abort();
				this.binding = null;
				this.state.set(CLOSED);
				if (opts?.focusComposer === true) this.deps.focusComposer();
			}
			/** Scope-teardown disposer: abort in-flight work and clear state (no focus side effect). */
			dispose() {
				this.binding?.abort.abort();
				this.binding = null;
				this.state.set(CLOSED);
			}
		};
		//#endregion
		//#region lib/types/client/presentation.js
		/** Row names per section, highest usage first; rows outside both lists close the Commands section in catalog order. */
		const SECTION_ROWS = {
			add: [
				"file",
				"goal",
				"plan",
				"feedback"
			],
			commands: [
				"compact",
				"permission",
				"model",
				"export"
			]
		};
		/** One built-in Host command's face, keyed by its dictionary entries. */
		function hostFace(name, icon) {
			return [name, {
				label: `label.${name}`,
				description: `description.${name}`,
				icon
			}];
		}
		/** Built-in Host commands whose client face this package owns. */
		const HOST_FACES = new Map([
			hostFace("goal", _deepseek_ai_dsh_client_ui_primitives.IconGoalOutlineRegular),
			hostFace("plan", _deepseek_ai_dsh_client_ui_primitives.IconPlanOutlineRegular),
			hostFace("feedback", _deepseek_ai_dsh_client_ui_primitives.IconPaperPlaneOutlineRegular),
			hostFace("compact", _deepseek_ai_dsh_client_ui_primitives.IconCompactOutlineRegular),
			hostFace("permission", _deepseek_ai_dsh_client_ui_primitives.PermissionIconFullAccessRegular),
			hostFace("export", _deepseek_ai_dsh_client_ui_primitives.IconDownloadOutlineRegular)
		]);
		/**
		* The localized menu face of a catalog row.
		* @param descriptor - effective Host command descriptor.
		* @param t - the `command` namespace translator.
		* @returns title, description, and glyph for a built-in command; undefined
		* for any other row, which keeps its catalog description.
		*/
		function builtinRowFace(descriptor, t) {
			const name = builtinCommandName(descriptor);
			const face = name === void 0 ? void 0 : HOST_FACES.get(name);
			return face === void 0 ? void 0 : {
				label: t(face.label),
				description: t(face.description),
				icon: face.icon
			};
		}
		/**
		* Arrange the empty-query menu: the Add section, then the Commands section,
		* each in usage order, with unlisted rows closing Commands in their input
		* order; each row carries its section heading.
		* @param rows - the visible candidates in catalog-then-contribution order.
		* @param t - the `command` namespace translator.
		* @returns the sectioned rows.
		*/
		function sectionRows(rows, t) {
			const listed = new Set([...SECTION_ROWS.add, ...SECTION_ROWS.commands]);
			const byName = new Map(rows.map((row) => [row.name, row]));
			const pick = (names) => names.flatMap((name) => {
				const row = byName.get(name);
				return row === void 0 ? [] : [row];
			});
			const add = pick(SECTION_ROWS.add).map((row) => ({
				...row,
				section: t("section.add")
			}));
			const commands = [...pick(SECTION_ROWS.commands), ...rows.filter((row) => !listed.has(row.name))].map((row) => ({
				...row,
				section: t("section.commands")
			}));
			return [...add, ...commands];
		}
		//#endregion
		//#region lib/types/client/service.js
		/**
		* CommandUiRuntime (`ctx.commandUi`): the '/' command source over the
		* session-keyed directory, the client-contribution registry, and the
		* per-session popupSelect controllers. Candidate synthesis merges the host
		* catalog with contributions by availability, gives built-in Host rows their
		* localized face (presentation.ts), then position-filters; an empty query
		* lists the Add and Commands sections in usage order, a typed query ranks
		* every row by the `/` menu's shared name-and-label ranking (ui-primitives
		* `rankByName`). A host/contribution name collision fails loud. Every
		* execute addresses the session's agent by sessionId — sessions are always
		* agent-backed.
		* Catalog RPCs retain an existing Client Session through completion and
		* wait for its initial history open to succeed before contacting the Host.
		*/
		/** Recover the command name from a line the Host confirmed as executed. */
		function submittedCommandName(line) {
			const trimmed = line.trim();
			const separator = trimmed.search(/\s/u);
			return (separator === -1 ? trimmed : trimmed.slice(0, separator)).slice(1);
		}
		/** Command surface: session-keyed directory + '/' source + contribution registry + per-session popups. */
		var CommandUiRuntime = class extends _deepseek_ai_cordis.Service {
			static inject = [
				"inputTriggers",
				"sessions",
				"remote",
				"remote.commands"
			];
			directory;
			live = {
				contributions: /* @__PURE__ */ new Map(),
				decorations: /* @__PURE__ */ new Map(),
				popups: new WeakMapWithValues()
			};
			/** `command`-namespace translator (composer refusal notices). */
			t;
			/**
			* @param ctx - owning root context (plugin fiber; the service registers
			* itself as `command` and follows that fiber's lifetime).
			*/
			constructor(ctx) {
				super(ctx, "commandUi");
				const locale = ctx.get("locale");
				if (locale === void 0) throw new Error("ui-commands: locale service unavailable");
				this.t = locale.bind("command");
				this.directory = new CommandDirectory(async (sessionId) => {
					const sessions = this.sessions();
					if (sessions.subagentAddress(sessionId) !== void 0) return [];
					if (sessions.binding(sessionId) === void 0) throw new Error(`command catalog requires a retained session "${sessionId}"`);
					return sessions.using(sessionId, { source: "commandCatalog" }, async (reference) => {
						const state = reference.binding.session.getSnapshot();
						if (state.openState !== "open") throw state.openError ?? /* @__PURE__ */ new Error(`session "${sessionId}" is not open`);
						const result = await ctx.remote.commands.list(sessionId);
						if (!result.ok) throw new Error(`command.list failed: ${result.error.code}: ${result.error.message}`);
						return result.value;
					});
				});
				const inputTriggers = ctx.get("inputTriggers");
				if (inputTriggers === void 0) throw new Error("ui-commands: slash service unavailable");
				ctx.effect(() => inputTriggers.registerSource({
					trigger: "/",
					name: "command",
					candidates: (session, req) => this.candidates(session, req),
					onPick: (pick) => this.dispatch(pick),
					matchSpace: (session, token) => this.matchSpace(session, token),
					matchEnter: (session, line, signal, envelope) => this.matchEnter(session, line, signal, envelope),
					warm: (session) => {
						this.directory.warm(session.sessionId);
					}
				}), "command: slash source");
				ctx.remote.$on("commands/change", () => {
					this.directory.invalidateAll();
				});
				ctx.remote.$on("agent-preset/selected", (sessionId) => {
					this.directory.resetSession(sessionId);
				});
				ctx.on("connection/reset", () => {
					this.directory.resetConnected();
				});
			}
			/**
			* Register one client command contribution; effect disposer (rides the
			* caller's fiber). Duplicate names throw.
			* @param contribution - the contribution (descriptor + availability + popup spec).
			* @returns the disposer removing the registration.
			*/
			register(contribution) {
				const dispose = this.ctx.effect(() => {
					const { contributions } = this.live;
					if (contributions.has(contribution.name)) throw new Error(`ui-commands: duplicate contribution for /${contribution.name}`);
					contributions.set(contribution.name, contribution);
					return () => {
						contributions.delete(contribution.name);
					};
				}, "command.register()");
				return () => {
					dispose();
				};
			}
			/**
			* Hang a bare-invocation decoration on one host command; effect disposer
			* (rides the caller's fiber). Duplicate names throw.
			* @param decoration - host command name + availability + popup spec.
			* @returns the disposer removing the registration.
			*/
			decorate(decoration) {
				const dispose = this.ctx.effect(() => {
					const { decorations } = this.live;
					if (decorations.has(decoration.name)) throw new Error(`ui-commands: duplicate decoration for /${decoration.name}`);
					decorations.set(decoration.name, decoration);
					return () => {
						decorations.delete(decoration.name);
					};
				}, "command.decorate()");
				return () => {
					dispose();
				};
			}
			/**
			* Close every open popup for a command whose options have become stale.
			* Pending loads and confirmations lose their binding; drafts stay intact.
			* @param name - command name without the leading slash.
			*/
			dismiss(name) {
				for (const popup of this.live.popups.values) if (popup.state.getSnapshot().command === name) popup.dismiss({ focusComposer: true });
			}
			/**
			* Resolve the per-session popup controller (lazy; dies with the session
			* scope). The controller's consume callback dispatches the scoped
			* consume-token event back to this session; focusComposer reaches the
			* session's composer through the conversation input face.
			* @param actx - session-scope ctx.
			* @returns the resident controller.
			* @throws when the Context no longer belongs to a retained Session generation.
			*/
			popupFor(actx) {
				const sessions = this.sessions();
				const session = sessions.sessionOf(actx);
				const binding = session === void 0 ? void 0 : sessions.binding(session.sessionId);
				if (binding === void 0 || binding.session !== session) throw new Error("command.popupFor requires a retained Session scope");
				const { popups } = this.live;
				const existing = popups.get(binding);
				if (existing !== void 0) return existing;
				const controller = new PopupSelectController({
					consume: (segment) => binding.ctx.bail(binding.ctx, "slash/input-consume-token", { guard: segment.via === "menu" ? {
						kind: "span",
						span: segment.span
					} : {
						kind: "bare-token",
						token: segment.token
					} }) === true,
					focusComposer: () => {
						binding.ctx.get("conversation")?.input.for(binding.ctx).focus();
					}
				});
				popups.set(binding, controller);
				binding.ctx.effect(() => () => {
					controller.dispose();
					popups.delete(binding);
				}, "command: session popup");
				return controller;
			}
			/**
			* Menu candidates: host catalog + contribution availability, built-in rows
			* localized, then position filtering; sections for an empty query, the
			* shared name-and-label ranking for a typed one.
			*/
			async candidates(session, req) {
				const list = await this.directory.ensureReady(session.sessionId, req.signal);
				const rows = [];
				const seen = /* @__PURE__ */ new Set();
				for (const c of list) {
					seen.add(c.name);
					rows.push({
						name: c.name,
						...builtinRowFace(c, this.t) ?? { description: c.description },
						...c.input !== void 0 ? { hint: c.input.hint } : {}
					});
				}
				for (const contribution of this.live.contributions.values()) {
					if (!contribution.available(session)) continue;
					if (seen.has(contribution.name)) throw new Error(`ui-commands: contribution /${contribution.name} collides with a host command`);
					rows.push({
						name: contribution.name,
						...contribution.label === void 0 ? {} : { label: contribution.label() },
						...contribution.description === void 0 ? {} : { description: contribution.description() },
						...contribution.icon === void 0 ? {} : { icon: contribution.icon }
					});
				}
				const visible = rows.filter((c) => req.position === "leading" || c.hint === void 0);
				return req.query === "" ? sectionRows(visible, this.t) : new harnessTextSearch.TextSearchIndex(visible, row => ({ fuzzy: [row.name, row.label], substring: [row.description] })).search(req.query);
			}
			/** Decision table, menu column: contribution/decorated-host → popup or action; host input → claim; host bare → detached execute. */
			dispatch(pick) {
				const name = pick.candidate.name;
				const contribution = this.live.contributions.get(name);
				if (contribution !== void 0 && contribution.available(pick.session)) {
					this.invoke(name, contribution.ui, pick.session, {
						via: "menu",
						span: pick.span
					});
					return "handled";
				}
				const desc = this.directory.resolve(pick.session.sessionId, name);
				if (desc === void 0) return void 0;
				const decoration = this.live.decorations.get(name);
				if (decoration !== void 0 && decoration.available(pick.session)) {
					this.invoke(name, decoration.ui, pick.session, {
						via: "menu",
						span: pick.span
					});
					return "handled";
				}
				if (desc.input !== void 0) return { claim: this.leadingClaim(desc, pick.session, claimToken(desc, this.t)) };
				this.consumeVia(pick.session.sessionId, {
					via: "menu",
					span: pick.span
				});
				this.runDetached(desc, pick.session, `/${name}`);
				return "handled";
			}
			/** Decision table, space column: hot-key sync check; only host leadingInput claims. */
			matchSpace(session, token) {
				if (!token.startsWith("/")) return void 0;
				if (this.live.contributions.has(token.slice(1))) return void 0;
				const desc = this.directory.resolve(session.sessionId, token.slice(1));
				if (desc === void 0 || desc.input === void 0) return void 0;
				return { claim: this.leadingClaim(desc, session, token.slice(1)) };
			}
			/**
			* Decision table, enter column. Strong-waits the session's catalog (a
			* warmup failure rejects — never a silent downgrade). Contributions and
			* bare host commands act on the bare token only; leadingInput claims
			* args-tolerant.
			*
			* Envelope policy: an enter submission carrying attachments resolves only
			* through a command declaring attachment acceptance. Every other submitting
			* route — popup, non-accepting claim, bare detached execute — throws the
			* refusal so the machine surfaces one composer notice and the draft and
			* attachments stay in place; nothing executes and nothing is dropped. An
			* action submits nothing and runs regardless.
			*
			* A typed token is resolved through the localized claim tokens, so a line
			* written as `/计划` reaches the `plan` descriptor and executes as `/plan`.
			*/
			async matchEnter(session, line, signal, envelope) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("/")) return void 0;
				const ws = trimmed.search(/\s/);
				const token = ws === -1 ? trimmed : trimmed.slice(0, ws);
				const bare = ws === -1;
				const typedName = token.slice(1);
				if (typedName === "") return void 0;
				const refuseAttachments = () => {
					throw new Error(this.t("notice.attachmentsUnsupported", { command: typedName }));
				};
				const contribution = this.live.contributions.get(typedName);
				if (contribution !== void 0 && contribution.available(session)) {
					if (!bare) return void 0;
					if (envelope.attachments > 0 && contribution.ui.kind !== "action") refuseAttachments();
					this.invoke(typedName, contribution.ui, session, {
						via: "enter",
						token
					});
					return "handled";
				}
				await this.directory.ensureReady(session.sessionId, signal);
				const desc = this.directory.resolve(session.sessionId, typedName);
				if (desc === void 0) return void 0;
				const name = desc.name;
				const canonical = `/${name}${trimmed.slice(token.length)}`;
				if (bare) {
					const decoration = this.live.decorations.get(name);
					if (decoration !== void 0 && decoration.available(session)) {
						if (envelope.attachments > 0 && decoration.ui.kind !== "action") refuseAttachments();
						this.invoke(name, decoration.ui, session, {
							via: "enter",
							token
						});
						return "handled";
					}
				}
				if (desc.input !== void 0) {
					if (envelope.attachments > 0 && desc.input.attachments !== true) refuseAttachments();
					return { claim: this.leadingClaim(desc, session, token.slice(1)) };
				}
				if (!bare) return void 0;
				if (envelope.attachments > 0) refuseAttachments();
				this.consumeVia(session.sessionId, {
					via: "enter",
					token
				});
				this.runDetached(desc, session, canonical);
				return "handled";
			}
			/**
			* Invoke one contribution or decoration (menu pick / bare enter): open the
			* session's popup, or consume the token and run the action.
			*/
			invoke(name, ui, session, segment) {
				if (ui.kind === "action") {
					this.consumeVia(session.sessionId, segment);
					ui.run(session);
					return;
				}
				const actx = this.scopeFor(session.sessionId);
				if (actx === void 0) return;
				this.popupFor(actx).open(name, ui, session, segment);
			}
			/**
			* Build the leadingInput claim. The composer keeps the claimed token in
			* the draft and reads the arguments after it, so the token is the spelling
			* the draft will carry: the locale's token for a menu pick, the typed
			* spelling for Space and Enter. The command.execute submit transaction
			* always sends the catalog name.
			*/
			leadingClaim(desc, session, shown) {
				const token = `/${shown} `;
				const line = `/${desc.name} `;
				return {
					name: desc.name,
					token,
					...desc.input !== void 0 ? { hint: desc.input.hint } : {},
					...desc.input?.attachments === true ? { attachments: true } : {},
					submit: (args, _actx, attachments) => this.execute(session, line + args, attachments)
				};
			}
			/**
			* The command.execute transaction, addressed to the session's agent — pure
			* admission semantics. An unmatched line reports an error outcome (the
			* composer's immediate admission feedback); an admitted command reports
			* plain success regardless of its handler outcome, because the host
			* executor durably logged the lifecycle (`command/run`/`command/done`) and
			* the outcome renders as a persistent flow node — the composer never
			* echoes it. A handler error result reports an error outcome so the
			* composer keeps the draft and attachments for correction.
			* A refused call throws.
			*/
			async execute(session, line, attachments = []) {
				const result = await this.ctx.remote.commands.execute(session.sessionId, line, attachments);
				if (!result.ok) throw new Error(`command.execute failed: ${result.error.code}: ${result.error.message}`);
				if (result.value === void 0) return {
					kind: "error",
					text: `unknown or malformed command: ${line}`
				};
				this.notifyExecuted(session.sessionId, submittedCommandName(line), result.value.result);
				if (attachments.length > 0 && result.value.result.kind === "error") return {
					kind: "error",
					text: result.value.result.text
				};
				return { kind: "success" };
			}
			/** Publish the local acknowledgment without letting an observer change command admission. */
			notifyExecuted(sessionId, name, result) {
				const args = [
					"command/executed",
					sessionId,
					name,
					result
				];
				for (const listener of this.ctx.events.dispatch("emit", args)) try {
					const returned = listener(sessionId, name, result);
					if (returned != null && typeof returned.then === "function") Promise.resolve(returned).then(void 0, (error) => {
						this.warnExecutedListenerFailure(name, error);
					});
				} catch (error) {
					this.warnExecutedListenerFailure(name, error);
				}
			}
			/** Log one contained `command/executed` observer failure. */
			warnExecutedListenerFailure(name, error) {
				this.ctx.logger.warn("client command: a command/executed listener for \"%s\" failed", name);
				this.ctx.logger.warn(error);
			}
			/**
			* Fire-and-forget execute for the internal ('handled') paths. Outcomes are
			* NOT surfaced here: the host executor durably logs the command lifecycle
			* (`command/run`/`command/done`), and the mux-broadcast events render as a
			* persistent flow node on every tab. Only an admission failure — which never
			* entered a handler and therefore never logged — falls back to the composer
			* notice as immediate feedback.
			*/
			runDetached(desc, session, line) {
				this.execute(session, line).then((outcome) => {
					if (outcome.kind === "error") this.noticeFor(session.sessionId, "error", outcome.text ?? `/${desc.name} failed`);
				}, (error) => {
					this.noticeFor(session.sessionId, "error", error instanceof Error ? error.message : String(error));
				});
			}
			/** Dispatch a consume-token event to one session (menu-pick / bare-enter execute paths). */
			consumeVia(id, segment) {
				const actx = this.scopeFor(id);
				if (actx === void 0) return;
				actx.bail(actx, "slash/input-consume-token", { guard: segment.via === "menu" ? {
					kind: "span",
					span: segment.span
				} : {
					kind: "bare-token",
					token: segment.token
				} });
			}
			/** Route an admission failure to the session's composer notice channel (scope gone = attempt died with it). */
			noticeFor(id, level, text) {
				const actx = this.scopeFor(id);
				if (actx === void 0) return;
				const conversation = actx.get("conversation");
				if (conversation === void 0) return;
				conversation.input.for(actx).notify(level, text);
			}
			/** id → actx interchange (registered exchange point: this service coordinates for projection-only sources). */
			scopeFor(id) {
				return this.sessions().scope(id);
			}
			sessions() {
				const sessions = this.ctx.get("sessions");
				if (sessions === void 0) throw new Error("ui-commands: sessions service unavailable");
				return sessions;
			}
		};
		//#endregion
		//#region ../../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-commands/src/client/PopupSelectView.module.css.mjs
		const css = ".mufS8W_card{box-sizing:border-box;z-index:100;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);min-width:min(220px,100%);max-width:100%;max-height:320px;box-shadow:var(--dsw-elevation-prominent);border:0;outline:none;flex-direction:column;padding:3px;display:flex;position:absolute;bottom:calc(100% + 4px);left:0;right:0;overflow:hidden}.mufS8W_viewport{flex-direction:column;min-height:0;display:flex;overflow-y:auto}.mufS8W_row{border-radius:var(--dsw-radius-md);cursor:pointer;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;padding:5px 7px;font-size:12px;display:flex}.mufS8W_rowActive{background:var(--dsw-alias-interactive-bg-hover)}.mufS8W_label{flex:0 auto;align-items:baseline;gap:4px;min-width:0;display:flex}.mufS8W_labelText{white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden}.mufS8W_badge{color:var(--dsw-alias-label-tertiary);letter-spacing:.2px;flex:none;align-self:flex-start;margin-top:-1px;font-size:8px;font-weight:600;line-height:10px}.mufS8W_detail{min-width:0;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;flex:1;font-size:11px;overflow:hidden}.mufS8W_check{color:var(--dsw-alias-label-primary);flex:none;margin-left:auto;display:inline-flex}.mufS8W_check svg{width:14px;height:14px}.mufS8W_status{color:var(--dsw-alias-label-tertiary);padding:7px 8px;font-size:12px}.mufS8W_search{border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);background:0 0;border:.5px solid #0000;outline:none;margin:2px 2px 3px;padding:5px 7px;font-size:12px}.mufS8W_error{color:var(--dsw-alias-state-error-primary);align-items:center;gap:6px;padding:5px 7px;font-size:11px;display:flex}.mufS8W_errorText{text-overflow:ellipsis;flex:1;overflow:hidden}.mufS8W_retry{border:.5px solid var(--dsw-alias-border-inverted);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;padding:2px 7px;font-size:11px}";
		const tagId = "@deepseek-ai/dsh-client-ui-commands/PopupSelectView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-commands";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var PopupSelectView_module_css_default = {
			"badge": "mufS8W_badge",
			"card": "mufS8W_card",
			"check": "mufS8W_check",
			"detail": "mufS8W_detail",
			"error": "mufS8W_error",
			"errorText": "mufS8W_errorText",
			"label": "mufS8W_label",
			"labelText": "mufS8W_labelText",
			"retry": "mufS8W_retry",
			"row": "mufS8W_row",
			"rowActive": "mufS8W_rowActive",
			"search": "mufS8W_search",
			"status": "mufS8W_status",
			"viewport": "mufS8W_viewport"
		};
		//#endregion
		//#region lib/types/client/PopupSelectView.js
		/**
		* Official popupSelect shell: renders one session's PopupSelectController
		* store into the conversation.input.overlay anchor. Unlike the slash menu
		* (combobox — textarea keeps focus), this shell HOLDS focus while open: the
		* inner search input takes focus, plain typing filters the loaded options
		* locally, Enter and Tab accept the filtered highlight, ↑↓ walk it (wrapping,
		* scrolled into view), and Escape and Shift+Tab dismiss back to the composer.
		* ←→ keep the search input's native caret. Any pointer interaction outside the
		* box dismisses (the click's own target takes focus). Closed state renders
		* null; the overlay slot stays mounted. The card height clamps to the space
		* above the composer.
		*/
		/** Design cap on the card height (same MenuDropdown family as the slash menu). */
		const MAX_HEIGHT = 320;
		/**
		* Render the popupSelect shell overlay entry.
		* @param props - injected face: the session's shell controller; `t` rides the standard locale seat.
		* @returns the select card while open; null while closed.
		*/
		function PopupSelectView({ popup, t }) {
			const state = (0, react.useSyncExternalStore)((fn) => popup.state.subscribe(fn), () => popup.state.getSnapshot());
			const cardRef = (0, react.useRef)(null);
			const searchRef = (0, react.useRef)(null);
			const viewportRef = (0, react.useRef)(null);
			const rows = (0, react.useMemo)(() => filterOptions(state.options, state.search, state.searchMode), [
				state.options,
				state.search,
				state.searchMode
			]);
			const groups = (0, react.useMemo)(() => groupOptions(rows), [rows]);
			(0, react.useEffect)(() => {
				const viewport = viewportRef.current;
				if (viewport === null) return;
				return (0, _deepseek_ai_dsh_client_ui_primitives.observeStickyMenuGroups)(viewport);
			}, [
				state.open,
				state.status,
				state.confirming,
				groups
			]);
			const maxHeight = (0, _deepseek_ai_dsh_client_ui_primitives.useAnchoredMaxHeight)(cardRef, MAX_HEIGHT, state);
			const active = state.open ? state.active : null;
			(0, react.useEffect)(() => {
				if (active === null) return;
				cardRef.current?.querySelector("[aria-selected=\"true\"]")?.scrollIntoView({ block: "nearest" });
			}, [
				active,
				rows,
				state.confirming
			]);
			(0, react.useEffect)(() => {
				if (!state.open || state.confirming !== null) return;
				const onPointerDown = (ev) => {
					if (cardRef.current !== null && ev.target instanceof Node && cardRef.current.contains(ev.target)) return;
					popup.dismiss();
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
				};
			}, [
				state.open,
				state.confirming,
				popup
			]);
			(0, react.useEffect)(() => {
				if (state.open && state.confirming === null) searchRef.current?.focus();
			}, [state.open, state.confirming]);
			if (!state.open) return null;
			const confirmation = state.confirming?.confirmation;
			const emptyLabel = state.searchLabels === null ? t("status.empty") : state.options.length === 0 ? state.searchLabels.empty : state.searchLabels.noResults;
			const onKeyDown = (ev) => {
				switch (ev.key) {
					case "ArrowDown":
						ev.preventDefault();
						popup.move(1);
						return;
					case "ArrowUp":
						ev.preventDefault();
						popup.move(-1);
						return;
					case "Enter":
						ev.preventDefault();
						popup.select(state.active);
						return;
					case "Tab":
						if (!ev.shiftKey && (state.status !== "ready" || rows.length === 0)) return;
						ev.preventDefault();
						if (ev.shiftKey) popup.dismiss({ focusComposer: true });
						else popup.select(state.active);
						return;
					case "Escape":
						ev.preventDefault();
						popup.dismiss({ focusComposer: true });
						return;
					default:
				}
			};
			const renderOption = (option, index) => (0, react_jsx_runtime.jsxs)("div", {
				role: "option",
				"aria-selected": index === state.active,
				"aria-label": option.badge === void 0 ? void 0 : `${option.label} ${option.badge}`,
				className: clsx(PopupSelectView_module_css_default.row, index === state.active && PopupSelectView_module_css_default.rowActive),
				onClick: () => {
					popup.select(index);
				},
				onMouseEnter: () => {
					popup.highlight(index);
				},
				children: [
					(0, react_jsx_runtime.jsxs)("span", {
						className: PopupSelectView_module_css_default.label,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: PopupSelectView_module_css_default.labelText,
							children: option.label
						}), option.badge !== void 0 && (0, react_jsx_runtime.jsx)("sup", {
							className: PopupSelectView_module_css_default.badge,
							children: option.badge
						})]
					}),
					option.detail !== void 0 && (0, react_jsx_runtime.jsx)("span", {
						className: PopupSelectView_module_css_default.detail,
						children: option.detail
					}),
					option.active === true && (0, react_jsx_runtime.jsx)("span", {
						className: PopupSelectView_module_css_default.check,
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutlineRegular, {})
					})
				]
			}, option.id);
			let optionIndex = 0;
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [state.confirming === null && (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.MenuSurface, {
				ref: cardRef,
				className: PopupSelectView_module_css_default.card,
				style: { maxHeight },
				"aria-label": t("overlay.aria", { command: String(state.command) }),
				onKeyDown,
				children: [
					(0, react_jsx_runtime.jsx)("input", {
						ref: searchRef,
						className: PopupSelectView_module_css_default.search,
						type: "text",
						placeholder: state.searchLabels?.placeholder ?? t("search.placeholder"),
						"aria-label": t("search.aria"),
						value: state.search,
						readOnly: state.submitting,
						onChange: (ev) => {
							popup.setSearch(ev.currentTarget.value);
						}
					}),
					state.error !== null && (0, react_jsx_runtime.jsxs)("div", {
						className: PopupSelectView_module_css_default.error,
						role: "alert",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: PopupSelectView_module_css_default.errorText,
							children: state.error
						}), state.status === "failed" && (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: PopupSelectView_module_css_default.retry,
							onClick: () => {
								popup.retry();
							},
							children: t("retry")
						})]
					}),
					state.status === "pending" && (0, react_jsx_runtime.jsx)("div", {
						className: PopupSelectView_module_css_default.status,
						children: t("status.loading")
					}),
					state.submitting && (0, react_jsx_runtime.jsx)("div", {
						className: PopupSelectView_module_css_default.status,
						children: t("status.applying")
					}),
					state.status === "ready" && rows.length === 0 && (0, react_jsx_runtime.jsx)("div", {
						className: PopupSelectView_module_css_default.status,
						children: emptyLabel
					}),
					state.status === "ready" && (0, react_jsx_runtime.jsx)("div", {
						ref: viewportRef,
						role: "listbox",
						"aria-label": t("listbox.aria", { command: String(state.command) }),
						className: PopupSelectView_module_css_default.viewport,
						children: groups.map(({ group, rows: groupRows }) => group === void 0 ? (0, react_jsx_runtime.jsx)(react.Fragment, { children: groupRows.map((option) => renderOption(option, optionIndex++)) }, "ungrouped") : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuGroup, {
							label: group.label,
							children: groupRows.map((option) => renderOption(option, optionIndex++))
						}, `group:${group.name}`))
					})
				]
			}), confirmation !== void 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.RiskConfirmation, {
				open: true,
				title: confirmation.title,
				description: confirmation.description,
				acknowledgeLabel: confirmation.acknowledgeLabel,
				cancelLabel: confirmation.cancelLabel,
				closeLabel: t("close"),
				confirmLabel: confirmation.confirmLabel,
				acknowledged: state.acknowledged,
				onAcknowledgedChange: (value) => {
					popup.acknowledge(value);
				},
				onCancel: () => {
					popup.cancelConfirmation();
				},
				onConfirm: () => {
					popup.confirm();
				}
			})] });
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "command";
		/** Required services: the '/' source registry, session scopes, commands Remote, and locale registry. */
		const inject = [
			"inputTriggers",
			"sessions",
			"remote",
			"remote.commands",
			"locale"
		];
		/**
		* Mount the command service and its per-session popupSelect overlay.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-commands: dictionaries");
			ctx.plugin(CommandUiRuntime);
			ctx.inject([
				"slots",
				"commandUi",
				"sessions"
			], (scope) => {
				const command = scope.commandUi;
				const sessions = scope.get("sessions");
				scope.slots.inject("conversation.input.overlay", () => scope.slots.register({
					name: "conversation.input.overlay",
					id: "command-popup",
					order: 1,
					locale: NS,
					inject: (sessionId) => {
						const actx = sessions.scope(sessionId);
						if (actx === void 0) throw new Error(`ui-commands: session "${String(sessionId)}" resolved no scope`);
						return { popup: command.popupFor(actx) };
					}
				}, PopupSelectView));
			});
		}
		//#endregion
		exports.CommandDirectory = CommandDirectory;
		exports.CommandUiRuntime = CommandUiRuntime;
		exports.PopupSelectController = PopupSelectController;
		exports.apply = apply;
		exports.filterOptions = filterOptions;
		exports.inject = inject;
		return module.exports;
	}
});
