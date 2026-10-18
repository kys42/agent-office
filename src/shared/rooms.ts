import type { OfficeModel } from './office-model';
import type { Session } from './types';
import { TRIAGE_ORDER } from './triage';

export const LOCAL_ROOM = 'local';
export const sessionRoom = (s: Session) => s.remote?.officeId ?? LOCAL_ROOM;
/** A computer is a whole office. Projects and the three lifecycle spaces stay inside it. */
export function roomModel(all: OfficeModel, room: string): OfficeModel {
  const belongs = (s: Session) => sessionRoom(s) === room;
  const ids = new Set([...all.residents, ...all.hidden].filter(belongs).map((s) => s.id));
  const seats = all.seats.filter((v) => belongs(v.session));
  const desks = seats
    .filter((v) => !v.veiled)
    .flatMap((v) => [v, ...v.helpers.filter((h) => !h.veiled)]);
  const counts = Object.fromEntries(
    TRIAGE_ORDER.map((g) => [g, desks.filter((v) => v.group === g).length]),
  ) as OfficeModel['counts'];
  return {
    ...all,
    residents: all.residents.filter(belongs),
    hidden: all.hidden.filter(belongs),
    zones: {
      office: all.zones.office.filter(belongs),
      waiting: all.zones.waiting.filter(belongs),
      archive: all.zones.archive.filter(belongs),
    },
    bySeat: all.bySeat.filter(belongs),
    seats,
    scene: all.scene.filter(belongs),
    veiled: all.veiled.filter((v) => belongs(v.session)),
    veiledHelpers: all.veiledHelpers.filter((v) => belongs(v.session)),
    hiddenSessionIds: all.hiddenSessionIds.filter((id) => ids.has(id)),
    notices: all.notices.filter((n) => ids.has(n.sessionId)),
    unread: room === LOCAL_ROOM ? all.unread : 0,
    noticesPaged: room === LOCAL_ROOM && all.noticesPaged,
    counts,
    lead: desks.reduce<OfficeModel['lead']>(
      (best, v) =>
        !best || TRIAGE_ORDER.indexOf(v.group) < TRIAGE_ORDER.indexOf(best.group) ? v : best,
      undefined,
    ),
    view: (id) => {
      const v = all.view(id);
      return v && belongs(v.session) ? v : undefined;
    },
    ownerOf: (id) => {
      const s = all.ownerOf(id);
      return s && belongs(s) ? s : undefined;
    },
  };
}
