import type { ForgeEvent } from '../../../shared/types.ts';
import { clock } from '../chat.ts';

/** The raw event log, for debugging. Not part of the design: hidden until asked for. */
export function EventsDrawer({ events, onClose }: { events: ForgeEvent[]; onClose: () => void }) {
  const recent = events.slice(-300).reverse();
  return (
    <aside className="cockpit-drawer" aria-label="Raw events">
      <div className="fa-card__head">
        <span className="fa-card__cap" />
        <h2 className="fa-card__title">Raw events</h2>
        <span className="fa-card__bar" />
        <button className="fa-btn fa-btn--secondary" onClick={onClose}>Close</button>
      </div>
      <div className="cockpit-drawer__scroll">
        <table className="fa-table">
          <thead>
            <tr><th>Time</th><th>Source</th><th>Kind</th><th>Agent</th><th>Payload</th></tr>
          </thead>
          <tbody>
            {recent.map((e) => (
              <tr key={e.id}>
                <td className="fa-data">{clock(e.ts)}</td>
                <td className="fa-data">{e.source}</td>
                <td className="fa-data">{e.kind}{e.payload?.body?.tool_name ? ` ${e.payload.body.tool_name}` : ''}</td>
                <td className="fa-data">{e.agentId ? e.agentId.slice(-8) : 'main'}</td>
                <td className="fa-data cockpit-drawer__payload">{JSON.stringify(e.payload).slice(0, 240)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </aside>
  );
}
