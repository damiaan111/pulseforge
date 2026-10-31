// The node view (C2): the project as a graph, in a wide drawer. Looking only: a click selects the
// layer a node belongs to, and everything else is edited where it always is.

import { useMemo } from 'react';

import { NODE_HEIGHT, NODE_WIDTH, edgePath, layoutGraph, type GraphNode } from '../../project/node-graph.ts';
import { useModules } from '../modules.ts';
import { useStudio } from '../store.ts';

export function NodeView(): React.JSX.Element | null {
  const open = useStudio((s) => s.nodeViewOpen);
  const setOpen = useStudio((s) => s.setNodeViewOpen);
  const document = useStudio((s) => s.document);
  const selected = useStudio((s) => s.selectedLayerId);
  const select = useStudio((s) => s.select);
  const { manifests } = useModules();
  const graph = useMemo(() => (open ? layoutGraph(document, (id) => manifests.get(id)) : null), [open, document, manifests]);
  if (graph === null) return null;

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const isSelected = (node: GraphNode) => node.layerId === selected && (node.layerId !== null || node.kind === 'output');

  return (
    <aside className="queue-drawer node-drawer" aria-label="Node view" data-testid="node-view">
      <div className="queue-head">
        <h2>Nodes</h2>
        <span className="dim">Read-only. Click a node to select its layer; edit it in the inspector.</span>
        <span className="spacer" />
        <button type="button" data-action="node-view-close" onClick={() => setOpen(false)}>Close</button>
      </div>
      {graph.unplaced > 0 && (
        <p className="warn binding-note" data-testid="node-view-unplaced">
          {graph.unplaced} binding{graph.unplaced === 1 ? ' points' : 's point'} at something not in the project. See the modulation matrix.
        </p>
      )}
      <svg className="node-graph" width={graph.width} height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`} role="img" aria-label="The layers, effects and modulations of this project">
        {graph.edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (from === undefined || to === undefined) return null;
          return (
            <path key={edge.id} className={`node-edge ${edge.kind}${edge.dimmed ? ' dimmed' : ''}`} d={edgePath(from, to)}>
              {edge.label === '' ? null : <title>{edge.label}</title>}
            </path>
          );
        })}
        {graph.nodes.map((node) => (
          <g
            key={node.id}
            className={`node ${node.kind}${node.dimmed ? ' dimmed' : ''}${isSelected(node) ? ' selected' : ''}${node.layerId === undefined ? '' : ' clickable'}`}
            transform={`translate(${node.x} ${node.y})`}
            data-node={node.id}
            {...(node.layerId === undefined ? {} : {
              'data-action': 'node-select',
              role: 'button',
              tabIndex: 0,
              onClick: () => select(node.layerId ?? null),
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') select(node.layerId ?? null);
              },
            })}
          >
            <title>{`${node.label} (${node.detail})`}</title>
            <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={5} />
            <foreignObject x={0} y={0} width={NODE_WIDTH} height={NODE_HEIGHT}>
              <div className="node-text">
                <span className="node-label">{node.label}</span>
                <span className="node-detail">{node.detail}</span>
              </div>
            </foreignObject>
          </g>
        ))}
      </svg>
    </aside>
  );
}
