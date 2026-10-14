// Onboarding (Phase 12): the first time a studio feature comes up (a song opens, a beat arrives, the
// mixer has two tracks, the loop goes on, the key is shifted) a short caption explains it, once per
// browser. Seen tips are remembered in localStorage['recorder.tipsSeen'].

import { STUDIO_TIPS, type StudioTip } from '../../app/explain';
import { openProject, type AppStore } from '../../app/state';
import { instrumentalOf } from '../../project/model';
import type { Captions } from '../captions';

const SEEN_KEY = 'recorder.tipsSeen';

function loadSeen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function mountOnboarding(store: AppStore, captions: Captions): void {
  const seen = loadSeen();

  const tip = (id: StudioTip) => {
    if (seen.has(id)) return;
    seen.add(id);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
    } catch {
      // Storage unavailable: tips may show again next visit.
    }
    captions.enqueue(STUDIO_TIPS[id]);
  };

  store.watch(
    (s) => {
      const song = openProject(s);
      return [
        song?.id ?? null,
        !!song && !!instrumentalOf(song),
        (song?.tracks.length ?? 0) >= 2,
        !!song?.loop?.on,
        !!song && song.keyShift !== 0,
        s.mode === 'playback',
      ] as const;
    },
    ([songId, hasBeat, multi, loopOn, shifted, playback]) => {
      // Not while singing: captions would distract, and the roll is busy.
      if (!songId || !playback) return;
      tip('song');
      if (hasBeat) tip('beat');
      if (multi) tip('mixer');
      if (loopOn) tip('loop');
      if (shifted) tip('keyShift');
    },
    { shallow: true },
  );
}
