import { Building2, Laptop, Plus, WifiOff } from 'lucide-react';
import type { Snapshot } from '../shared/types';
import { LOCAL_ROOM, sessionRoom } from '../shared/rooms';
import { useI18n } from '../lib/i18n';

export function OfficeRooms({
  snapshot,
  selected,
  onSelect,
  onSettings,
}: {
  snapshot: Snapshot;
  selected: string;
  onSelect: (id: string) => void;
  onSettings: () => void;
}) {
  const { t } = useI18n();
  const f = t.federation;
  const privateView = snapshot.preferences.privacy;
  const counts = new Map<string, number>();
  for (const s of snapshot.sessions)
    counts.set(sessionRoom(s), (counts.get(sessionRoom(s)) ?? 0) + 1);
  const rooms = [
    {
      id: LOCAL_ROOM,
      name: f.localOffice,
      local: true,
      state: 'connected' as const,
      tags: [] as string[],
    },
    ...(snapshot.federation?.peers ?? []).map((p, index) => ({
      id: p.officeId,
      name: privateView ? f.hiddenOffice(index + 1) : p.label,
      local: false,
      state: p.state,
      tags: privateView ? [] : p.tags,
    })),
  ];
  return (
    <section className="office-rooms" aria-label={f.rooms}>
      <div className="office-rooms-heading">
        <span>{f.rooms}</span>
        <span className="rooms-beta">{f.beta}</span>
        <button onClick={onSettings} title={f.manage} aria-label={f.manage}>
          <Plus size={13} />
        </button>
      </div>
      <div className="office-room-list" role="tablist" aria-label={f.rooms}>
        {rooms.map((room) => (
          <button
            key={room.id}
            role="tab"
            aria-label={room.name}
            title={room.name}
            aria-selected={selected === room.id}
            className={`office-room ${selected === room.id ? 'selected' : ''}`}
            onClick={() => onSelect(room.id)}
          >
            <span className="office-room-icon">
              {room.local ? <Laptop size={17} /> : <Building2 size={17} />}
            </span>
            <span className="office-room-copy">
              <strong>{room.name}</strong>
              <small>
                <i className={`room-status ${room.state}`} />
                {room.local ? f.thisComputer : f[room.state]}
                {room.tags.length > 0 && (
                  <span className="office-room-tags"> · {room.tags.join(' · ')}</span>
                )}
              </small>
            </span>
            <span className="office-room-count">{counts.get(room.id) ?? 0}</span>
            {room.state === 'offline' && <WifiOff size={12} />}
          </button>
        ))}
      </div>
    </section>
  );
}
