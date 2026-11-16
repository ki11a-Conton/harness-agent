// Harness Agent UI derivative; original retained under plugins/.
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-model-selection",
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
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let react_dom = require("react-dom");
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
		//#region lib/types/client/catalog.js
		/** One Host-generation model catalog shared by every Session selector. */
		/** Loads at most one model catalog for the current Host generation. */
		var ModelCatalogDirectory = class {
			ctx;
			/** Current shared catalog value and load lifecycle. */
			store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				value: null,
				status: "idle",
				error: null
			});
			reasoning = /* @__PURE__ */ new Map();
			/**
			* Read the last advertised reasoning metadata, including unavailable models.
			* @param selection - provider and model whose effort is displayed.
			* @returns reasoning metadata observed during this Host generation.
			*/
			reasoningFor(selection) {
				return this.reasoning.get(JSON.stringify([selection.provider, selection.model]));
			}
			generation = 0;
			inflight;
			/**
			* @param ctx - the providing plugin's context, whose `remote.session`
			* namespace carries the Host-generation catalog.
			*/
			constructor(ctx) {
				this.ctx = ctx;
			}
			/**
			* Return the current generation's catalog, sharing its one in-flight load.
			* @returns the loaded global catalog.
			*/
			load() {
				const state = this.store.getSnapshot();
				if (state.status === "ready" && state.value !== null) return Promise.resolve(state.value);
				if (this.inflight !== void 0) return this.inflight;
				const generation = this.generation;
				this.store.update((draft) => {
					draft.status = "loading";
					draft.error = null;
				});
				const operation = this.ctx.remote.session.modelCatalog().then((response) => {
					if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
					if (generation === this.generation) {
						for (const group of response.value.groups) for (const model of group.models) this.reasoning.set(JSON.stringify([group.id, model.id]), model.reasoning);
						this.store.set({
							value: response.value,
							status: "ready",
							error: null
						});
					}
					return response.value;
				}).catch((error) => {
					if (generation === this.generation) this.store.update((draft) => {
						draft.status = "error";
						draft.error = error instanceof Error ? error.message : String(error);
					});
					throw error;
				}).finally(() => {
					if (generation === this.generation && this.inflight === operation) this.inflight = void 0;
				});
				this.inflight = operation;
				return operation;
			}
			/**
			* Invalidate the loaded catalog; the next explicit menu read reloads it.
			* @param clear - whether values from the previous Host generation must be hidden.
			*/
			invalidate(clear = false) {
				this.generation += 1;
				this.inflight = void 0;
				const value = clear ? null : this.store.getSnapshot().value;
				this.store.set({
					value,
					status: "idle",
					error: null
				});
			}
			/** Invalidate and reload the catalog after a Host-side model input changes. */
			refresh() {
				this.invalidate();
				this.load().catch(() => {});
			}
			/** Clear Host-specific values and load the replacement Host generation. */
			resetGeneration() {
				this.reasoning.clear();
				this.invalidate(true);
				this.load().catch(() => {});
			}
		};
		//#endregion
		//#region lib/types/client/directory.js
		/** One session's shared directory controller; disposed with the session scope. */
		var ModelDirectory = class {
			sessions;
			sessionId;
			available;
			catalog;
			projected;
			isBlank;
			track;
			/** The shared snapshot both entries render from (uSES-safe store). */
			store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				current: null,
				routable: null,
				groups: [],
				failures: [],
				status: "idle",
				pending: null,
				error: null
			});
			/** Latest selection operation wins; an older response never overwrites a newer one. */
			generation = 0;
			disposed = false;
			unsubscribeCatalog;
			unsubscribeSelection;
			/**
			* @param sessions - the session wire face (captured from the plugin's root connection).
			* @param sessionId - the owning session.
			* @param available - whether this session may use Agent-bound model RPCs.
			* @param catalog - Host-generation catalog shared by every Session.
			* @param projected - durable model selection projected from Session history.
			* @param isBlank - whether this Session has no first message yet.
			* @param track - desktop-only callback after a successful user selection.
			*/
			constructor(sessions, sessionId, available, catalog, projected, isBlank, track) {
				this.sessions = sessions;
				this.sessionId = sessionId;
				this.available = available;
				this.catalog = catalog;
				this.projected = projected;
				this.isBlank = isBlank;
				this.track = track;
				this.unsubscribeCatalog = catalog.store.subscribe(() => {
					this.syncInputs();
				});
				this.unsubscribeSelection = projected.subscribe(() => {
					this.syncInputs();
				});
				this.syncInputs();
			}
			/**
			* Ensure the Host generation's shared available catalog is loaded.
			* @returns the fresh directory value.
			*/
			async load() {
				this.assertAvailable();
				await this.catalog.load();
				this.syncInputs();
				return this.store.getSnapshot();
			}
			/**
			* Select the complete provider/model/reasoning selection. The durable
			* projection frame updates the shared current; failures surface on the store
			* and return with the operation so each entry can present its own failure.
			* @param selection - provider, provider-owned model id, and optional adapter-owned effort.
			* @returns the selection outcome, including the original Remote failure.
			*/
			async select(selection) {
				this.assertAvailable();
				const previous = this.store.getSnapshot().current;
				const previousEffort = previous?.reasoningEffort ?? (previous === null ? void 0 : this.catalog.reasoningFor(previous)?.defaultEffort);
				const nextEffort = selection.reasoningEffort ?? this.catalog.reasoningFor(selection)?.defaultEffort;
				const generation = ++this.generation;
				this.store.update((s) => {
					s.status = "selecting";
					s.pending = selection;
					s.error = null;
				});
				const result = await this.sessions.selectModel({
					sessionId: this.sessionId,
					provider: selection.provider,
					model: selection.model,
					...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
				});
				if (this.disposed || generation !== this.generation) return result.ok ? {
					ok: true,
					value: void 0
				} : result;
				if (!result.ok) {
					this.store.update((s) => {
						s.status = "error";
						s.pending = null;
						s.error = `${result.error.code}: ${result.error.message}`;
					});
					return result;
				}
				if (previous !== null) {
					const from = `${previous.provider}/${previous.model}`;
					const to = `${selection.provider}/${selection.model}`;
					if (from !== to) this.track?.("model_switch", {
						...this.isBlank() ? {} : { session_id: this.sessionId },
						switch_from: from,
						switch_to: to
					});
					if (from === to && previousEffort !== nextEffort) this.track?.("thinking_level_switch", {
						...this.isBlank() ? {} : { session_id: this.sessionId },
						model_name: to,
						switch_from: previousEffort ?? "default",
						switch_to: nextEffort ?? "default"
					});
				}
				this.store.update((s) => {
					s.status = "ready";
					s.pending = null;
					s.error = null;
				});
				this.syncInputs();
				return {
					ok: true,
					value: void 0
				};
			}
			/**
			* Invalidate an in-flight selection response from the previous Host generation.
			*/
			resetConnected() {
				if (this.disposed) return;
				++this.generation;
				this.store.update((state) => {
					if (state.status === "selecting") state.status = "idle";
					state.pending = null;
					state.error = null;
				});
				this.syncInputs();
			}
			/** Scope teardown: late settlements lose write access to the store. */
			dispose() {
				this.disposed = true;
				this.unsubscribeSelection();
				this.unsubscribeCatalog();
			}
			assertAvailable() {
				if (!this.available()) throw new Error("model selection is unavailable for addressed subagent sessions");
			}
			syncInputs() {
				if (this.disposed) return;
				const catalog = this.catalog.store.getSnapshot();
				const projected = modelSelectionProjection(this.projected.getSnapshot());
				const intended = projected?.next ?? catalog.value?.default;
				const reasoning = intended === void 0 ? void 0 : this.catalog.reasoningFor(intended);
				const effort = intended?.reasoningEffort ?? reasoning?.defaultEffort;
				const retainedEffort = effort === void 0 ? void 0 : reasoning?.efforts.find((level) => level.id === effort)?.name ?? effort;
				if (catalog.status !== "ready" || catalog.value === null || projected === void 0) {
					this.store.set({
						current: catalog.value === null ? null : this.store.getSnapshot().current,
						...retainedEffort === void 0 ? {} : { retainedEffort },
						routable: null,
						groups: catalog.value?.groups ?? [],
						failures: catalog.value?.failures ?? [],
						status: catalog.status === "error" ? "error" : "loading",
						pending: this.store.getSnapshot().pending,
						error: catalog.error
					});
					return;
				}
				const selection = projected.next ?? catalog.value.default;
				const routable = catalog.value.groups.some((group) => group.id === selection.provider && group.models.some((model) => model.id === selection.model));
				this.store.set({
					current: selection,
					...retainedEffort === void 0 ? {} : { retainedEffort },
					routable,
					groups: catalog.value.groups,
					failures: catalog.value.failures,
					status: this.store.getSnapshot().status === "selecting" ? "selecting" : "ready",
					pending: this.store.getSnapshot().pending,
					error: null
				});
			}
		};
		function modelSelectionProjection(value) {
			return value === void 0 ? void 0 : value;
		}
		//#endregion
		//#region lib/types/client/service.js
		/** The `ctx.modelDirectories` session model-selection service. */
		var ModelDirectoryResolver = class extends _deepseek_ai_cordis.Service {
			static inject = [
				"sessions",
				"remote",
				"remote.session"
			];
			live = { directories: new WeakMapWithValues() };
			catalog;
			/**
			* @param ctx - owning root context (the service registers itself as `models`).
			*/
			constructor(ctx) {
				super(ctx, "modelDirectories");
				this.catalog = new ModelCatalogDirectory(ctx);
				this.catalog.load().catch(() => {});
				ctx.on("connection/reset", () => {
					this.catalog.resetGeneration();
					for (const directory of this.live.directories.values) directory.resetConnected();
				});
				ctx.remote.$on("llm/adapters-updated", () => {
					this.catalog.refresh();
				});
				ctx.remote.$on("settings/document-updated", () => {
					this.catalog.refresh();
				});
				ctx.remote.$on("credentials/record-updated", () => {
					this.catalog.refresh();
				});
				ctx.remote.$on("credentials/reference-updated", () => {
					this.catalog.refresh();
				});
			}
			/**
			* Resolve the per-session shared directory (lazy; the scope disposer
			* removes and disposes it). Unknown sessions fail loud.
			* @param sessionId - the owning session.
			* @returns the resident directory both entries share.
			*/
			directoryFor(sessionId) {
				const { live } = this;
				const sessions = this.ctx.sessions;
				const actx = sessions.scope(sessionId);
				if (actx === void 0) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`);
				const binding = sessions.binding(sessionId);
				if (binding === void 0) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no binding`);
				const existing = live.directories.get(binding);
				if (existing !== void 0) return existing;
				const directory = new ModelDirectory(this.ctx.remote.session, sessionId, () => sessions.subagentAddress(sessionId) === void 0, this.catalog, binding.session.projections.faceOf("modelSelection"), () => binding.session.getSnapshot().blank, (name, attributes) => this.ctx.get("productAnalytics")?.track(name, attributes));
				live.directories.set(binding, directory);
				actx.effect(() => () => {
					directory.dispose();
					live.directories.delete(binding);
				}, "ui-model-selection: session directory");
				return directory;
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
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.module.css.mjs
		const css = "._7KE1Ra_root{min-width:0;position:relative}._7KE1Ra_trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:400;line-height:20px;display:flex}._7KE1Ra_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}._7KE1Ra_trigger:focus-visible:not([data-selection-focus]){box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}._7KE1Ra_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}._7KE1Ra_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}._7KE1Ra_triggerEffort{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-caption);flex-shrink:1000;overflow:hidden}._7KE1Ra_triggerIcon{display:var(--dsh-composer-model-icon-display,none);flex:none}._7KE1Ra_triggerLabel,._7KE1Ra_triggerEffort{display:var(--dsh-composer-model-text-display,block)}._7KE1Ra_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}._7KE1Ra_chevronOpen{transform:rotate(180deg)}._7KE1Ra_menu{z-index:1100;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;flex-direction:column;padding:4px;display:flex;position:fixed;overflow:hidden}._7KE1Ra_status,._7KE1Ra_empty{color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px;line-height:18px}._7KE1Ra_error,._7KE1Ra_warning{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:3px;padding:6px 7px;font-size:11px;line-height:16px;display:flex}._7KE1Ra_warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}._7KE1Ra_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}._7KE1Ra_searchRow{flex-shrink:0;margin:2px 0 3px;position:relative}._7KE1Ra_searchRow ._7KE1Ra_search{border-radius:var(--dsw-radius-md);background:0 0;border:0 solid #0000;height:auto;padding:5px 7px;display:flex}._7KE1Ra_searchRow ._7KE1Ra_searchWithQuery{padding-right:34px}._7KE1Ra_searchClear{corner-shape:round;width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex;position:absolute;top:50%;right:4px;transform:translateY(-50%)}._7KE1Ra_searchClear:hover,._7KE1Ra_searchClear:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}._7KE1Ra_searchRow ._7KE1Ra_search:focus-within{border-color:#0000}._7KE1Ra_searchRow ._7KE1Ra_search input{padding:0;font-size:12px;line-height:normal}._7KE1Ra_searchRow ._7KE1Ra_search input::placeholder{color:var(--dsw-alias-label-caption)}._7KE1Ra_groups{min-height:0;overflow-y:auto}._7KE1Ra_option{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;min-height:34px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:5px 7px;display:flex}._7KE1Ra_option:not(._7KE1Ra_modelOption):hover:not(:disabled),._7KE1Ra_option:focus-visible,._7KE1Ra_optionActive:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}._7KE1Ra_selected{background:0 0}._7KE1Ra_option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}._7KE1Ra_optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}._7KE1Ra_modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:400;line-height:18px;overflow:hidden}._7KE1Ra_check{color:var(--dsw-alias-label-primary);flex:0 0 14px;place-items:center;display:grid}._7KE1Ra_check svg{width:14px;height:14px}._7KE1Ra_cell{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;height:34px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:0 8px;font-size:13px;line-height:20px;display:flex}._7KE1Ra_cell:hover,._7KE1Ra_cell:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}._7KE1Ra_cellLabel{white-space:nowrap;flex:none}._7KE1Ra_cellValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}._7KE1Ra_cellChevron{width:12px;height:12px;color:var(--dsw-alias-menu-icon);flex:none}";
		const tagId = "@deepseek-ai/dsh-client-ui-model-selection/ModelSelect.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-model-selection";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ModelSelect_module_css_default = {
			"cell": "_7KE1Ra_cell",
			"cellChevron": "_7KE1Ra_cellChevron",
			"cellLabel": "_7KE1Ra_cellLabel",
			"cellValue": "_7KE1Ra_cellValue",
			"check": "_7KE1Ra_check",
			"chevron": "_7KE1Ra_chevron",
			"chevronOpen": "_7KE1Ra_chevronOpen",
			"empty": "_7KE1Ra_empty",
			"error": "_7KE1Ra_error",
			"groups": "_7KE1Ra_groups",
			"menu": "_7KE1Ra_menu",
			"modelName": "_7KE1Ra_modelName",
			"modelOption": "_7KE1Ra_modelOption",
			"option": "_7KE1Ra_option",
			"optionActive": "_7KE1Ra_optionActive",
			"optionCopy": "_7KE1Ra_optionCopy",
			"retry": "_7KE1Ra_retry",
			"root": "_7KE1Ra_root",
			"search": "_7KE1Ra_search",
			"searchClear": "_7KE1Ra_searchClear",
			"searchRow": "_7KE1Ra_searchRow",
			"searchWithQuery": "_7KE1Ra_searchWithQuery",
			"selected": "_7KE1Ra_selected",
			"status": "_7KE1Ra_status",
			"trigger": "_7KE1Ra_trigger",
			"triggerEffort": "_7KE1Ra_triggerEffort",
			"triggerIcon": "_7KE1Ra_triggerIcon",
			"triggerLabel": "_7KE1Ra_triggerLabel",
			"warning": "_7KE1Ra_warning"
		};
		//#endregion
		//#region lib/types/client/provider-order.js
		/** Shared provider display order for the composer and command model pickers. */
		/**
		* Put the account and official providers first, preserving every other relative order.
		* @param groups - Provider groups in catalog order.
		* @returns a sorted copy; model order within each group is unchanged.
		*/
		function orderModelProviders(groups) {
			return groups.toSorted((left, right) => (left.id === "deepseek-account" ? 0 : left.id === "deepseek-official" ? 1 : 2) - (right.id === "deepseek-account" ? 0 : right.id === "deepseek-official" ? 1 : 2));
		}
		//#endregion
		//#region lib/types/client/ModelSelect.js
		/**
		* ModelSelect: the composer's named model seat (`conversation.input.model`).
		* Two-level selection per figma 496:26454's MenuDropdown: the root menu is
		* the Model / Effort row pair (label + current value + a right chevron),
		* each drilling into its own list — the provider-grouped model list over
		* the shared directory, and the effort levels. The trigger (313:14108's
		* ToggleButton) shows both: model name + effort in the caption tone.
		* Model catalogs above four entries show search, which retains focus while
		* ↑/↓ cycle the highlighted result; Enter and Tab accept it. Smaller model
		* catalogs, root panes, and effort panes move focus between rows. Escape and Shift+Tab leave a drilled pane first and otherwise close
		* back to the trigger. A drilled pane focuses the current effort or model
		* search field. Provider headings paint their background only while pinned
		* by scrolling. Clearing a query restores the full list and search focus.
		* Selecting restores trigger focus without a ring until the trigger loses focus
		* or the menu reopens. Model names match a case-insensitive ordered subsequence
		* within each provider group, ranked by
		* prefix, alignment score, then catalog order. Returning to the root pane
		* hands focus back to the cell that opened it. Data and submission ride the
		* same per-session ModelDirectory as the /model popup; exact-model reasoning
		* metadata and the selected effort come from the Host rather than a
		* client-owned vocabulary. A rejected selection announces through the shared
		* transient Toast anchored to the composer card; the in-menu strip with
		* Retry remains the catalog-load surface. While the directory's pending
		* selection is unsettled, the trigger shows a spinner in place of its
		* chevron, and each row whose value that selection carries shows one in place
		* of its check mark.
		*/
		/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
		const MEASURE_STYLE = {
			visibility: "hidden",
			left: 0,
			top: 0
		};
		/**
		* Render the composer model seat.
		* @param props - owner share (locked) + injected face (shared directory
		* store/verbs) + the standard locale seat.
		* @returns the trigger and, while open, the two-level menu.
		*/
		function ModelSelect({ locked, available, directory, load, select, t }) {
			const state = (0, react.useSyncExternalStore)((fn) => directory.subscribe(fn), () => directory.getSnapshot());
			const [open, setOpen] = (0, react.useState)(false);
			const [pane, setPane] = (0, react.useState)("root");
			const [query, setQuery] = (0, react.useState)("");
			const [highlightedIndex, setHighlightedIndex] = (0, react.useState)(null);
			const [selectionFocus, setSelectionFocus] = (0, react.useState)(false);
			const lastActionRef = (0, react.useRef)("load");
			const [toast, setToast] = (0, react.useState)(null);
			const toastSeq = (0, react.useRef)(0);
			const rootRef = (0, react.useRef)(null);
			const triggerRef = (0, react.useRef)(null);
			const searchRef = (0, react.useRef)(null);
			const menuRef = (0, react.useRef)(null);
			const groupsRef = (0, react.useRef)(null);
			const [menuPos, setMenuPos] = (0, react.useState)(null);
			const itemRefs = (0, react.useRef)([]);
			const id = (0, react.useId)();
			const groups = (0, react.useMemo)(() => orderModelProviders(state.groups), [state.groups]);
			const choices = (0, react.useMemo)(() => groups.flatMap((group) => group.models.map((model) => ({
				group,
				model,
				selection: {
					provider: group.id,
					model: model.id,
					...model.reasoning?.defaultEffort === void 0 ? {} : { reasoningEffort: model.reasoning.defaultEffort }
				}
			}))), [groups]);
			const showSearch = choices.length > 4;
			const groupIndexes = (0, react.useMemo)(() => groups.map(group => ({ group, index: new harnessTextSearch.TextSearchIndex(group.models, model => ({ fuzzy: [model.name, model.id], substring: [model.description] })) })), [groups]);
			const filteredGroups = (0, react.useMemo)(() => groupIndexes.map(({ group, index }) => ({ ...group, models: index.search(showSearch ? query : "") })).filter(group => group.models.length > 0), [
				groupIndexes,
				query,
				showSearch
			]);
			const visibleModels = (0, react.useMemo)(() => filteredGroups.flatMap((group) => group.models.map((model) => ({
				provider: group.id,
				model: model.id
			}))), [filteredGroups]);
			const currentVisibleIndex = visibleModels.findIndex((model) => model.provider === state.current?.provider && model.model === state.current.model);
			const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1);
			const currentChoice = choices[state.current === null ? -1 : choices.findIndex((c) => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)];
			const reasoning = currentChoice?.model.reasoning;
			const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
			const effortLabel = reasoning === void 0 ? state.retainedEffort : effectiveEffort === void 0 ? t("effort.providerDefault") : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort;
			const effortChoices = (0, react.useMemo)(() => reasoning === void 0 ? [] : [...reasoning.defaultEffort === void 0 ? [{
				key: "provider-default",
				effort: void 0,
				label: t("effort.providerDefault")
			}] : [], ...reasoning.efforts.map((effort) => ({
				key: `effort:${effort.id}`,
				effort: effort.id,
				label: effort.name
			}))], [reasoning, t]);
			const { pending } = state;
			const busy = pending !== null;
			const reload = () => {
				lastActionRef.current = "load";
				load();
			};
			(0, react.useEffect)(() => {
				if (!open) return;
				const closeOutside = (event) => {
					if (rootRef.current?.contains(event.target) === true) return;
					if (menuRef.current?.contains(event.target) === true) return;
					setOpen(false);
				};
				document.addEventListener("mousedown", closeOutside);
				return () => {
					document.removeEventListener("mousedown", closeOutside);
				};
			}, [open]);
			(0, react.useLayoutEffect)(() => {
				if (!showSearch) {
					setQuery("");
					setHighlightedIndex(null);
				}
			}, [showSearch]);
			const paneFocus = (0, react.useRef)(null);
			const previousShowSearch = (0, react.useRef)(showSearch);
			(0, react.useEffect)(() => {
				const changedSearchMode = previousShowSearch.current !== showSearch;
				previousShowSearch.current = showSearch;
				const intent = paneFocus.current ?? (changedSearchMode && pane === "model" ? "drill" : null);
				paneFocus.current = null;
				if (!open || intent === null) return;
				if (intent === "drill") {
					if (pane === "model" && showSearch) {
						searchRef.current?.focus();
						return;
					}
					(menuRef.current?.querySelector("[role=\"menuitemradio\"][aria-checked=\"true\"]:not([disabled])") ?? itemRefs.current.find((item) => item !== null && !item.disabled) ?? triggerRef.current)?.focus();
					return;
				}
				const cell = itemRefs.current[intent === "effort" ? 1 : 0];
				(cell !== null && cell !== void 0 && !cell.disabled ? cell : triggerRef.current)?.focus();
			}, [
				open,
				pane,
				showSearch
			]);
			(0, react.useEffect)(() => {
				const viewport = groupsRef.current;
				if (viewport === null) return;
				return (0, _deepseek_ai_dsh_client_ui_primitives.observeStickyMenuGroups)(viewport);
			}, [
				available,
				open,
				pane,
				filteredGroups
			]);
			(0, react.useLayoutEffect)(() => {
				if (open && pane === "model" && activeModelIndex >= 0) itemRefs.current[activeModelIndex]?.scrollIntoView({ block: "nearest" });
			}, [
				open,
				pane,
				activeModelIndex,
				visibleModels
			]);
			(0, react.useLayoutEffect)(() => {
				if (!open) {
					setMenuPos(null);
					return;
				}
				const place = () => {
					/* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
					const rect = triggerRef.current?.getBoundingClientRect();
					if (rect === void 0) return;
					const MARGIN = 12;
					const lw = menuRef.current?.offsetWidth ?? 0;
					const lh = menuRef.current?.offsetHeight ?? 0;
					let x = rect.right - lw;
					let y = rect.top - 8 - lh;
					if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN);
					if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN);
					setMenuPos({
						left: x,
						top: y
					});
				};
				place();
				window.addEventListener("scroll", place, true);
				window.addEventListener("resize", place);
				return () => {
					window.removeEventListener("scroll", place, true);
					window.removeEventListener("resize", place);
				};
			}, [
				open,
				pane,
				state,
				query
			]);
			if (!available) return null;
			const show = () => {
				setSelectionFocus(false);
				triggerRef.current?.focus();
				setQuery("");
				setHighlightedIndex(null);
				if (state.current === null) paneFocus.current = "drill";
				setPane(state.current === null ? "model" : "root");
				setOpen(true);
				reload();
			};
			const changeQuery = (next) => {
				setQuery(next);
				setHighlightedIndex(0);
			};
			const close = (restoreFocus = false) => {
				setOpen(false);
				setPane("root");
				if (restoreFocus) queueMicrotask(() => {
					triggerRef.current?.focus();
				});
			};
			const closeAfterSelection = () => {
				setSelectionFocus(true);
				close(true);
			};
			const drill = (next) => {
				setQuery("");
				setHighlightedIndex(null);
				paneFocus.current = "drill";
				setPane(next);
			};
			/** Leave a drilled pane for the root one, handing the keyboard back to its cell. */
			const back = (from) => {
				paneFocus.current = from;
				setPane("root");
			};
			const moveFocus = (offset) => {
				const items = itemRefs.current.filter((item) => item !== null);
				if (items.length === 0) return;
				const active = items.findIndex((item) => item === document.activeElement);
				items[active === -1 ? offset > 0 ? 0 : items.length - 1 : (active + offset + items.length) % items.length]?.focus();
			};
			const onRootKeyDown = (event) => {
				if (event.nativeEvent.isComposing) return;
				if (event.key === "Escape" && open) {
					event.preventDefault();
					if (pane !== "root" && state.current !== null) back(pane);
					else close(true);
					return;
				}
				if (!open) return;
				if (pane === "model" && showSearch && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
					event.preventDefault();
					if (!busy && visibleModels.length > 0) {
						setHighlightedIndex((activeModelIndex + (event.key === "ArrowDown" ? 1 : -1) + visibleModels.length) % visibleModels.length);
						searchRef.current?.focus();
					}
					return;
				}
				if (pane === "model" && showSearch && event.target instanceof HTMLInputElement && (event.key === "Enter" || event.key === "Tab" && !event.shiftKey)) {
					if (event.key === "Tab" && visibleModels.length === 0) return;
					event.preventDefault();
					const highlighted = visibleModels[activeModelIndex];
					if (!busy && highlighted !== void 0) choose(highlighted);
					return;
				}
				if (event.key === "Tab") {
					if (event.shiftKey) {
						event.preventDefault();
						if (pane !== "root" && state.current !== null) back(pane);
						else close(true);
						return;
					}
					const focused = document.activeElement;
					const rows = itemRefs.current.filter((item) => item !== null);
					if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
						event.preventDefault();
						focused.click();
						return;
					}
					if (focused !== triggerRef.current) return;
					event.preventDefault();
					if (pane === "model" && showSearch) {
						setHighlightedIndex(null);
						searchRef.current?.focus();
						return;
					}
					(menuRef.current?.querySelector("[role=\"menuitemradio\"][aria-checked=\"true\"]:not([disabled])") ?? rows.find((item) => !item.disabled))?.focus();
					return;
				}
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					moveFocus(event.key === "ArrowDown" ? 1 : -1);
				}
			};
			const onBlur = (event) => {
				if (event.relatedTarget instanceof Node && (rootRef.current?.contains(event.relatedTarget) === true || menuRef.current?.contains(event.relatedTarget) === true)) return;
				close();
			};
			const settleSelection = (result) => {
				if (result === void 0) return;
				if (result.ok) {
					if (rootRef.current !== null) closeAfterSelection();
					return;
				}
				const { error } = result;
				toastSeq.current += 1;
				setToast({
					seq: toastSeq.current,
					text: error.code === "session/writer-held" ? t("error.sessionInUse") : t("error.action", { message: `${error.code}: ${error.message}` })
				});
			};
			const submit = (selection) => {
				lastActionRef.current = "select";
				setSelectionFocus(true);
				triggerRef.current?.focus();
				select(selection).then(settleSelection);
			};
			const choose = (selection) => {
				if (state.current?.provider === selection.provider && state.current.model === selection.model) {
					closeAfterSelection();
					return;
				}
				submit(selection);
			};
			const chooseEffort = (effort) => {
				if (state.current === null) return;
				if (effectiveEffort === effort) {
					closeAfterSelection();
					return;
				}
				submit({
					provider: state.current.provider,
					model: state.current.model,
					...effort === void 0 ? {} : { reasoningEffort: effort }
				});
			};
			const waiting = state.current === null && state.status === "loading";
			const modelLabel = waiting ? t("trigger.loading") : currentChoice?.model.name ?? (state.current === null ? t("trigger.fallback") : `${state.current.provider}/${state.current.model}`);
			const triggerLabel = effortLabel === void 0 ? modelLabel : `${modelLabel} · ${effortLabel}`;
			const triggerAria = waiting ? t("trigger.loading") : state.current === null ? t("trigger.selectAria") : effortLabel === void 0 ? t("trigger.aria", { model: modelLabel }) : t("trigger.ariaEffort", {
				model: modelLabel,
				effort: effortLabel
			});
			itemRefs.current = [];
			let itemIndex = 0;
			let modelIndex = 0;
			const itemRef = () => {
				const at = itemIndex++;
				return (node) => {
					itemRefs.current[at] = node;
				};
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: ModelSelect_module_css_default.root,
				onKeyDown: onRootKeyDown,
				onBlur,
				onMouseDown: (event) => {
					if (event.target instanceof Element && event.target.closest("button") !== null) event.preventDefault();
				},
				children: [
					(0, react_jsx_runtime.jsxs)("button", {
						ref: triggerRef,
						type: "button",
						className: ModelSelect_module_css_default.trigger,
						"aria-label": triggerAria,
						"aria-haspopup": "menu",
						"aria-expanded": open,
						"aria-controls": open ? `${id}-menu` : void 0,
						title: triggerLabel,
						"aria-busy": busy,
						"data-selection-focus": selectionFocus ? "" : void 0,
						onBlur: () => {
							setSelectionFocus(false);
						},
						disabled: locked,
						onClick: () => {
							if (open) close(true);
							else show();
						},
						children: [
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDataOutlineRegular, {
								className: ModelSelect_module_css_default.triggerIcon,
								size: 16
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: ModelSelect_module_css_default.triggerLabel,
								children: modelLabel
							}),
							effortLabel !== void 0 && (0, react_jsx_runtime.jsx)("span", {
								className: ModelSelect_module_css_default.triggerEffort,
								children: effortLabel
							}),
							busy ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "ongoing" }) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { className: clsx(ModelSelect_module_css_default.chevron, open && ModelSelect_module_css_default.chevronOpen) })
						]
					}),
					open && (0, react_dom.createPortal)((0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.MenuSurface, {
						ref: menuRef,
						id: `${id}-menu`,
						className: ModelSelect_module_css_default.menu,
						style: menuPos ?? MEASURE_STYLE,
						role: pane === "model" ? "group" : "menu",
						"aria-label": t("menu.aria"),
						"aria-busy": state.status === "loading" || busy,
						children: [
							pane === "root" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("button", {
								ref: itemRef(),
								type: "button",
								role: "menuitem",
								className: ModelSelect_module_css_default.cell,
								onClick: () => {
									drill("model");
								},
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.cellLabel,
										children: t("menu.model")
									}),
									(0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.cellValue,
										children: modelLabel
									}),
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutlineRegular, { className: ModelSelect_module_css_default.cellChevron })
								]
							}), reasoning === void 0 && (0, react_jsx_runtime.jsx)("div", { role: "note", className: ModelSelect_module_css_default.empty, children: t("empty.efforts") }), reasoning !== void 0 && (0, react_jsx_runtime.jsxs)("button", {
								ref: itemRef(),
								type: "button",
								role: "menuitem",
								className: ModelSelect_module_css_default.cell,
								onClick: () => {
									drill("effort");
								},
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.cellLabel,
										children: t("menu.effort")
									}),
									(0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.cellValue,
										children: effortLabel
									}),
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutlineRegular, { className: ModelSelect_module_css_default.cellChevron })
								]
							})] }),
							pane === "model" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								showSearch && (0, react_jsx_runtime.jsxs)("div", {
									className: ModelSelect_module_css_default.searchRow,
									children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
										ref: searchRef,
										className: clsx(ModelSelect_module_css_default.search, query !== "" && ModelSelect_module_css_default.searchWithQuery),
										type: "text",
										role: "searchbox",
										"aria-label": t("search.placeholder"),
										"aria-controls": `${id}-models`,
										"aria-activedescendant": activeModelIndex < 0 ? void 0 : `${id}-model-${activeModelIndex}`,
										placeholder: t("search.placeholder"),
										value: query,
										readOnly: busy,
										onChange: (event) => {
											changeQuery(event.target.value);
										}
									}), query !== "" && (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: ModelSelect_module_css_default.searchClear,
										"aria-label": t("search.clear"),
										disabled: busy,
										onClick: () => {
											changeQuery("");
											searchRef.current?.focus();
										},
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseFillRegular, {})
									})]
								}),
								state.status === "loading" && (0, react_jsx_runtime.jsx)("div", {
									className: ModelSelect_module_css_default.status,
									children: t("status.loading")
								}),
								state.error !== null && lastActionRef.current === "load" && (0, react_jsx_runtime.jsxs)("div", {
									className: ModelSelect_module_css_default.error,
									children: [(0, react_jsx_runtime.jsx)("span", { children: t("error.action", { message: state.error }) }), (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: ModelSelect_module_css_default.retry,
										onClick: reload,
										children: t("retry")
									})]
								}),
								state.failures.map((failure) => (0, react_jsx_runtime.jsxs)("div", {
									className: ModelSelect_module_css_default.warning,
									children: [(0, react_jsx_runtime.jsx)("span", { children: t("warning.groupLoad", {
										name: failure.id === "deepseek-account" ? t("provider.account") : failure.name,
										message: failure.message
									}) }), (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: ModelSelect_module_css_default.retry,
										onClick: reload,
										children: t("retry")
									})]
								}, failure.id)),
								(0, react_jsx_runtime.jsx)("div", {
									ref: groupsRef,
									id: `${id}-models`,
									className: clsx(ModelSelect_module_css_default.groups, "scrollable"),
									role: "menu",
									"aria-label": t("menu.model"),
									hidden: filteredGroups.length === 0,
									children: filteredGroups.map((group) => {
										return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuGroup, {
											label: group.id === "deepseek-account" ? t("provider.account") : group.name,
											children: group.models.map((model) => {
												const index = modelIndex++;
												const selected = state.current?.provider === group.id && state.current.model === model.id;
												return (0, react_jsx_runtime.jsxs)("button", {
													ref: itemRef(),
													type: "button",
													role: "menuitemradio",
													"aria-checked": selected,
													id: `${id}-model-${index}`,
													tabIndex: showSearch ? -1 : 0,
													onFocus: () => {
														setHighlightedIndex(index);
													},
													"data-highlighted": index === activeModelIndex ? "" : void 0,
													className: clsx(ModelSelect_module_css_default.option, ModelSelect_module_css_default.modelOption, selected && ModelSelect_module_css_default.selected, index === activeModelIndex && ModelSelect_module_css_default.optionActive),
													onMouseMove: busy || index === activeModelIndex ? void 0 : () => {
														if (showSearch) setHighlightedIndex(index);
														else itemRefs.current[index]?.focus();
													},
													title: model.name,
													disabled: busy,
													onClick: () => {
														choose({
															provider: group.id,
															model: model.id
														});
													},
													children: [(0, react_jsx_runtime.jsx)("span", {
														className: ModelSelect_module_css_default.optionCopy,
														children: (0, react_jsx_runtime.jsx)("span", {
															className: ModelSelect_module_css_default.modelName,
															children: model.name
														})
													}), (0, react_jsx_runtime.jsx)("span", {
														className: ModelSelect_module_css_default.check,
														children: pending?.provider === group.id && pending.model === model.id ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "ongoing" }) : selected ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutlineRegular, {}) : null
													})]
												}, model.id);
											})
										}, group.id);
									})
								}),
								state.status === "ready" && filteredGroups.length === 0 && (0, react_jsx_runtime.jsx)("div", {
									className: ModelSelect_module_css_default.empty,
									role: "status",
									children: t(choices.length === 0 ? "empty.models" : "search.empty")
								})
							] }),
							pane === "effort" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [state.error !== null && lastActionRef.current === "load" && (0, react_jsx_runtime.jsxs)("div", {
								className: ModelSelect_module_css_default.error,
								children: [(0, react_jsx_runtime.jsx)("span", { children: t("error.action", { message: state.error }) }), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: ModelSelect_module_css_default.retry,
									onClick: reload,
									children: t("action.reload")
								})]
							}), effortChoices.length === 0 ? (0, react_jsx_runtime.jsx)("div", {
								className: ModelSelect_module_css_default.empty,
								children: t("empty.efforts")
							}) : effortChoices.map((level) => (0, react_jsx_runtime.jsxs)("button", {
								ref: itemRef(),
								type: "button",
								role: "menuitemradio",
								"aria-checked": effectiveEffort === level.effort,
								className: clsx(ModelSelect_module_css_default.option, effectiveEffort === level.effort && ModelSelect_module_css_default.selected),
								disabled: busy,
								onClick: () => {
									chooseEffort(level.effort);
								},
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: ModelSelect_module_css_default.optionCopy,
									children: (0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.modelName,
										children: level.label
									})
								}), (0, react_jsx_runtime.jsx)("span", {
									className: ModelSelect_module_css_default.check,
									children: pending !== null && pending.provider === state.current?.provider && pending.model === state.current.model && pending.reasoningEffort === level.effort ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "ongoing" }) : effectiveEffort === level.effort ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutlineRegular, {}) : null
								})]
							}, level.key))] })
						]
					}), document.body),
					toast !== null && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: toast.text,
						icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, {}),
						anchor: rootRef.current?.closest("[data-composer-card]") ?? null,
						onDone: () => {
							setToast(null);
						}
					}, toast.seq)
				]
			});
		}
		//#endregion
		//#region lib/types/client/locales.js
		/**
		* `model` namespace dictionaries.
		*
		* `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
		* separate key: the visible fallback label and the accessible name of
		* an unset trigger are free to diverge per locale, and folding it into
		* `trigger.aria` would announce the degenerate "Select model, current Select
		* model".
		*/
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"provider.account": "DeepSeek 账号",
			"command.label": "模型",
			"command.description": "选择本会话使用的模型",
			"option.loadError": "目录加载失败：{message}",
			"trigger.fallback": "请选择模型",
			"trigger.loading": "正在加载模型…",
			"trigger.selectAria": "请选择模型",
			"trigger.aria": "选择模型，当前 {model}",
			"trigger.ariaEffort": "选择模型，当前 {model}，推理等级 {effort}",
			"menu.aria": "模型与推理等级",
			"menu.model": "模型",
			"menu.effort": "推理等级",
			"effort.providerDefault": "Default",
			"status.loading": "正在刷新模型列表…",
			"error.action": "模型操作失败：{message}",
			"error.sessionInUse": "当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。",
			"action.reload": "重新加载",
			"warning.groupLoad": "{name} 加载失败：{message}",
			"search.placeholder": "搜索模型…",
			"search.clear": "清除搜索",
			"search.empty": "没有匹配的模型。",
			"empty.models": "没有可用的模型。",
			"empty.efforts": "当前模型未提供推理等级。"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"provider.account": "DeepSeek Account",
			"command.label": "Model",
			"command.description": "Select the model for this conversation",
			"option.loadError": "Catalog failed to load: {message}",
			"trigger.fallback": "Select model",
			"trigger.loading": "Loading models…",
			"trigger.selectAria": "Select model",
			"trigger.aria": "Select model, current {model}",
			"trigger.ariaEffort": "Select model, current {model}, reasoning effort {effort}",
			"menu.aria": "Model and reasoning effort",
			"menu.model": "Model",
			"menu.effort": "Effort",
			"effort.providerDefault": "Default",
			"status.loading": "Refreshing model list…",
			"error.action": "Model operation failed: {message}",
			"error.sessionInUse": "This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.",
			"action.reload": "Reload",
			"warning.groupLoad": "{name} failed to load: {message}",
			"search.placeholder": "Search models…",
			"search.clear": "Clear search",
			"search.empty": "No matching models.",
			"empty.models": "No models available.",
			"empty.efforts": "This model provides no reasoning effort levels."
		};
		//#endregion
		//#region lib/types/client/index.js
		/** One selectable row's id: an opaque row key (resolved by lookup, never parsed). */
		function rowId(providerId, modelId) {
			return `${providerId}/${modelId}`;
		}
		/** Flatten the directory into popup rows; failure rows are listed for visibility but never selectable. */
		function optionsOf(directory, t) {
			const rows = [];
			for (const group of orderModelProviders(directory.groups)) {
				const name = group.id === "deepseek-account" ? t("provider.account") : group.name;
				for (const model of group.models) rows.push({
					id: rowId(group.id, model.id),
					label: model.name,
					group: {
						name: group.id,
						label: name
					},
					...directory.current !== null && directory.current.provider === group.id && directory.current.model === model.id ? { active: true } : {}
				});
			}
			for (const failure of directory.failures) rows.push({
				id: `failure/${failure.id}`,
				label: failure.id === "deepseek-account" ? t("provider.account") : failure.name,
				detail: t("option.loadError", { message: failure.message })
			});
			return rows;
		}
		/**
		* Resolve a picked row back to its model selection by matching against the loaded
		* groups (the same data the rows were built from — ids stay opaque).
		* @param state - the session's directory snapshot.
		* @param id - the picked row id.
		* @returns the row's model selection, or undefined for failure rows / stale ids.
		*/
		function selectionOf(state, id) {
			for (const group of state.groups) for (const model of group.models) {
				if (rowId(group.id, model.id) !== id) continue;
				const reasoningEffort = state.current?.provider === group.id && state.current.model === model.id ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort : model.reasoning?.defaultEffort;
				return {
					provider: group.id,
					model: model.id,
					...reasoningEffort === void 0 ? {} : { reasoningEffort }
				};
			}
		}
		/** Dictionary namespace owned by this plugin. */
		const NS = "model";
		/** Required services: the contribution registry, the seat's slot registry, locale, and the service's own faces. */
		const inject = [
			"commandUi",
			"locale",
			"sessions",
			"slots",
			"remote",
			"remote.session"
		];
		/**
		* Client plugin body: mount ModelDirectoryResolver, register the `model` dictionaries,
		* then register the /model popup contribution and the composer model seat
		* over the service.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-model-selection: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.plugin(ModelDirectoryResolver);
			ctx.inject(["commandUi", "modelDirectories"], (scope) => {
				const command = scope.get("commandUi");
				const models = scope.modelDirectories;
				const sessions = scope.sessions;
				scope.effect(() => command.register({
					name: "model",
					label: () => t("command.label"),
					description: () => t("command.description"),
					icon: _deepseek_ai_dsh_client_ui_primitives.IconDataOutlineRegular,
					available: (session) => sessions.subagentAddress(session.sessionId) === void 0,
					ui: {
						kind: "popupSelect",
						searchMode: "fuzzy-label",
						searchLabels: () => ({
							placeholder: t("search.placeholder"),
							empty: t("empty.models"),
							noResults: t("search.empty")
						}),
						options: async (session) => {
							if (sessions.subagentAddress(session.sessionId) !== void 0) throw new Error("model selection is unavailable for addressed subagent sessions");
							return optionsOf(await models.directoryFor(session.sessionId).load(), t);
						},
						onSelect: async (option, session) => {
							if (sessions.subagentAddress(session.sessionId) !== void 0) throw new Error("model selection is unavailable for addressed subagent sessions");
							const directory = models.directoryFor(session.sessionId);
							const selection = selectionOf(directory.store.getSnapshot(), option.id);
							if (selection === void 0) throw new Error("this provider's catalog failed to load — pick a model from a loaded group");
							const result = await directory.select(selection);
							if (!result.ok) {
								if (result.error.code === "session/writer-held") throw new Error(t("error.sessionInUse"));
								throw result.error;
							}
						}
					}
				}), "ui-model-selection: /model contribution");
			});
			ctx.inject(["slots", "modelDirectories"], (scope) => {
				const models = scope.modelDirectories;
				const sessions = scope.sessions;
				scope.slots.inject("conversation.input.model", () => scope.slots.register({
					name: "conversation.input.model",
					locale: NS,
					inject: (sessionId) => {
						const directory = models.directoryFor(sessionId);
						const available = sessions.subagentAddress(sessionId) === void 0;
						return {
							available,
							directory: directory.store,
							load: () => {
								if (available) directory.load().catch(() => {});
							},
							select: (selection) => available ? directory.select(selection) : Promise.resolve(void 0)
						};
					}
				}, ModelSelect));
			});
		}
		//#endregion
		exports.ModelDirectory = ModelDirectory;
		exports.ModelDirectoryResolver = ModelDirectoryResolver;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
