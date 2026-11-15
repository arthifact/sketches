// Ages are counted in frames at 60 Hz.
export function isHighlighted(node, currentBurst) {
  return node.burstId === currentBurst && node.age < 45;
}

// Far and old nodes first, the white recent ones on top.
export function nodeRenderOrder(nodes, projections, currentBurst) {
  return nodes
    .map((_, i) => i)
    .sort(
      (a, b) =>
        Number(isHighlighted(nodes[a], currentBurst)) -
          Number(isHighlighted(nodes[b], currentBurst)) ||
        projections[b].depth - projections[a].depth,
    );
}
