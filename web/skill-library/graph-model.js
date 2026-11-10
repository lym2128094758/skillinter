(function (root) {
  function matches(node, query) {
    const parts = query.match(/-?(?:\w+:)?(?:"[^"]*"|[^\s]+)/g) || [];
    return parts.every((part) => {
      const negative = part.startsWith("-");
      if (negative) part = part.slice(1);
      const field = /^(name|path|source):/.exec(part);
      const value = (field ? part.slice(field[0].length) : part).replace(/^"|"$/g, "").toLowerCase();
      const text = field ? node[field[1]] || "" : [node.name, node.description, node.path, node.source].join(" ");
      const found = text.toLowerCase().includes(value);
      return negative ? !found : found;
    });
  }
  function mergeEdges(edges, validIds, kinds) {
    const pairs = new Map();
    for (const edge of edges) {
      if (!kinds.has(edge.kind) || !validIds.has(edge.source) || !validIds.has(edge.target) || edge.source === edge.target) continue;
      const [a, b] = [edge.source, edge.target].sort();
      const key = a + ":" + b;
      const pair = pairs.get(key) || { key, source: a, target: b, kinds: [], forward: false, backward: false };
      if (!pair.kinds.includes(edge.kind)) pair.kinds.push(edge.kind);
      pair.forward ||= edge.source === a ? !!edge.forward : !!edge.backward;
      pair.backward ||= edge.source === a ? !!edge.backward : !!edge.forward;
      pair.kind = pair.kinds.includes("manual") ? "manual" : pair.kinds.includes("mention") ? "mention" : "topic";
      pairs.set(key, pair);
    }
    return [...pairs.values()];
  }
  function filterGraph(nodes, rawEdges, options) {
    let filtered = nodes.filter((node) => !options.hiddenGroups.has(node.group) && matches(node, options.query));
    let ids = new Set(filtered.map((node) => node.id));
    let edges = mergeEdges(rawEdges, ids, options.kinds);
    if (options.mode === "local") {
      const seen = new Set();
      if (ids.has(options.selectedId)) {
        seen.add(options.selectedId);
        let frontier = [options.selectedId];
        const adjacency = new Map(filtered.map((n) => [n.id, []]));
        edges.forEach((e) => { adjacency.get(e.source).push(e.target); adjacency.get(e.target).push(e.source); });
        for (let depth = 0; depth < options.depth; depth++) {
          const next = [];
          for (const id of frontier) for (const neighbor of adjacency.get(id)) {
            if (!seen.has(neighbor)) { seen.add(neighbor); next.push(neighbor); }
          }
          frontier = next;
        }
      }
      ids = seen;
      filtered = filtered.filter((n) => ids.has(n.id));
      edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    }
    const degree = new Map(filtered.map((n) => [n.id, 0]));
    edges.forEach((e) => { degree.set(e.source, degree.get(e.source) + 1); degree.set(e.target, degree.get(e.target) + 1); });
    if (!options.showOrphans) filtered = filtered.filter((n) => degree.get(n.id) > 0);
    const matchedNodes = filtered;
    const limit = Number.isSafeInteger(options.maxNodes) && options.maxNodes > 0 ? options.maxNodes : Infinity;
    if (filtered.length > limit) {
      const pinned = new Set(options.pinnedIds || []);
      if (options.selectedId) pinned.add(options.selectedId);
      const rank = node => pinned.has(node.id) ? 2 : node.group === '当前项目' ? 1 : 0;
      const ranked = [...filtered].sort((a,b)=>rank(b)-rank(a)||(degree.get(b.id)||0)-(degree.get(a.id)||0)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
      const keep = new Set(ranked.slice(0,Math.max(limit,ranked.filter(node=>pinned.has(node.id)).length)).map(node=>node.id));
      filtered = filtered.filter(node=>keep.has(node.id));
      edges = edges.filter(edge=>keep.has(edge.source)&&keep.has(edge.target));
    }
    return { nodes: filtered, edges, degree, matchedNodes, truncated:filtered.length < matchedNodes.length };
  }
  function labelOpacity(scale, threshold) {
    const t = Math.max(0, Math.min(1, (scale - threshold + .3) / .65));
    return t * t * (3 - 2 * t);
  }
  const api = { matches, mergeEdges, filterGraph, labelOpacity };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SkillGraphModel = api;
})(typeof window !== "undefined" ? window : globalThis);
