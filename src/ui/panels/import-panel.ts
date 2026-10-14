// Importing instrumentals and song files: "Import" buttons, dropping files anywhere on the app (a
// .recsong opens as a new song, audio becomes the beat), and the
// banner offering the detected key/tempo.

import type { Session } from '../../app/session';
import { openProject, type AppStore } from '../../app/state';
import { scaleName } from '../../dsp/scales';
import { instrumentalOf } from '../../project/model';
import { isSongFile } from '../../project/package';
import type { Captions } from '../captions';
import { $ } from '../dom';

export function mountImportPanel(store: AppStore, session: Session, captions: Captions): void {
  const fileInput = $<HTMLInputElement>('beat-file');
  const songImport = $<HTMLButtonElement>('song-import');
  const trackImport = $<HTMLButtonElement>('track-import');
  const overlay = $('file-drop');
  const banner = $('detection');
  const bannerText = $('detection-text');
  const apply = $<HTMLButtonElement>('detection-apply');
  const songMeta = $('song-meta');

  /** Where the next picked file goes. */
  let pickTarget: 'new' | 'current' = 'new';

  const confirmReplace = (): boolean => {
    const song = openProject(store.get());
    const current = song && instrumentalOf(song);
    return !current || confirm(`Replace the instrumental “${current.name}” in “${song.name}”?`);
  };

  const importFile = (file: File, target: 'new' | 'current') => {
    if (isSongFile(file.name)) session.importProjectFile(file);
    else session.importInstrumental(file, target === 'new');
    store.set({ takesDrawerOpen: false });
  };

  songImport.addEventListener('click', () => {
    pickTarget = 'new';
    fileInput.click();
  });
  trackImport.addEventListener('click', () => {
    if (!confirmReplace()) return;
    pickTarget = 'current';
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // picking the same file again should still fire
    if (file) importFile(file, pickTarget);
  });

  // Drop audio files anywhere (takes dragged from the library are handled by the tracks panel).
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    // A song file opens as a new song. With a song open, a beat goes into it; otherwise it starts one.
    if (isSongFile(file.name)) {
      importFile(file, 'new');
    } else if (store.get().projectId) {
      if (confirmReplace()) importFile(file, 'current');
    } else {
      importFile(file, 'new');
    }
  });

  apply.addEventListener('click', () => {
    const key = store.get().detection?.key;
    session.applyDetectedKey();
    if (key) captions.show(`Only ${scaleName(key)}: every vocal now lands on these notes.`);
  });
  $('detection-dismiss').addEventListener('click', () => session.dismissDetection());

  store.watch(
    (s) => s.importing,
    (importing) => {
      songImport.disabled = trackImport.disabled = importing;
      songImport.querySelector('span')!.textContent = importing ? 'Importing…' : 'Import';
      trackImport.querySelector('span')!.textContent = importing ? 'Importing…' : 'Import beat';
    },
  );

  store.watch(
    (s) => [s.detection, s.projectId] as const,
    ([detection, projectId]) => {
      const show = !!detection && detection.projectId === projectId;
      banner.hidden = !show;
      if (!show) return;
      const parts = [detection!.key ? `Detected ${scaleName(detection!.key)}` : 'No clear key detected'];
      if (detection!.bpm) parts.push(`${detection!.bpm} BPM`);
      bannerText.textContent = parts.join(' · ');
      apply.hidden = !detection!.key;
    },
    { shallow: true },
  );

  store.watch(
    (s) => {
      const song = openProject(s);
      return song ? [song.key ? scaleName(song.key) : '', song.bpm ? `${song.bpm} BPM` : ''].filter(Boolean).join(' · ') : '';
    },
    (text) => (songMeta.textContent = text ? `· ${text}` : ''),
  );
}
